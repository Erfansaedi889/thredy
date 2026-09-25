const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getSocketsForUser } = require('../sockets');

const router = express.Router();
router.use(requireAuth);

function isBlockedEitherWay(userA, userB) {
  return !!db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).get(userA, userB, userB, userA);
}

function areFriends(userA, userB) {
  return !!db.prepare(`
    SELECT 1 FROM friend_requests
    WHERE status = 'accepted'
      AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
  `).get(userA, userB, userB, userA);
}

// Send a friend request by username
router.post('/request', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'No user found with that username' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't friend yourself" });

  if (isBlockedEitherWay(req.user.id, target.id)) {
    return res.status(403).json({ error: 'Unable to send a friend request to this user' });
  }
  if (areFriends(req.user.id, target.id)) {
    return res.status(409).json({ error: 'You are already friends' });
  }

  const existing = db.prepare(`
    SELECT * FROM friend_requests
    WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
  `).get(req.user.id, target.id, target.id, req.user.id);

  if (existing && existing.status === 'pending') {
    return res.status(409).json({ error: 'A friend request is already pending between you two' });
  }

  const now = Date.now();
  if (existing) {
    // A previous request was declined — allow trying again by resetting it.
    db.prepare('UPDATE friend_requests SET from_user_id = ?, to_user_id = ?, status = ?, created_at = ? WHERE id = ?')
      .run(req.user.id, target.id, 'pending', now, existing.id);
  } else {
    db.prepare('INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, target.id, 'pending', now);
  }

  const io = req.app.get('io');
  getSocketsForUser(io, target.id).forEach((s) => s.emit('friend:request', {
    fromUsername: req.user.username, fromUserId: req.user.id,
  }));

  res.status(201).json({ message: `Friend request sent to ${target.username}` });
});

// List pending requests, split by direction
router.get('/requests', (req, res) => {
  const incoming = db.prepare(`
    SELECT fr.id, u.id as user_id, u.username, u.avatar_color, fr.created_at
    FROM friend_requests fr JOIN users u ON u.id = fr.from_user_id
    WHERE fr.to_user_id = ? AND fr.status = 'pending'
  `).all(req.user.id);

  const outgoing = db.prepare(`
    SELECT fr.id, u.id as user_id, u.username, u.avatar_color, fr.created_at
    FROM friend_requests fr JOIN users u ON u.id = fr.to_user_id
    WHERE fr.from_user_id = ? AND fr.status = 'pending'
  `).all(req.user.id);

  res.json({ incoming, outgoing });
});

router.post('/requests/:id/accept', (req, res) => {
  const request = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(Number(req.params.id));
  if (!request || request.to_user_id !== req.user.id || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found' });
  }
  db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(request.id);

  const io = req.app.get('io');
  getSocketsForUser(io, request.from_user_id).forEach((s) => s.emit('friend:accepted', { byUsername: req.user.username }));

  res.json({ message: 'Friend request accepted' });
});

router.post('/requests/:id/decline', (req, res) => {
  const request = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(Number(req.params.id));
  if (!request || request.to_user_id !== req.user.id || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found' });
  }
  db.prepare("UPDATE friend_requests SET status = 'declined' WHERE id = ?").run(request.id);
  res.json({ message: 'Friend request declined' });
});

// List current friends
router.get('/', (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM friend_requests fr
    JOIN users u ON u.id = (CASE WHEN fr.from_user_id = ? THEN fr.to_user_id ELSE fr.from_user_id END)
    WHERE fr.status = 'accepted' AND (fr.from_user_id = ? OR fr.to_user_id = ?)
  `).all(req.user.id, req.user.id, req.user.id);
  res.json(friends);
});

// Remove a friend
router.delete('/:userId', (req, res) => {
  const otherId = Number(req.params.userId);
  db.prepare(`
    DELETE FROM friend_requests
    WHERE status = 'accepted'
      AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
  `).run(req.user.id, otherId, otherId, req.user.id);
  res.json({ message: 'Friend removed' });
});

module.exports = router;
