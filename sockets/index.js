const db = require('../db');
const { verifyToken } = require('../middleware/auth');

// userId -> Set of socket ids (a user can have multiple tabs/devices open)
const onlineUsers = new Map();

// socket.id -> array of recent message timestamps, for basic rate limiting
const messageTimestamps = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 8;
const MAX_MESSAGE_BYTES = 4000;

function isRateLimited(socketId) {
  const now = Date.now();
  const recent = (messageTimestamps.get(socketId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  messageTimestamps.set(socketId, recent);
  return recent.length > RATE_LIMIT_MAX_MESSAGES;
}

function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function isDmParticipant(dmChannelId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_participants WHERE dm_channel_id = ? AND user_id = ?').get(dmChannelId, userId);
}

function dmOtherParticipants(dmChannelId, userId) {
  return db.prepare('SELECT user_id FROM dm_participants WHERE dm_channel_id = ? AND user_id != ?')
    .all(dmChannelId, userId).map((r) => r.user_id);
}

function isBlockedEitherWay(userA, userB) {
  return !!db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).get(userA, userB, userB, userA);
}

function channelServerId(channelId) {
  const row = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(channelId);
  return row ? row.server_id : null;
}

function serverMembersOf(serverId) {
  return db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId).map(r => r.user_id);
}

function initSockets(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token provided'));
      const payload = verifyToken(token);
      socket.user = payload; // { id, username }
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Join a room per server the user belongs to, so we can broadcast presence
    const myServers = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId).map(r => r.server_id);
    myServers.forEach((serverId) => {
      socket.join(`server:${serverId}`);
      io.to(`server:${serverId}`).emit('presence:update', { userId, online: true });
    });

    // Join a room per DM/group DM the user is part of
    const myDms = db.prepare('SELECT dm_channel_id FROM dm_participants WHERE user_id = ?').all(userId).map(r => r.dm_channel_id);
    myDms.forEach((dmId) => socket.join(`dm:${dmId}`));

    socket.on('channel:join', (channelId) => {
      const serverId = channelServerId(channelId);
      if (!serverId || !isMember(serverId, userId)) return;
      socket.join(`channel:${channelId}`);
    });

    socket.on('channel:leave', (channelId) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on('message:send', ({ channelId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_MESSAGE_BYTES) {
        if (ack) ack({ error: 'Invalid message' });
        return;
      }
      if (isRateLimited(socket.id)) {
        if (ack) ack({ error: 'You are sending messages too fast. Please slow down.' });
        return;
      }
      const serverId = channelServerId(channelId);
      if (!serverId || !isMember(serverId, userId)) {
        if (ack) ack({ error: 'Not a member of this channel' });
        return;
      }

      const now = Date.now();
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(channelId, userId, trimmed, now);

      const message = {
        id: result.lastInsertRowid,
        channel_id: channelId,
        user_id: userId,
        username: socket.user.username,
        content: trimmed,
        created_at: now,
      };

      io.to(`channel:${channelId}`).emit('message:new', message);
      if (ack) ack({ ok: true, message });
    });

    socket.on('typing', ({ channelId, isTyping }) => {
      socket.to(`channel:${channelId}`).emit('typing', { channelId, userId, username: socket.user.username, isTyping });
    });

    socket.on('dm:send', ({ dmChannelId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_MESSAGE_BYTES) {
        if (ack) ack({ error: 'Invalid message' });
        return;
      }
      if (isRateLimited(socket.id)) {
        if (ack) ack({ error: 'You are sending messages too fast. Please slow down.' });
        return;
      }
      if (!isDmParticipant(dmChannelId, userId)) {
        if (ack) ack({ error: 'Not part of this conversation' });
        return;
      }
      // Safety net: if either side blocked the other after this DM was created, stop new messages.
      const others = dmOtherParticipants(dmChannelId, userId);
      if (others.some((otherId) => isBlockedEitherWay(userId, otherId))) {
        if (ack) ack({ error: "You can't message this conversation anymore" });
        return;
      }

      const now = Date.now();
      const result = db.prepare(
        'INSERT INTO dm_messages (dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(dmChannelId, userId, trimmed, now);

      const message = {
        id: result.lastInsertRowid,
        dm_channel_id: dmChannelId,
        user_id: userId,
        username: socket.user.username,
        content: trimmed,
        created_at: now,
      };

      io.to(`dm:${dmChannelId}`).emit('dm:new', message);
      if (ack) ack({ ok: true, message });
    });

    socket.on('dm:typing', ({ dmChannelId, isTyping }) => {
      socket.to(`dm:${dmChannelId}`).emit('dm:typing', { dmChannelId, userId, username: socket.user.username, isTyping });
    });

    socket.on('disconnect', () => {
      messageTimestamps.delete(socket.id);
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          myServers.forEach((serverId) => {
            io.to(`server:${serverId}`).emit('presence:update', { userId, online: false });
          });
        }
      }
    });
  });
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

// Find this user's currently-connected sockets, e.g. to add them to a room
// they didn't have at connect time (they just joined a new server via REST).
function getSocketsForUser(io, userId) {
  const ids = onlineUsers.get(userId);
  if (!ids) return [];
  return Array.from(ids).map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

// Make sure a user's live sockets are subscribed to a server's presence room
// right after they join that server, so they see others' online status
// without needing to reload, and so others see them join live.
function joinUserToServerRoom(io, userId, serverId) {
  getSocketsForUser(io, userId).forEach((socket) => socket.join(`server:${serverId}`));
}

// Generic version of the above for arbitrary room names (e.g. `dm:${dmChannelId}`).
function joinUserToRoom(io, userId, roomName) {
  getSocketsForUser(io, userId).forEach((socket) => socket.join(roomName));
}

module.exports = { initSockets, getOnlineUserIds, getSocketsForUser, joinUserToServerRoom, joinUserToRoom };
