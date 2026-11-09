# Agent Dashboard & State Sync

A 100% local, real-time AI Agent Office & State Synchronization system designed for Opencode and OpenClaw workflows.

## Features
- **Shared State Management (`state.json`):** Centralized local state tracking agent statuses, active tasks, and session logs.
- **Web Dashboard:** Simple local Web UI displaying active agents, current activity, and real-time task queues.
- **Opencode Sync Integration:** Easy helper SDK (`agent-sync.js`) for Opencode scripts to report progress and sync states seamlessly.

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the Agent Dashboard server:
   ```bash
   node server.js
   ```
3. Open your browser at `http://localhost:3000`
