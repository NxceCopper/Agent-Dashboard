'use strict';

/**
 * Robustness test suite — attacks the failure modes found in recon.
 *
 * Run:  node test.js
 *
 * Each test prints PASS/FAIL; the process exits non-zero if anything fails.
 * Tests restore state.json to its original contents on exit.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const DIR = __dirname;
const STATE = path.join(DIR, 'state.json');
const BACKUP = `${STATE}.backup`;
const LOCK = `${STATE}.lock`;

// MUST be captured here, before any test() executes. test() runs its body
// synchronously during module load, so a snapshot taken later in this file
// would capture already-mutated state and teardown would "restore" garbage.
const originalState = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : null;

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function freshSync() {
  // Drop the require cache so each test sees current disk contents.
  delete require.cache[require.resolve('./agent-sync.js')];
  return require('./agent-sync.js');
}

function writeState(obj) {
  fs.writeFileSync(STATE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}

function cleanupArtifacts() {
  for (const f of fs.readdirSync(DIR)) {
    if (f.startsWith('state.json.corrupt-') || f.startsWith('state.json.tmp.')) {
      fs.unlinkSync(path.join(DIR, f));
    }
  }
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
}

/* ------------------------------------------------------------------ *
 * 1. Normalisation — malformed state must never crash                 *
 * ------------------------------------------------------------------ */

console.log('\n1. Normalisation & crash-safety');

test('missing file returns default with array fields', () => {
  fs.rmSync(STATE, { force: true });
  const s = freshSync().getState();
  assert(Array.isArray(s.agents), 'agents not an array');
  assert(Array.isArray(s.activityLog), 'activityLog not an array');
  assert(Array.isArray(s.tasks), 'tasks not an array');
});

test('corrupt (truncated JSON) file does not throw', () => {
  writeState('{"agents": [{"id": "a",');
  const s = freshSync().getState();
  assert(Array.isArray(s.agents), 'agents not an array');
});

test('corrupt file is preserved, not destroyed', () => {
  // Clear corpses from earlier tests so we assert on THIS corruption.
  for (const f of fs.readdirSync(DIR)) {
    if (f.startsWith('state.json.corrupt-')) fs.unlinkSync(path.join(DIR, f));
  }

  const marker = '{"broken": true, "lost": "data"';
  writeState(marker);
  freshSync().getState();

  const corpses = fs.readdirSync(DIR).filter((f) => f.startsWith('state.json.corrupt-'));
  assert(corpses.length > 0, 'no corrupt copy preserved');

  const kept = corpses.map((c) => fs.readFileSync(path.join(DIR, c), 'utf8'));
  assert(kept.includes(marker), 'corrupt content was altered or discarded');
});

test('backup recovers data when primary is corrupt', () => {
  const good = {
    system: 'x',
    agents: [{ id: 'alpha', name: 'Alpha', status: 'idle' }],
    activityLog: [{ agentId: 'alpha', message: 'survive me' }],
  };
  fs.writeFileSync(BACKUP, JSON.stringify(good));
  writeState('!!!not json!!!');
  const s = freshSync().getState();
  assert(s.agents.length === 1 && s.agents[0].id === 'alpha', 'backup not used');
  assert(s.activityLog[0].message === 'survive me', 'backup log lost');
});

test('backup recovers when primary is deleted outright', () => {
  fs.rmSync(STATE, { force: true });
  const s = freshSync().getState();
  assert(s.agents.length === 1 && s.agents[0].id === 'alpha', 'backup not used on delete');
  assert(fs.existsSync(STATE), 'primary not re-materialized');
});

test('JSON that is valid but wrongly typed still normalizes', () => {
  writeState(JSON.stringify({ agents: 'not-an-array', activityLog: 42, updatedAt: 99 }));
  const s = freshSync().getState();
  assert(Array.isArray(s.agents) && s.agents.length === 0, 'bad agents not coerced');
  assert(Array.isArray(s.activityLog) && s.activityLog.length === 0, 'bad log not coerced');
  assert(typeof s.updatedAt === 'string', 'bad updatedAt not coerced');
});

test('agent objects missing fields are filled in', () => {
  writeState(JSON.stringify({ agents: [{ id: 'beta' }] }));
  const s = freshSync().getState();
  const a = s.agents[0];
  assert(a.name && a.status && typeof a.currentTask === 'string', 'fields not filled');
  assert(typeof a.lastActive === 'string', 'lastActive not filled');
});

test('unknown top-level keys are preserved', () => {
  writeState(JSON.stringify({ customFlag: 123, agents: [], activityLog: [] }));
  const s = freshSync().getState();
  assert(s.customFlag === 123, 'unknown key dropped');
});

/* ------------------------------------------------------------------ *
 * 2. Validation — bad input must fail loudly                          *
 * ------------------------------------------------------------------ */

console.log('\n2. Input validation');

function seed() {
  writeState({
    system: 'test',
    agents: [{ id: 'alpha', name: 'Alpha', status: 'idle', currentTask: 'seed', lastActive: '2026-01-01T00:00:00.000Z' }],
    tasks: [],
    activityLog: [],
  });
}

test('unknown agentId throws UNKNOWN_AGENT', () => {
  seed();
  let caught = null;
  try {
    freshSync().updateAgentStatus('nope', 'working', 'x');
  } catch (e) {
    caught = e;
  }
  assert(caught, 'no error thrown for unknown agent');
  assert(caught.code === 'UNKNOWN_AGENT', `wrong code: ${caught && caught.code}`);
});

test('unknown agentId writes NO misleading log entry', () => {
  seed();
  try {
    freshSync().updateAgentStatus('nope', 'working', 'x');
  } catch (_) {
    /* expected */
  }
  const s = readState();
  assert(s.activityLog.length === 0, 'log entry written for a non-existent agent');
});

test('empty agentId throws EINVAL', () => {
  seed();
  let code = null;
  try {
    freshSync().updateAgentStatus('   ', 'working');
  } catch (e) {
    code = e.code;
  }
  assert(code === 'EINVAL', `expected EINVAL, got ${code}`);
});

test('non-string status throws EINVAL', () => {
  seed();
  let code = null;
  try {
    freshSync().updateAgentStatus('alpha', 42);
  } catch (e) {
    code = e.code;
  }
  assert(code === 'EINVAL', `expected EINVAL, got ${code}`);
});

test('status is normalized to lowercase', () => {
  seed();
  const a = freshSync().updateAgentStatus('alpha', 'WORKING', 't');
  assert(a.status === 'working', `got ${a.status}`);
});

test('omitting currentTask preserves the existing one', () => {
  seed();
  const a = freshSync().updateAgentStatus('alpha', 'idle');
  assert(a.currentTask === 'seed', `task clobbered: ${a.currentTask}`);
});

test('ensureAgent is idempotent', () => {
  seed();
  const sync = freshSync();
  const first = sync.ensureAgent({ id: 'alpha', name: 'Alpha2' });
  assert(first.created === false, 'reported created for existing agent');
  const second = sync.ensureAgent({ id: 'gamma', name: 'Gamma', role: 'R' });
  assert(second.created === true, 'reported not-created for new agent');
  assert(second.agent.name === 'Gamma', 'name not set');
  const third = freshSync().ensureAgent({ id: 'gamma' });
  assert(third.created === false, 'ensureAgent not idempotent');
});

test('ensureAgent rejects missing id', () => {
  let code = null;
  try {
    freshSync().ensureAgent({ name: 'NoId' });
  } catch (e) {
    code = e.code;
  }
  assert(code === 'EINVAL', `expected EINVAL, got ${code}`);
});

/* ------------------------------------------------------------------ *
 * 3. Concurrency — lost-update race                                   *
 * ------------------------------------------------------------------ */

console.log('\n3. Concurrency (the lost-update race)');

test('50 parallel writes keep state valid and complete', () => {
  seed();

  const WORKERS = 50;
  const child =
    'const s = require(' +
    JSON.stringify(path.join(DIR, 'agent-sync.js')) +
    '); s.updateAgentStatus("alpha", "working", process.argv[1]);';

  const results = [];
  const batch = 10;
  for (let start = 0; start < WORKERS; start += batch) {
    const procs = [];
    for (let i = start; i < Math.min(start + batch, WORKERS); i++) {
      procs.push(
        spawnSync(process.execPath, ['-e', child, `worker ${i}`], {
          cwd: DIR,
          encoding: 'utf8',
          timeout: 20000,
        })
      );
    }
    results.push(...procs);
  }

  const bad = results.filter((r) => r.status !== 0);
  assert(bad.length === 0, `${bad.length}/${WORKERS} writers failed: ${(bad[0] || {}).stderr}`);

  const s = readState(); // must still be valid JSON
  assert(Array.isArray(s.activityLog), 'log destroyed by concurrent writes');

  // Every worker logged its own entry (50 entries, log cap is 50).
  const mine = s.activityLog.filter((l) => /worker \d+$/.test(l.message));
  assert(
    mine.length === WORKERS,
    `lost updates: expected ${WORKERS} log entries, got ${mine.length}`
  );

  const seen = new Set(mine.map((l) => l.message.split('worker ')[1]));
  assert(seen.size === WORKERS, `duplicate/lost workers: ${seen.size}/${WORKERS}`);
});

test('no lock file or temp files left behind', () => {
  assert(!fs.existsSync(LOCK), 'lock file leaked');
  const tmps = fs.readdirSync(DIR).filter((f) => f.startsWith('state.json.tmp.'));
  assert(tmps.length === 0, `temp files leaked: ${tmps.join(', ')}`);
});

test('reader never observes a torn file during writes', () => {
  seed();
  const child =
    'const s = require(' +
    JSON.stringify(path.join(DIR, 'agent-sync.js')) +
    '); for (let i=0;i<40;i++) s.updateAgentStatus("alpha","working","bulk "+i);';

  const writer = spawn(process.execPath, ['-e', child], { cwd: DIR });
  let torn = 0;
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline && writer.exitCode === null) {
    try {
      JSON.parse(fs.readFileSync(STATE, 'utf8'));
    } catch (_) {
      torn += 1;
    }
  }

  writer.kill();
  assert(torn === 0, `observed ${torn} torn/partial reads`);
});

/* ------------------------------------------------------------------ *
 * 4. API behaviour                                                    *
 * ------------------------------------------------------------------ */

console.log('\n4. Server & API');

const PORT = 3999;
let serverProc = null;
let baseURL = `http://127.0.0.1:${PORT}`;

function http(method, urlPath, body) {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `const b=process.argv[1];fetch(process.argv[2],{method:process.argv[3],headers:b?{'content-type':'application/json'}:{},body:b||undefined}).then(r=>r.text().then(t=>console.log(JSON.stringify({status:r.status,body:t}))))`,
      body === undefined ? '' : JSON.stringify(body),
      baseURL + urlPath,
      method,
    ],
    { encoding: 'utf8', timeout: 15000 }
  );
  const line = (res.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch (_) {
    return { status: 0, body: res.stderr || 'no response' };
  }
}

test('server starts and listens', () => {
  seed();
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  serverProc.stdout.on('data', (d) => (boot += d));
  serverProc.stderr.on('data', (d) => (boot += d));

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (http('GET', '/api/health').status === 200) return;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']);
  }
  throw new Error(`server did not come up: ${boot}`);
});

test('GET / returns 200 and HTML', () => {
  const r = http('GET', '/');
  assert(r.status === 200, `status ${r.status}`);
  assert(/<!DOCTYPE html>/i.test(r.body), 'not HTML');
});

test('GET /api/state returns 200 with agents array', () => {
  const r = http('GET', '/api/state');
  assert(r.status === 200, `status ${r.status}`);
  const data = JSON.parse(r.body);
  assert(Array.isArray(data.agents), 'agents not an array');
});

test('GET /api/health returns 200', () => {
  assert(http('GET', '/api/health').status === 200, 'health not 200');
});

test('POST valid status returns 200', () => {
  const r = http('POST', '/api/agents/alpha/status', { status: 'working', currentTask: 'api test' });
  assert(r.status === 200, `status ${r.status}: ${r.body}`);
  assert(JSON.parse(r.body).agent.status === 'working', 'status not applied');
});

test('POST unknown agent returns 404 (not 500)', () => {
  const r = http('POST', '/api/agents/ghost/status', { status: 'working' });
  assert(r.status === 404, `expected 404, got ${r.status}`);
});

test('POST missing status returns 400 (not 500)', () => {
  const r = http('POST', '/api/agents/alpha/status', { currentTask: 'x' });
  assert(r.status === 400, `expected 400, got ${r.status}`);
});

test('POST malformed JSON body returns 400, not a crash', () => {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'},body:'{bad json'}).then(r=>console.log(r.status))`,
      baseURL + '/api/agents/alpha/status',
    ],
    { encoding: 'utf8', timeout: 15000 }
  );
  const status = parseInt((res.stdout || '').trim().split('\n').pop(), 10);
  assert(status === 400, `expected 400, got ${status}`);
});

test('POST register new agent returns 201, re-register returns 200', () => {
  const first = http('POST', '/api/agents', { id: 'delta', name: 'Delta', role: 'API' });
  assert(first.status === 201, `expected 201, got ${first.status}`);
  const again = http('POST', '/api/agents', { id: 'delta', name: 'Delta' });
  assert(again.status === 200, `expected 200, got ${again.status}`);
  assert(JSON.parse(again.body).created === false, 'not idempotent over API');
});

test('unknown route returns JSON 404, not HTML', () => {
  const r = http('GET', '/api/nope');
  assert(r.status === 404, `status ${r.status}`);
  assert(JSON.parse(r.body).error, 'not JSON');
});

test('server survives corrupt state.json and keeps serving', () => {
  fs.writeFileSync(STATE, '{{{ definitely not json');
  const r = http('GET', '/api/state');
  assert(r.status === 200, `server broke: status ${r.status}`);
  const data = JSON.parse(r.body);
  assert(Array.isArray(data.agents), 'agents not an array after corruption');
  // repair for later tests
  seed();
});

test('server still alive after all abuse', () => {
  assert(serverProc.exitCode === null, `server exited with ${serverProc.exitCode}`);
  assert(http('GET', '/api/health').status === 200, 'health check failed');
});

/* ------------------------------------------------------------------ *
 * 5. UI hardening                                                     *
 * ------------------------------------------------------------------ */

console.log('\n5. UI hardening');

test('index.html escapes HTML in every interpolated field', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  // Matched as a prefix so forms like esc(a.name || a.id) also count —
  // the expression is evaluated first, then escaped as a whole.
  const fields = [
    'esc(a.name',
    'esc(a.role)',
    'esc(a.currentTask)',
    'esc(a.status)',
    'esc(l.message)',
    'esc(l.agentId)',
    'esc(fmtTime(l.timestamp))',
    'esc(fmtDate(a.lastActive))',
  ];
  for (const field of fields) {
    assert(html.includes(field), `missing esc() for ${field}`);
  }
  assert(html.includes('function esc('), 'esc helper missing');
});

test('status class is allowlisted (no CSS class injection)', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  assert(html.includes('statusClass('), 'statusClass helper missing');
  assert(
    /KNOWN_STATUSES\.includes/.test(html),
    'status not checked against an allowlist'
  );
});

test('render handles missing/undefined arrays without throwing', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  assert(html.includes('function shape('), 'shape() normalizer missing');
  assert(
    /Array\.isArray\(d\.agents\)/.test(html) && /Array\.isArray\(d\.activityLog\)/.test(html),
    'arrays not guarded with Array.isArray'
  );
});

test('fetch failure keeps last frame and does not throw unhandled', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  assert(html.includes('catch'), 'no catch around fetch');
  assert(html.includes('lastGood'), 'does not retain last good payload');
  assert(/setTimeout/.test(html), 'no retry scheduling');
});

test('payload values are length-capped in esc()', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  assert(/slice\(0,\s*MAX_INLINE\)/.test(html), 'no length cap in esc()');
});

test('esc() neutralizes injection payloads', () => {
  const html = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8');
  const src = html.match(/function esc\([\s\S]*?\n    \}/);
  assert(src, 'could not extract esc() from page');
  const MAX_INLINE = 1000;
  const esc = eval(`(${src[0]})`); // the page's own implementation

  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(2)</script>',
    '<svg onload=alert(3)>',
    '" onmouseover="alert(4)',
    "' onfocus='alert(5)",
    'a & b < c > d',
    '</h3><img src=x onerror=alert(6)>',
  ];

  for (const p of payloads) {
    const out = esc(p);
    // The invariant: no angle bracket survives, so no element can be formed.
    // Attribute payloads are inert without a tag to live inside.
    assert(!/[<>]/.test(out), `payload not neutralized: ${p} -> ${out}`);
  }

  assert(esc('x'.repeat(5000)).length <= 1000, 'length cap not enforced');
});

/* ------------------------------------------------------------------ *
 * 6. Repo hygiene                                                     *
 * ------------------------------------------------------------------ */

console.log('\n6. Repo hygiene');

test('.gitignore covers node_modules and state artifacts', () => {
  const gi = fs.readFileSync(path.join(DIR, '.gitignore'), 'utf8');
  assert(/node_modules/.test(gi), 'node_modules not ignored');
});

test('node_modules is not tracked by git', () => {
  const out = execFileSync('git', ['ls-files', 'node_modules'], { cwd: DIR, encoding: 'utf8' });
  assert(out.trim() === '', 'node_modules is tracked');
});

test('no secrets in tracked files', () => {
  // Assembled from fragments so the literal token prefixes never appear
  // contiguously in this file. Otherwise the scanner would match its own
  // source the moment test.js itself is committed.
  const pattern = ['ghp', 'github_pat'].map((s) => s + '_').join('|');

  // git grep exits 1 when there are ZERO matches, which execFileSync
  // reports as a throw. Treat that as "clean".
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-I', '-E', pattern, 'HEAD'], {
      cwd: DIR,
      encoding: 'utf8',
    });
  } catch (err) {
    if (err.status === 1) out = ''; // no matches -> clean
    else throw err;
  }
  out = out.trim();
  assert(out === '', `secret found: ${out}`);
});

test('all JS files pass node --check', () => {
  for (const f of ['server.js', 'agent-sync.js', 'test.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(DIR, f)], {
      encoding: 'utf8',
    });
    assert(r.status === 0, `${f} failed: ${r.stderr}`);
  }
});

/* ------------------------------------------------------------------ *
 * Teardown                                                            *
 * ------------------------------------------------------------------ */

function teardown() {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill('SIGTERM');
  }
  try {
    if (originalState !== null) fs.writeFileSync(STATE, originalState);
  } catch (_) {
    /* ignore */
  }
  cleanupArtifacts();
  fs.rmSync(BACKUP, { force: true });
}

process.on('exit', teardown);
process.on('SIGINT', () => process.exit(130));

// NOTE: originalState is captured at the top of this file, before any
// test() body runs. It used to be captured here — after every test had
// already mutated state.json — which made teardown "restore" test seed
// data and destroy the real state.

setTimeout(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  process.exit(fail === 0 ? 0 : 1);
}, 100);
