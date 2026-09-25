const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT id, username, email, full_name, is_admin, loom_active, boosts_available, email_verified, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

router.post('/users/:id/loom', (req, res) => {
  const userId = Number(req.params.id);
  const { active } = req.body || {};
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET loom_active = ? WHERE id = ?').run(active ? 1 : 0, userId);

  // Granting Loom comes with 3 free boosts, same as a real purchase would.
  if (active) {
    db.prepare('UPDATE users SET boosts_available = boosts_available + 3 WHERE id = ?').run(userId);
  }

  const updated = db.prepare('SELECT id, username, loom_active, boosts_available FROM users WHERE id = ?').get(userId);
  res.json(updated);
});

router.post('/users/:id/boosts', (req, res) => {
  const userId = Number(req.params.id);
  const { amount } = req.body || {};
  if (typeof amount !== 'number') return res.status(400).json({ error: 'amount must be a number' });

  const user = db.prepare('SELECT boosts_available FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newAmount = Math.max(0, user.boosts_available + amount);
  db.prepare('UPDATE users SET boosts_available = ? WHERE id = ?').run(newAmount, userId);

  res.json({ id: userId, boosts_available: newAmount });
});

module.exports = router;
