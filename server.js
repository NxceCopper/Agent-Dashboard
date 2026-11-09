const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

app.use(express.json());

// API endpoint to fetch current state
app.get('/api/state', (req, res) => {
  if (fs.existsSync(STATE_FILE)) {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    res.json(JSON.parse(data));
  } else {
    res.status(404).json({ error: 'State file not found' });
  }
});

// Simple web UI
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Agent Dashboard running at http://localhost:${PORT}`);
});
