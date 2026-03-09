require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API routes
const filesRouter = require('./routes/files');
app.use('/api', filesRouter);

// Viewer route — open doc in browser editor
app.get('/r/:shortId', (req, res) => {
  const file = db.prepare('SELECT short_id, original_filename, mime_type, size_bytes, expires_at, is_active FROM files WHERE short_id = ?').get(req.params.shortId);

  if (!file || !file.is_active) {
    return res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
  }

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).sendFile(path.join(__dirname, '../public/expired.html'));
  }

  res.sendFile(path.join(__dirname, '../public/viewer.html'));
});

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`FileShare running at http://localhost:${PORT}`);
});
