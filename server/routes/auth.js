const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { userDb, db } = require('../db');

// Helper to hash access code
function hashAccessCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

// POST /api/register
router.post('/register', async (req, res) => {
    const { username, access_code } = req.body;

    if (!username || !access_code) {
        return res.status(400).json({ error: 'Username and access code required' });
    }

    if (access_code.length < 6) {
        return res.status(400).json({ error: 'Access code must be at least 6 characters' });
    }

    const hashed = hashAccessCode(access_code);

    try {
        const result = await userDb.execute({
            sql: 'INSERT INTO users (username, access_code) VALUES (?, ?)',
            args: [username, hashed]
        });
        res.json({ success: true, userId: result.lastInsertRowid?.toString() });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /api/login
router.post('/login', async (req, res) => {
    const { username, access_code } = req.body;

    if (!username || !access_code) {
        return res.status(400).json({ error: 'Username and access code required' });
    }

    try {
        const result = await userDb.execute({
            sql: 'SELECT * FROM users WHERE username = ?',
            args: [username]
        });

        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or access code' });
        }

        const hashed = hashAccessCode(access_code);
        if (user.access_code !== hashed) {
            return res.status(401).json({ error: 'Invalid username or access code' });
        }

        // Simple session token (username:id)
        const sessionId = `${user.username}:${user.id.toString()}`;
        const token = Buffer.from(sessionId).toString('base64');

        res.json({
            success: true,
            userId: user.id.toString(),
            username: user.username,
            token: token
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// GET /api/user/files (dashboard)
router.get('/user/files', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    let userId;
    try {
        const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        const decoded = Buffer.from(tokenPart, 'base64').toString('utf8');
        const parts = decoded.split(':');

        if (parts.length < 2) {
            console.error('Malformed token:', decoded);
            return res.status(401).json({ error: 'Invalid token format' });
        }

        userId = parseInt(parts[parts.length - 1], 10);
        if (isNaN(userId)) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const result = await db.execute({
            sql: `SELECT short_id, original_filename, size_bytes, uploaded_at, expires_at, download_count
            FROM files
            WHERE user_id = ? AND is_active = 1
            ORDER BY uploaded_at DESC`,
            args: [userId]
        });

        res.json({ files: result.rows });
    } catch (err) {
        console.error('Dashboard DB error:', err.message);
        res.status(500).json({ error: 'Failed to load files' });
    }
});

module.exports = router;
