const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { joinUserToServerRoom, isOnline } = require('../sockets');

const router = express.Router();
router.use(requireAuth);

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

function boostLevel(boostCount) {
  if (boostCount >= 14) return 3;
  if (boostCount >= 7) return 2;
  if (boostCount >= 2) return 1;
  return 0;
}

function getRole(serverId, userId) {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return null;
  if (server.owner_id === userId) return 'owner';
  const member = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  return member ? member.role : null;
}

function isMember(serverId, userId) {
  return getRole(serverId, userId) !== null;
}

function isModerator(serverId, userId) {
  const role = getRole(serverId, userId);
  return role === 'owner' || role === 'admin';
}

function serverPublicShape(server) {
  return {
    id: server.id,
    name: server.name,
    description: server.description || '',
    icon_emoji: server.icon_emoji || '',
    is_public: !!server.is_public,
    owner_id: server.owner_id,
    invite_code: server.invite_code,
    boost_count: server.boost_count,
    boost_level: boostLevel(server.boost_count),
  };
}

// List servers the current user belongs to
router.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*
    FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ?
    ORDER BY s.created_at ASC
  `).all(req.user.id);
  res.json(servers.map((s) => ({ ...serverPublicShape(s), role: getRole(s.id, req.user.id) })));
});

// Discover public servers you haven't joined yet
router.get('/discover', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count
    FROM servers s
    WHERE s.is_public = 1
      AND s.id NOT IN (SELECT server_id FROM server_members WHERE user_id = ?)
    ORDER BY member_count DESC
    LIMIT 50
  `).all(req.user.id);
  res.json(servers.map((s) => ({ ...serverPublicShape(s), member_count: s.member_count })));
});

// Create a new server (creator becomes owner + member, gets a default #general text channel)
router.post('/', (req, res) => {
  const { name, description, iconEmoji, isPublic } = req.body || {};
  if (!name || name.trim().length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'Server name must be 2-40 characters' });
  }
  if (description && description.length > 200) {
    return res.status(400).json({ error: 'Description must be under 200 characters' });
  }

  const now = Date.now();
  const inviteCode = generateInviteCode();

  const createServer = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO servers (name, description, icon_emoji, is_public, owner_id, invite_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), (description || '').trim(), (iconEmoji || '').trim(), isPublic ? 1 : 0, req.user.id, inviteCode, now);
    const serverId = result.lastInsertRowid;

    db.prepare('INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(serverId, req.user.id, 'admin', now);

    db.prepare('INSERT INTO channels (server_id, name, type, created_at) VALUES (?, ?, ?, ?)')
      .run(serverId, 'general', 'text', now);
    db.prepare('INSERT INTO channels (server_id, name, type, created_at) VALUES (?, ?, ?, ?)')
      .run(serverId, 'General', 'voice', now);

    return serverId;
  });

  const serverId = createServer();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  res.status(201).json({ ...serverPublicShape(server), role: 'owner' });
});

// Update server settings (owner only)
router.patch('/:id', (req, res) => {
  const serverId = Number(req.params.id);
  const role = getRole(serverId, req.user.id);
  if (role !== 'owner') return res.status(403).json({ error: 'Only the server owner can edit server settings' });

  const { name, description, iconEmoji, isPublic } = req.body || {};
  const updates = [];
  const params = [];

  if (name !== undefined) {
    if (!name.trim() || name.length > 40) return res.status(400).json({ error: 'Server name must be 2-40 characters' });
    updates.push('name = ?'); params.push(name.trim());
  }
  if (description !== undefined) {
    if (description.length > 200) return res.status(400).json({ error: 'Description must be under 200 characters' });
    updates.push('description = ?'); params.push(description);
  }
  if (iconEmoji !== undefined) { updates.push('icon_emoji = ?'); params.push(iconEmoji); }
  if (isPublic !== undefined) { updates.push('is_public = ?'); params.push(isPublic ? 1 : 0); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(serverId);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('server:updated', serverPublicShape(server));
  res.json({ ...serverPublicShape(server), role });
});

// Join a server via invite code
router.post('/join', (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'Invite code is required' });

  const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(inviteCode.trim());
  if (!server) return res.status(404).json({ error: 'Invalid invite code' });

  if (isMember(server.id, req.user.id)) {
    return res.status(200).json({ ...serverPublicShape(server), role: getRole(server.id, req.user.id), alreadyMember: true });
  }

  db.prepare('INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(server.id, req.user.id, 'member', Date.now());

  const io = req.app.get('io');
  const joinedUser = db.prepare('SELECT id, username, avatar_color, status, custom_status FROM users WHERE id = ?').get(req.user.id);
  joinUserToServerRoom(io, req.user.id, server.id);
  io.to(`server:${server.id}`).emit('member:join', { serverId: server.id, member: { ...joinedUser, role: 'member' } });

  res.json({ ...serverPublicShape(server), role: 'member' });
});

// Join a public server directly (no invite code needed) from Discover
router.post('/:id/join-public', (req, res) => {
  const serverId = Number(req.params.id);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server || !server.is_public) return res.status(404).json({ error: 'Server not found or not public' });
  if (isMember(serverId, req.user.id)) return res.status(409).json({ error: 'Already a member' });

  db.prepare('INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(serverId, req.user.id, 'member', Date.now());

  const io = req.app.get('io');
  const joinedUser = db.prepare('SELECT id, username, avatar_color, status, custom_status FROM users WHERE id = ?').get(req.user.id);
  joinUserToServerRoom(io, req.user.id, serverId);
  io.to(`server:${serverId}`).emit('member:join', { serverId, member: { ...joinedUser, role: 'member' } });

  res.json({ ...serverPublicShape(server), role: 'member' });
});

// Leave a server (owner can't leave — they should delete or transfer, not supported yet)
router.post('/:id/leave', (req, res) => {
  const serverId = Number(req.params.id);
  const role = getRole(serverId, req.user.id);
  if (!role) return res.status(403).json({ error: 'Not a member of this server' });
  if (role === 'owner') return res.status(400).json({ error: "As the owner, you can't leave your own server" });

  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, req.user.id);
  res.json({ message: 'Left the server' });
});

// List members of a server, with role and live presence fields
router.get('/:id/members', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.status, u.custom_status, u.loom_active, sm.role
    FROM users u
    JOIN server_members sm ON sm.user_id = u.id
    WHERE sm.server_id = ?
  `).all(serverId);

  res.json(members.map((m) => ({ ...m, role: m.id === server.owner_id ? 'owner' : m.role, status: isOnline(m.id) ? m.status : 'offline' })));
});

// Kick a member (owner/admin only; admins can't kick the owner or other admins)
router.delete('/:id/members/:userId', (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const myRole = getRole(serverId, req.user.id);
  if (myRole !== 'owner' && myRole !== 'admin') return res.status(403).json({ error: 'Not authorized to kick members' });

  const targetRole = getRole(serverId, targetId);
  if (targetRole === 'owner') return res.status(400).json({ error: "Can't kick the server owner" });
  if (targetRole === 'admin' && myRole !== 'owner') return res.status(403).json({ error: 'Only the owner can kick an admin' });

  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, targetId);

  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('member:kick', { serverId, userId: targetId });

  res.json({ message: 'Member removed' });
});

// Promote/demote a member (owner only)
router.post('/:id/members/:userId/role', (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: "role must be 'admin' or 'member'" });

  if (getRole(serverId, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can change roles' });
  if (!isMember(serverId, targetId)) return res.status(404).json({ error: 'That user is not a member of this server' });

  db.prepare('UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?').run(role, serverId, targetId);

  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('member:role-changed', { serverId, userId: targetId, role });

  res.json({ message: `Role updated to ${role}` });
});

// List channels of a server
router.get('/:id/channels', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member of this server' });

  const channels = db.prepare('SELECT id, name, type FROM channels WHERE server_id = ? ORDER BY type ASC, created_at ASC').all(serverId);
  res.json(channels);
});

// Create a channel in a server (owner or admin)
router.post('/:id/channels', (req, res) => {
  const serverId = Number(req.params.id);
  if (!isModerator(serverId, req.user.id)) {
    return res.status(403).json({ error: 'Only server admins can create channels' });
  }

  const { name, type } = req.body || {};
  if (!name || name.trim().length < 1 || name.length > 30) {
    return res.status(400).json({ error: 'Channel name must be 1-30 characters' });
  }
  const channelType = type === 'voice' ? 'voice' : 'text';
  const cleanName = channelType === 'voice' ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, '-');

  const result = db.prepare('INSERT INTO channels (server_id, name, type, created_at) VALUES (?, ?, ?, ?)')
    .run(serverId, cleanName, channelType, Date.now());

  const channel = { id: result.lastInsertRowid, name: cleanName, type: channelType };
  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('channel:created', { serverId, channel });

  res.status(201).json(channel);
});

// Delete a channel (owner or admin)
router.delete('/:id/channels/:channelId', (req, res) => {
  const serverId = Number(req.params.id);
  const channelId = Number(req.params.channelId);
  if (!isModerator(serverId, req.user.id)) return res.status(403).json({ error: 'Only server admins can delete channels' });

  const remaining = db.prepare('SELECT COUNT(*) as c FROM channels WHERE server_id = ?').get(serverId).c;
  if (remaining <= 1) return res.status(400).json({ error: "Can't delete a server's last channel" });

  db.prepare('DELETE FROM channels WHERE id = ? AND server_id = ?').run(channelId, serverId);

  const io = req.app.get('io');
  io.to(`server:${serverId}`).emit('channel:deleted', { serverId, channelId });

  res.json({ message: 'Channel deleted' });
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
