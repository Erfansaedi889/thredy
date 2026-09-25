const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'No user found with that username' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't block yourself" });

  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, target.id, Date.now());

  // Blocking ends any friendship between the two.
  db.prepare(`
    DELETE FROM friend_requests
    WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
  `).run(req.user.id, target.id, target.id, req.user.id);

  res.json({ message: `${username} has been blocked` });
});

router.delete('/:username', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'No user found with that username' });

  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, target.id);
  res.json({ message: `${req.params.username} has been unblocked` });
});

router.get('/', (req, res) => {
  const blocked = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM blocks b JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ?
  `).all(req.user.id);
  res.json(blocked);
});

module.exports = router;
