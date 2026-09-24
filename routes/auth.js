const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const AVATAR_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#7289DA', '#43B581', '#F04747'];

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 3 || username.length > 24 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-24 chars, letters/numbers/underscore only' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const now = Date.now();

  const result = db.prepare(
    'INSERT INTO users (username, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, passwordHash, avatarColor, now);

  const user = { id: result.lastInsertRowid, username };
  const token = signToken(user);

  res.json({ token, user: { id: user.id, username, avatarColor } });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, avatarColor: user.avatar_color } });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, avatarColor: user.avatar_color });
});

module.exports = router;
