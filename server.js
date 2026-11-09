'use strict';

const express = require('express');
const path = require('path');
const sync = require('./agent-sync');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '32kb' }));

/* ------------------------------------------------------------------ *
 * API                                                                 *
 * ------------------------------------------------------------------ */

// Current state. agent-sync normalizes, so `agents` / `activityLog` are
// always arrays and a corrupt file can never take the route down.
app.get('/api/state', (req, res) => {
  try {
    res.json(sync.getState());
  } catch (err) {
    console.error('[API] /api/state failed:', err);
    res.status(500).json({ error: 'Failed to read state', detail: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid });
});

// Write path for remote/distributed agents. Input is validated by
// agent-sync; errors map to 400/404 rather than 500.
app.post('/api/agents/:id/status', (req, res) => {
  try {
    const { status, currentTask } = req.body || {};
    const agent = sync.updateAgentStatus(req.params.id, status, currentTask);
    res.json({ ok: true, agent });
  } catch (err) {
    const code =
      err.code === 'UNKNOWN_AGENT' ? 404 : err.code === 'EINVAL' ? 400 : 500;
    if (code === 500) console.error('[API] status update failed:', err);
    res.status(code).json({ ok: false, error: err.message });
  }
});

// Register (or fetch) an agent.
app.post('/api/agents', (req, res) => {
  try {
    const { agent, created } = sync.ensureAgent(req.body || {});
    res.status(created ? 201 : 200).json({ ok: true, created, agent });
  } catch (err) {
    const code = err.code === 'EINVAL' ? 400 : 500;
    if (code === 500) console.error('[API] agent registration failed:', err);
    res.status(code).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Static UI                                                           *
 * ------------------------------------------------------------------ */

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '0' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ------------------------------------------------------------------ *
 * Errors                                                              *
 * ------------------------------------------------------------------ */

// Unknown route -> JSON, so API clients never receive an HTML 404.
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Request body too large' });
  }
  console.error('[API] Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

/* ------------------------------------------------------------------ *
 * Start                                                               *
 * ------------------------------------------------------------------ */

const server = app.listen(PORT, () => {
  // Fail loudly at boot if state is unreadable, rather than 500ing later.
  try {
    const state = sync.getState();
    console.log(
      `Agent Dashboard running at http://localhost:${PORT} ` +
        `(${state.agents.length} agents, ${state.activityLog.length} log entries)`
    );
  } catch (err) {
    console.error(`Agent Dashboard running at http://localhost:${PORT}, but state init failed:`, err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<other> and retry.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Keep the dashboard alive through unexpected errors, but log loudly.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
