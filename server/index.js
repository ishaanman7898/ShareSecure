require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { db } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// api routes
const filesRouter = require('./routes/files');
const authRouter = require('./routes/auth');
app.use('/api', filesRouter);
app.use('/api/auth', authRouter);

// viewer route
app.get('/r/:shortId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT short_id, original_filename, mime_type, size_bytes, expires_at, is_active FROM files WHERE short_id = ?',
      args: [req.params.shortId]
    });
    const file = result.rows[0];

    if (!file || !file.is_active) {
      return res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
    }

    if (file.expires_at && new Date(file.expires_at) < new Date()) {
      return res.status(410).sendFile(path.join(__dirname, '../public/expired.html'));
    }

    res.sendFile(path.join(__dirname, '../public/viewer.html'));
  } catch (err) {
    res.status(500).send('Internal Server Error');
  }
});

// home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// periodic cleanup of expired files
setInterval(async () => {
  console.log('Running expired files cleanup...');
  try {
    const result = await db.execute({
      sql: "SELECT * FROM files WHERE expires_at < datetime('now') AND is_active = 1",
      args: []
    });

    for (const file of result.rows) {
      await db.execute({
        sql: 'UPDATE files SET is_active = 0 WHERE id = ?',
        args: [file.id]
      });
      const filePath = path.join(__dirname, '../uploads', file.stored_filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted expired file: ${file.original_filename}`);
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 60 * 60 * 1000); // hourly

app.listen(PORT, () => {
  console.log(`FileShare running at http://localhost:${PORT}`);
});
