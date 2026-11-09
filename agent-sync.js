'use strict';

/**
 * agent-sync.js — crash-safe, concurrency-safe state sync helper.
 *
 * Guarantees:
 *  - Never throws on a missing / corrupt / wrongly-typed state.json
 *  - Writes are atomic (temp file + rename), so readers never observe a
 *    half-written file
 *  - Read-modify-write cycles are serialized with a lock file, so
 *    concurrent agents cannot clobber each other's updates
 *  - Corrupt input is preserved as state.json.corrupt-<ts> instead of
 *    being silently destroyed
 *  - Unknown agent ids and invalid statuses fail loudly instead of
 *    writing misleading log entries
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const BACKUP_FILE = `${STATE_FILE}.backup`;

const MAX_LOG_ENTRIES = 50;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 5;

/** Statuses the dashboard UI knows how to colour. Others are still accepted. */
const VALID_STATUSES = ['working', 'idle', 'ready', 'blocked', 'error', 'done'];

/* ------------------------------------------------------------------ *
 * Time                                                               *
 * ------------------------------------------------------------------ */

/** Blocking sleep that does not burn CPU (falls back to a spin loop). */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Normalisation — every read returns a fully-shaped state object      *
 * ------------------------------------------------------------------ */

function defaultState() {
  return {
    system: 'Real-Time AI Agent Office',
    updatedAt: now(),
    agents: [],
    tasks: [],
    activityLog: [],
  };
}

function normalizeAgent(raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...a,
    id: typeof a.id === 'string' ? a.id : '',
    name: typeof a.name === 'string' ? a.name : (typeof a.id === 'string' ? a.id : 'unnamed'),
    role: typeof a.role === 'string' ? a.role : '',
    status: typeof a.status === 'string' && a.status ? a.status : 'idle',
    currentTask: typeof a.currentTask === 'string' ? a.currentTask : '',
    lastActive: typeof a.lastActive === 'string' ? a.lastActive : now(),
  };
}

function normalizeLogEntry(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ...e,
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : now(),
    agentId: typeof e.agentId === 'string' ? e.agentId : 'unknown',
    message: typeof e.message === 'string' ? e.message : '',
  };
}

/**
 * Coerce arbitrary JSON into a valid state. Never throws, never drops
 * unknown top-level keys.
 */
function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const state = { ...base, ...raw };

  state.system = typeof state.system === 'string' && state.system ? state.system : base.system;
  state.updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : base.updatedAt;
  state.agents = Array.isArray(state.agents) ? state.agents.map(normalizeAgent) : [];
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.activityLog = Array.isArray(state.activityLog)
    ? state.activityLog.map(normalizeLogEntry).slice(0, MAX_LOG_ENTRIES)
    : [];

  return state;
}

/* ------------------------------------------------------------------ *
 * Input validation                                                    *
 * ------------------------------------------------------------------ */

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeStatus(status) {
  const s = requireNonEmptyString(status, 'status').toLowerCase();
  if (!VALID_STATUSES.includes(s)) {
    // Accept but flag: hard-failing would break legitimate custom workflows.
    console.warn(`[Sync] Non-standard status "${s}" (known: ${VALID_STATUSES.join(', ')})`);
  }
  return s;
}

function validationError(message) {
  const err = new Error(message);
  err.code = 'EINVAL';
  return err;
}

function unknownAgentError(id, known) {
  const err = new Error(
    `Unknown agentId "${id}". Known agents: ${known.length ? known.join(', ') : '(none)'}`
  );
  err.code = 'UNKNOWN_AGENT';
  return err;
}

/* ------------------------------------------------------------------ *
 * Locking — serializes read-modify-write across processes             *
 * ------------------------------------------------------------------ */

/** Re-entrancy depth for this process, so nested calls don't self-deadlock. */
let lockDepth = 0;

function tryCreateLock() {
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx'); // fails with EEXIST if held
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (err.code === 'ENOENT') {
      // Parent dir missing — nothing to lock against yet.
      return true;
    }
    throw err;
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() })
    );
  } catch (_) {
    /* lock is ours regardless; metadata is best-effort */
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
  }
  return true;
}

function lockIsStale() {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
  } catch (_) {
    return false; // vanished — treat as free
  }
}

function breakStaleLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    /* someone else got there first */
  }
}

function acquireLock() {
  if (lockDepth > 0) {
    lockDepth += 1;
    return;
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    if (tryCreateLock()) {
      lockDepth = 1;
      return;
    }
    if (lockIsStale()) {
      breakStaleLock();
      continue;
    }
    if (Date.now() >= deadline) {
      throw validationError(
        `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for state lock (${LOCK_FILE}). ` +
          'Another process may be holding it.'
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
}

function releaseLock() {
  if (lockDepth === 0) return;
  lockDepth -= 1;
  if (lockDepth > 0) return;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    /* already released or broken */
  }
}

/** Run `fn` while holding the state lock. Lock is always released. */
function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Reading                                                             *
 * ------------------------------------------------------------------ */

function readFileOrThrow(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Move a corrupt primary aside so the data is never destroyed. */
function preserveCorruptState() {
  const dest = `${STATE_FILE}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(STATE_FILE, dest);
    console.error(`[Sync] Corrupt state preserved at ${path.basename(dest)}`);
    return dest;
  } catch (_) {
    return null;
  }
}

/**
 * Read state without acquiring the lock (caller must hold it).
 * Falls back to the backup, then to a clean default. Never throws.
 */
function readStateUnlocked() {
  const primaryExists = fs.existsSync(STATE_FILE);

  if (primaryExists) {
    try {
      return { state: normalizeState(readFileOrThrow(STATE_FILE)), source: 'file' };
    } catch (err) {
      console.error(`[Sync] Failed to read ${path.basename(STATE_FILE)}: ${err.message}`);
      // Unreadable primary: move it aside so nothing is destroyed.
      preserveCorruptState();
    }
  }

  // Primary missing or corrupt — self-heal from the backup if we have one.
  if (fs.existsSync(BACKUP_FILE)) {
    try {
      const state = normalizeState(readFileOrThrow(BACKUP_FILE));
      console.error(
        `[Sync] Recovered state from backup (${primaryExists ? 'corrupt primary' : 'missing primary'})`
      );
      if (!primaryExists) {
        // Re-materialize the primary so the next read is clean.
        try {
          atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
        } catch (err) {
          console.error(`[Sync] Could not rewrite primary: ${err.message}`);
        }
      }
      return { state, source: 'backup' };
    } catch (err) {
      console.error(`[Sync] Backup also unreadable: ${err.message}`);
    }
  }

  return { state: normalizeState(null), source: 'default' };
}

/* ------------------------------------------------------------------ *
 * Writing — atomic temp-file + rename                                 *
 * ------------------------------------------------------------------ */

function atomicWrite(target, contents) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, target); // atomic replace on the same filesystem
}

/**
 * Write state without acquiring the lock (caller must hold it).
 * Refreshes the backup so a corrupt primary is always recoverable.
 */
function writeStateUnlocked(state) {
  state.updatedAt = now();
  const json = `${JSON.stringify(state, null, 2)}\n`;

  atomicWrite(STATE_FILE, json);

  try {
    atomicWrite(BACKUP_FILE, json);
  } catch (err) {
    // A failed backup must never fail the primary write.
    console.error(`[Sync] Backup refresh failed: ${err.message}`);
  }

  return state;
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/** Current state. Normalized, so `agents` / `activityLog` are always arrays. */
function getState() {
  return withLock(() => readStateUnlocked().state);
}

/**
 * Append an activity-log entry. Validates its inputs and caps the log.
 * @returns {object} the entry that was written
 */
function addLogEntry(agentId, message) {
  const id = requireNonEmptyString(agentId, 'agentId');
  const msg = requireNonEmptyString(message, 'message');

  return withLock(() => {
    const { state } = readStateUnlocked();
    const entry = normalizeLogEntry({ timestamp: now(), agentId: id, message: msg });
    state.activityLog.unshift(entry);
    state.activityLog = state.activityLog.slice(0, MAX_LOG_ENTRIES);
    writeStateUnlocked(state);
    return entry;
  });
}

/**
 * Register an agent if it does not already exist. Idempotent.
 * @returns {{agent: object, created: boolean}}
 */
function ensureAgent({ id, name, role, status = 'idle', currentTask = '' }) {
  const agentId = requireNonEmptyString(id, 'id');

  return withLock(() => {
    const { state } = readStateUnlocked();
    let agent = state.agents.find((a) => a.id === agentId);
    let created = false;

    if (!agent) {
      agent = normalizeAgent({
        id: agentId,
        name: name || agentId,
        role: role || '',
        status,
        currentTask,
        lastActive: now(),
      });
      state.agents.push(agent);
      created = true;
      state.activityLog.unshift(
        normalizeLogEntry({
          timestamp: now(),
          agentId,
          message: `Agent registered: ${agent.name}`,
        })
      );
      state.activityLog = state.activityLog.slice(0, MAX_LOG_ENTRIES);
      writeStateUnlocked(state);
    }

    return { agent: { ...agent }, created };
  });
}

/**
 * Update an agent's status (and optionally its current task).
 *
 * @param {string} agentId  must already exist — see ensureAgent()
 * @param {string} status   e.g. 'working' | 'idle' | 'ready'
 * @param {string} [currentTask] leave undefined to keep the existing task
 * @returns {object} a copy of the updated agent
 * @throws {Error} code 'EINVAL' on bad input, 'UNKNOWN_AGENT' on bad id
 */
function updateAgentStatus(agentId, status, currentTask) {
  const id = requireNonEmptyString(agentId, 'agentId');
  const newStatus = normalizeStatus(status);
  const task =
    currentTask === undefined || currentTask === null ? null : String(currentTask);

  return withLock(() => {
    const { state } = readStateUnlocked();
    const agent = state.agents.find((a) => a.id === id);

    if (!agent) throw unknownAgentError(id, state.agents.map((a) => a.id));

    const previousTask = agent.currentTask;

    agent.status = newStatus;
    if (task !== null) agent.currentTask = task;
    agent.lastActive = now();

    state.activityLog.unshift(
      normalizeLogEntry({
        timestamp: now(),
        agentId: id,
        message: `Status changed to ${newStatus}: ${task ?? previousTask ?? ''}`,
      })
    );
    state.activityLog = state.activityLog.slice(0, MAX_LOG_ENTRIES);

    writeStateUnlocked(state);
    return { ...agent };
  });
}

module.exports = {
  getState,
  updateAgentStatus,
  ensureAgent,
  addLogEntry,
  VALID_STATUSES,
  STATE_FILE,
};
