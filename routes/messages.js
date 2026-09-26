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

function attachReactions(messages) {
  if (!messages.length) return messages;
  const ids = messages.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${placeholders})`).all(...ids);

  const byMessage = new Map();
  rows.forEach((r) => {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, new Map());
    const emojiMap = byMessage.get(r.message_id);
    if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, []);
    emojiMap.get(r.emoji).push(r.user_id);
  });

  return messages.map((m) => {
    const emojiMap = byMessage.get(m.id);
    const reactions = emojiMap
      ? Array.from(emojiMap.entries()).map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
      : [];
    return { ...m, pinned: !!m.pinned, reactions };
  });
}

// Get message history for a channel (most recent 50, oldest first)
router.get('/:channelId', (req, res) => {
  const channelId = Number(req.params.channelId);
  const serverId = channelServerId(channelId);
  if (!serverId) return res.status(404).json({ error: 'Channel not found' });
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const before = req.query.before ? Number(req.query.before) : Date.now() + 1;

  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.edited_at, m.pinned, u.id as user_id, u.username, u.avatar_color, u.loom_active
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.created_at < ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `).all(channelId, before);

  res.json(attachReactions(rows.reverse()));
});

// Pinned messages for a channel
router.get('/:channelId/pinned', (req, res) => {
  const channelId = Number(req.params.channelId);
  const serverId = channelServerId(channelId);
  if (!serverId) return res.status(404).json({ error: 'Channel not found' });
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.edited_at, u.id as user_id, u.username, u.avatar_color
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? AND m.pinned = 1
    ORDER BY m.created_at DESC
  `).all(channelId);

  res.json(rows);
});

module.exports = router;
