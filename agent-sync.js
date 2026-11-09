const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

function getState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function updateAgentStatus(agentId, status, currentTask) {
  const state = getState();
  const agent = state.agents.find(a => a.id === agentId);
  if (agent) {
    agent.status = status;
    if (currentTask !== undefined) agent.currentTask = currentTask;
    agent.lastActive = new Date().toISOString();
  }
  state.updatedAt = new Date().toISOString();
  state.activityLog.unshift({
    timestamp: new Date().toISOString(),
    agentId,
    message: `Status changed to ${status}: ${currentTask || ''}`
  });
  // Keep log at max 50 items
  state.activityLog = state.activityLog.slice(0, 50);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[Sync] Updated ${agentId} -> ${status}`);
}

module.exports = { getState, updateAgentStatus };
