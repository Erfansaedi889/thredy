const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function channelServerId(channelId) {
  const row = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(channelId);
  return row ? row.server_id : null;
}

function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

// Get message history for a channel (most recent 50, oldest first)
router.get('/:channelId', (req, res) => {
  const channelId = Number(req.params.channelId);
  const serverId = channelServerId(channelId);
  if (!serverId) return res.status(404).json({ error: 'Channel not found' });
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const before = req.query.before ? Number(req.query.before) : Date.now() + 1;

  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, u.id as user_id, u.username, u.avatar_color
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.created_at < ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `).all(channelId, before);

  res.json(rows.reverse());
});

module.exports = router;
