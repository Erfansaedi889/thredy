const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { joinUserToServerRoom } = require('../sockets');

const router = express.Router();
router.use(requireAuth);

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function boostLevel(boostCount) {
  if (boostCount >= 14) return 3;
  if (boostCount >= 7) return 2;
  if (boostCount >= 2) return 1;
  return 0;
}

// List servers the current user belongs to
router.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.id, s.name, s.owner_id, s.invite_code, s.boost_count
    FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ?
    ORDER BY s.created_at ASC
  `).all(req.user.id);
  res.json(servers.map((s) => ({ ...s, boost_level: boostLevel(s.boost_count) })));
});

// Create a new server (creator becomes owner + member, gets a default #general channel)
router.post('/', (req, res) => {
  const { name } = req.body || {};
  if (!name || name.trim().length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'Server name must be 2-40 characters' });
  }

  const now = Date.now();
  const inviteCode = generateInviteCode();

  const createServer = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), req.user.id, inviteCode, now);
    const serverId = result.lastInsertRowid;

    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(serverId, req.user.id, now);

    db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)')
      .run(serverId, 'general', now);

    return serverId;
  });

  const serverId = createServer();
  const server = db.prepare('SELECT id, name, owner_id, invite_code, boost_count FROM servers WHERE id = ?').get(serverId);
  res.status(201).json({ ...server, boost_level: boostLevel(server.boost_count) });
});

// Join a server via invite code
router.post('/join', (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'Invite code is required' });

  const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(inviteCode.trim());
  if (!server) return res.status(404).json({ error: 'Invalid invite code' });

  if (isMember(server.id, req.user.id)) {
    return res.status(200).json({ id: server.id, name: server.name, owner_id: server.owner_id, invite_code: server.invite_code, boost_count: server.boost_count, boost_level: boostLevel(server.boost_count), alreadyMember: true });
  }

  db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(server.id, req.user.id, Date.now());

  const io = req.app.get('io');
  const joinedUser = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(req.user.id);
  joinUserToServerRoom(io, req.user.id, server.id);
  io.to(`server:${server.id}`).emit('member:join', { serverId: server.id, member: joinedUser });

  res.json({ id: server.id, name: server.name, owner_id: server.owner_id, invite_code: server.invite_code, boost_count: server.boost_count, boost_level: boostLevel(server.boost_count) });
});

// List members of a server
router.get('/:id/members', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM users u
    JOIN server_members sm ON sm.user_id = u.id
    WHERE sm.server_id = ?
  `).all(serverId);

  res.json(members);
});

// List channels of a server
router.get('/:id/channels', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const channels = db.prepare('SELECT id, name FROM channels WHERE server_id = ? ORDER BY created_at ASC').all(serverId);
  res.json(channels);
});

// Create a channel in a server (owner only, for now — role management is a future step)
router.post('/:id/channels', (req, res) => {
  const serverId = Number(req.params.id);
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the server owner can create channels right now' });
  }

  const { name } = req.body || {};
  if (!name || name.trim().length < 1 || name.length > 30) {
    return res.status(400).json({ error: 'Channel name must be 1-30 characters' });
  }

  const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const result = db.prepare('INSERT INTO channels (server_id, name, created_at) VALUES (?, ?, ?)')
    .run(serverId, cleanName, Date.now());

  res.status(201).json({ id: result.lastInsertRowid, name: cleanName });
});

// Spend one of the user's available boosts on this server
router.post('/:id/boost', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const user = db.prepare('SELECT boosts_available FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.boosts_available < 1) {
    return res.status(400).json({ error: 'You have no boosts available. Get Loom to receive boosts.' });
  }

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const applyBoost = db.transaction(() => {
    db.prepare('UPDATE users SET boosts_available = boosts_available - 1 WHERE id = ?').run(req.user.id);
    db.prepare('UPDATE servers SET boost_count = boost_count + 1 WHERE id = ?').run(serverId);
  });
  applyBoost();

  const newCount = server.boost_count + 1;
  const payload = { serverId, boostCount: newCount, boostLevel: boostLevel(newCount), boostedBy: req.user.username };

  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('server:boosted', payload);

  res.json(payload);
});

module.exports = router;
