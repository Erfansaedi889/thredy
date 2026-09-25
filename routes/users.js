const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function publicProfile(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    avatarColor: user.avatar_color,
    bio: user.bio || '',
    loomActive: !!user.loom_active,
  };
}

// Update your own profile (display name, bio, avatar color)
router.patch('/me', (req, res) => {
  const { fullName, bio, avatarColor } = req.body || {};
  const updates = [];
  const params = [];

  if (fullName !== undefined) {
    if (!fullName.trim() || fullName.length > 60) return res.status(400).json({ error: 'Name must be 1-60 characters' });
    updates.push('full_name = ?');
    params.push(fullName.trim());
  }
  if (bio !== undefined) {
    if (bio.length > 200) return res.status(400).json({ error: 'Bio must be under 200 characters' });
    updates.push('bio = ?');
    params.push(bio);
  }
  if (avatarColor !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(avatarColor)) return res.status(400).json({ error: 'avatarColor must be a hex color like #F2B84B' });
    updates.push('avatar_color = ?');
    params.push(avatarColor);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(publicProfile(user));
});

// Look up a user by exact username (used to send a friend request)
router.get('/by-username/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'No user found with that username' });
  if (user.id === req.user.id) return res.status(400).json({ error: "That's you!" });
  res.json(publicProfile(user));
});

module.exports = router;
