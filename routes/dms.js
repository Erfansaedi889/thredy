const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { joinUserToRoom } = require('../sockets');

const router = express.Router();
router.use(requireAuth);

function isBlockedEitherWay(userA, userB) {
  return !!db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).get(userA, userB, userB, userA);
}

function isParticipant(dmChannelId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_participants WHERE dm_channel_id = ? AND user_id = ?').get(dmChannelId, userId);
}

function dmWithParticipants(dmChannelId) {
  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmChannelId);
  const participants = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM dm_participants p JOIN users u ON u.id = p.user_id
    WHERE p.dm_channel_id = ?
  `).all(dmChannelId);
  return { ...dm, participants };
}

// List all DMs (1:1 and group) the current user is part of
router.get('/', (req, res) => {
  const ids = db.prepare('SELECT dm_channel_id FROM dm_participants WHERE user_id = ?').all(req.user.id)
    .map((r) => r.dm_channel_id);
  res.json(ids.map(dmWithParticipants));
});

// Start a new DM. `usernames` = the OTHER people to include (not yourself).
// One other username -> 1:1 DM (reuses an existing one if you already have it).
// Two or more -> a group DM.
router.post('/', (req, res) => {
  const { usernames, name } = req.body || {};
  if (!Array.isArray(usernames) || usernames.length < 1) {
    return res.status(400).json({ error: 'Provide at least one username to message' });
  }

  const others = [];
  for (const uname of usernames) {
    const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(uname);
    if (!user) return res.status(404).json({ error: `No user found with username "${uname}"` });
    if (user.id === req.user.id) continue;
    if (isBlockedEitherWay(req.user.id, user.id)) {
      return res.status(403).json({ error: `Can't start a DM with ${user.username}` });
    }
    others.push(user);
  }

  if (others.length === 0) return res.status(400).json({ error: "Can't start a DM with just yourself" });

  const isGroup = others.length >= 2;

  if (!isGroup) {
    // Reuse an existing 1:1 DM between these two users, if one exists.
    const existing = db.prepare(`
      SELECT dc.id
      FROM dm_channels dc
      JOIN dm_participants p1 ON p1.dm_channel_id = dc.id AND p1.user_id = ?
      JOIN dm_participants p2 ON p2.dm_channel_id = dc.id AND p2.user_id = ?
      WHERE dc.is_group = 0
    `).get(req.user.id, others[0].id);
    if (existing) return res.json(dmWithParticipants(existing.id));
  }

  const now = Date.now();
  const createDm = db.transaction(() => {
    const result = db.prepare('INSERT INTO dm_channels (is_group, name, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(isGroup ? 1 : 0, isGroup ? (name || null) : null, req.user.id, now);
    const dmId = result.lastInsertRowid;

    const allParticipants = [req.user.id, ...others.map((u) => u.id)];
    const insertParticipant = db.prepare('INSERT INTO dm_participants (dm_channel_id, user_id, joined_at) VALUES (?, ?, ?)');
    allParticipants.forEach((uid) => insertParticipant.run(dmId, uid, now));

    return { dmId, allParticipants };
  });

  const { dmId, allParticipants } = createDm();

  const io = req.app.get('io');
  allParticipants.forEach((uid) => joinUserToRoom(io, uid, `dm:${dmId}`));

  res.status(201).json(dmWithParticipants(dmId));
});

// Message history for a DM
router.get('/:id/messages', (req, res) => {
  const dmId = Number(req.params.id);
  if (!isParticipant(dmId, req.user.id)) return res.status(403).json({ error: 'Not part of this conversation' });

  const before = req.query.before ? Number(req.query.before) : Date.now() + 1;
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at, u.id as user_id, u.username, u.avatar_color
    FROM dm_messages m JOIN users u ON u.id = m.user_id
    WHERE m.dm_channel_id = ? AND m.created_at < ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `).all(dmId, before);

  res.json(rows.reverse());
});

module.exports = router;
