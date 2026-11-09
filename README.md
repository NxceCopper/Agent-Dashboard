# Agent Dashboard & State Sync

A 100% local, real-time dashboard for the **living state of subagents**. A single
manager tracks every subagent it spawns — status, current task, and activity —
with no platform lock-in.

## Features
- **Shared State Management (`state.json`):** Centralized local state tracking agent statuses, active tasks, and session logs.
- **Web Dashboard:** Simple local Web UI displaying active agents, current activity, and real-time task queues.
- **Subagent Sync Integration:** Easy helper SDK (`agent-sync.js`) for any manager or subagent script to report progress and sync state seamlessly.
- **Hardened:** atomic writes, cross-process locking, corrupt-state recovery, input validation, and output escaping — covered by a test suite.

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the Agent Dashboard server:
   ```bash
   node server.js        # or: npm start
   ```
3. Open your browser at `http://localhost:3000`

Set `PORT=<number>` to use a different port.

Run the test suite:
```bash
npm test
```

## Reporting status (SDK)

```js
const sync = require('./agent-sync');

sync.getState();                                   // normalized state object
sync.updateAgentStatus('scout', 'working', 'Task'); // throws on bad id/input
sync.ensureAgent({ id: 'new-agent', name: 'New' }); // idempotent register
sync.addLogEntry('scout', 'Milestone reached');
```

From the shell:

```bash
node -e 'require("./agent-sync").updateAgentStatus("scout","working","Task")'
```

`updateAgentStatus` throws `UNKNOWN_AGENT` if the id is not registered and
`EINVAL` on bad input — failures are loud, never silent.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Current normalized state |
| `GET` | `/api/health` | Liveness probe |
| `POST` | `/api/agents` | Register an agent (`{id, name, role}`) |
| `POST` | `/api/agents/:id/status` | Update status (`{status, currentTask?}`) |

Errors map to `400` (bad input), `404` (unknown agent/route), `413` (body too
large) — never a 500 from malformed input.

```bash
curl -X POST localhost:3000/api/agents/scout/status \
  -H 'content-type: application/json' \
  -d '{"status":"working","currentTask":"Recon"}'
```

## Robustness guarantees

- **Atomic writes** — state is written to a temp file then renamed, so readers
  never observe a half-written file.
- **Cross-process lock** — concurrent agents cannot clobber each other's
  updates (verified with 50 parallel writers).
- **Self-healing** — a corrupt `state.json` is preserved as
  `state.json.corrupt-<ts>` and state is recovered from `state.json.backup`;
  a deleted file is re-materialized from the backup.
- **Normalized reads** — `agents` / `tasks` / `activityLog` are always arrays,
  regardless of what is on disk.
- **Escaped output** — the UI escapes every interpolated field and allowlists
  status CSS classes, so state data cannot inject markup.
- **Graceful UI** — the dashboard keeps the last good frame and backs off on
  reconnect if the server goes down.

## Project layout

| File | Purpose |
|---|---|
| `server.js` | Express server, static UI + JSON API |
| `agent-sync.js` | State SDK: normalized reads, locked atomic writes |
| `public/index.html` | Dashboard UI |
| `state.json` | Source of truth for agent state |
| `test.js` | Robustness suite (`npm test`) |
