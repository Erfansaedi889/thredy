const db = require('../db');
const { verifyToken } = require('../middleware/auth');

// userId -> Set of socket ids (a user can have multiple tabs/devices open)
const onlineUsers = new Map();

// socket.id -> array of recent message timestamps, for basic rate limiting
const messageTimestamps = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 8;
const MAX_MESSAGE_BYTES = 4000;
const MAX_MESSAGE_BYTES_LOOM = 8000; // Loom members get a bigger message limit

// channelId (voice) -> Map<userId, { username, avatarColor }>
const voiceParticipants = new Map();

const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀']);
const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);

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

function getRole(serverId, userId) {
  const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!server) return null;
  if (server.owner_id === userId) return 'owner';
  const m = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  return m ? m.role : null;
}

function isModerator(serverId, userId) {
  const role = getRole(serverId, userId);
  return role === 'owner' || role === 'admin';
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

function channelInfo(channelId) {
  return db.prepare('SELECT id, server_id, type FROM channels WHERE id = ?').get(channelId);
}

function maxBytesFor(userId) {
  const u = db.prepare('SELECT loom_active FROM users WHERE id = ?').get(userId);
  return u && u.loom_active ? MAX_MESSAGE_BYTES_LOOM : MAX_MESSAGE_BYTES;
}

// Parse @username mentions out of a message and notify anyone who's online and allowed to see it.
function notifyMentions(io, content, senderUsername, context) {
  const usernames = Array.from(new Set((content.match(/@([a-zA-Z0-9_]{3,24})/g) || []).map((m) => m.slice(1))));
  if (!usernames.length) return;

  usernames.forEach((uname) => {
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (!target) return;
    if (context.serverId && !isMember(context.serverId, target.id)) return; // don't leak mentions across servers
    getSocketsForUser(io, target.id).forEach((s) => {
      s.emit('mention', { fromUsername: senderUsername, ...context });
    });
  });
}

function reactionsFor(messageId) {
  const rows = db.prepare('SELECT user_id, emoji FROM message_reactions WHERE message_id = ?').all(messageId);
  const byEmoji = new Map();
  rows.forEach((r) => {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  });
  return Array.from(byEmoji.entries()).map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

function effectiveStatus(user) {
  if (!user) return 'offline';
  return user.status === 'invisible' ? 'offline' : user.status;
}

function broadcastPresence(io, userId, online) {
  const user = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId);
  const status = online ? effectiveStatus(user) : 'offline';
  const myServers = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId).map((r) => r.server_id);
  myServers.forEach((serverId) => {
    io.to(`server:${serverId}`).emit('presence:update', { userId, status, customStatus: user ? user.custom_status : '' });
  });
  // Also tell friends directly (they may not share a server)
  const friends = db.prepare(`
    SELECT (CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END) as friend_id
    FROM friend_requests WHERE status = 'accepted' AND (from_user_id = ? OR to_user_id = ?)
  `).all(userId, userId, userId);
  friends.forEach((f) => {
    getSocketsForUser(io, f.friend_id).forEach((s) => s.emit('presence:update', { userId, status, customStatus: user ? user.custom_status : '' }));
  });
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

    const myServers = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId).map((r) => r.server_id);
    myServers.forEach((serverId) => socket.join(`server:${serverId}`));

    const myDms = db.prepare('SELECT dm_channel_id FROM dm_participants WHERE user_id = ?').all(userId).map((r) => r.dm_channel_id);
    myDms.forEach((dmId) => socket.join(`dm:${dmId}`));

    broadcastPresence(io, userId, true);

    // ---------- Text channels ----------
    socket.on('channel:join', (channelId) => {
      const ch = channelInfo(channelId);
      if (!ch || ch.type !== 'text' || !isMember(ch.server_id, userId)) return;
      socket.join(`channel:${channelId}`);
    });

    socket.on('channel:leave', (channelId) => socket.leave(`channel:${channelId}`));

    socket.on('message:send', ({ channelId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytesFor(userId)) {
        if (ack) ack({ error: 'Invalid message' });
        return;
      }
      if (isRateLimited(socket.id)) {
        if (ack) ack({ error: 'You are sending messages too fast. Please slow down.' });
        return;
      }
      const ch = channelInfo(channelId);
      if (!ch || ch.type !== 'text' || !isMember(ch.server_id, userId)) {
        if (ack) ack({ error: 'Not a member of this channel' });
        return;
      }

      const now = Date.now();
      const result = db.prepare(
        'INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(channelId, userId, trimmed, now);

      const user = db.prepare('SELECT loom_active FROM users WHERE id = ?').get(userId);
      const message = {
        id: result.lastInsertRowid,
        channel_id: channelId,
        user_id: userId,
        username: socket.user.username,
        loom_active: user ? user.loom_active : 0,
        content: trimmed,
        created_at: now,
        edited_at: null,
        pinned: false,
        reactions: [],
      };

      io.to(`channel:${channelId}`).emit('message:new', message);
      notifyMentions(io, trimmed, socket.user.username, { channelId, serverId: ch.server_id });
      if (ack) ack({ ok: true, message });
    });

    socket.on('message:edit', ({ channelId, messageId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytesFor(userId)) {
        if (ack) ack({ error: 'Invalid message' });
        return;
      }
      const existing = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?').get(messageId, channelId);
      if (!existing) { if (ack) ack({ error: 'Message not found' }); return; }
      if (existing.user_id !== userId) { if (ack) ack({ error: 'You can only edit your own messages' }); return; }

      const now = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(trimmed, now, messageId);
      io.to(`channel:${channelId}`).emit('message:edited', { channelId, messageId, content: trimmed, editedAt: now });
      if (ack) ack({ ok: true });
    });

    socket.on('message:delete', ({ channelId, messageId }, ack) => {
      const ch = channelInfo(channelId);
      const existing = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?').get(messageId, channelId);
      if (!ch || !existing) { if (ack) ack({ error: 'Message not found' }); return; }
      const canDelete = existing.user_id === userId || isModerator(ch.server_id, userId);
      if (!canDelete) { if (ack) ack({ error: 'Not authorized to delete this message' }); return; }

      db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
      io.to(`channel:${channelId}`).emit('message:deleted', { channelId, messageId });
      if (ack) ack({ ok: true });
    });

    socket.on('message:react', ({ channelId, messageId, emoji }, ack) => {
      if (!ALLOWED_REACTIONS.has(emoji)) { if (ack) ack({ error: 'Unsupported emoji' }); return; }
      const ch = channelInfo(channelId);
      if (!ch || !isMember(ch.server_id, userId)) { if (ack) ack({ error: 'Not a member of this channel' }); return; }
      const message = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(messageId, channelId);
      if (!message) { if (ack) ack({ error: 'Message not found' }); return; }

      const existing = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
      if (existing) {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
      } else {
        db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, userId, emoji, Date.now());
      }

      const reactions = reactionsFor(messageId);
      io.to(`channel:${channelId}`).emit('message:reactions', { channelId, messageId, reactions });
      if (ack) ack({ ok: true, reactions });
    });

    socket.on('message:pin', ({ channelId, messageId, pinned }, ack) => {
      const ch = channelInfo(channelId);
      if (!ch || !isModerator(ch.server_id, userId)) { if (ack) ack({ error: 'Only server admins can pin messages' }); return; }
      const message = db.prepare('SELECT id FROM messages WHERE id = ? AND channel_id = ?').get(messageId, channelId);
      if (!message) { if (ack) ack({ error: 'Message not found' }); return; }

      db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, messageId);
      io.to(`channel:${channelId}`).emit('message:pinned', { channelId, messageId, pinned: !!pinned, byUsername: socket.user.username });
      if (ack) ack({ ok: true });
    });

    socket.on('typing', ({ channelId, isTyping }) => {
      socket.to(`channel:${channelId}`).emit('typing', { channelId, userId, username: socket.user.username, isTyping });
    });

    // ---------- Voice channel lobby (presence only — no actual audio/video) ----------
    socket.on('voice:join', (channelId) => {
      const ch = channelInfo(channelId);
      if (!ch || ch.type !== 'voice' || !isMember(ch.server_id, userId)) return;
      if (!voiceParticipants.has(channelId)) voiceParticipants.set(channelId, new Map());
      const user = db.prepare('SELECT username, avatar_color FROM users WHERE id = ?').get(userId);
      voiceParticipants.get(channelId).set(userId, { username: user.username, avatarColor: user.avatar_color });
      socket.data.voiceChannelId = channelId;
      socket.join(`voice:${channelId}`);
      io.to(`server:${ch.server_id}`).emit('voice:participants', {
        channelId,
        participants: Array.from(voiceParticipants.get(channelId).entries()).map(([id, info]) => ({ id, ...info })),
      });
    });

    socket.on('voice:leave', (channelId) => {
      const ch = channelInfo(channelId);
      const participants = voiceParticipants.get(channelId);
      if (participants) {
        participants.delete(userId);
        if (participants.size === 0) voiceParticipants.delete(channelId);
      }
      socket.leave(`voice:${channelId}`);
      if (socket.data.voiceChannelId === channelId) socket.data.voiceChannelId = null;
      if (ch) {
        io.to(`server:${ch.server_id}`).emit('voice:participants', {
          channelId,
          participants: participants ? Array.from(participants.entries()).map(([id, info]) => ({ id, ...info })) : [],
        });
      }
    });

    // ---------- Direct messages ----------
    socket.on('dm:send', ({ dmChannelId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maxBytesFor(userId)) {
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
      const others = dmOtherParticipants(dmChannelId, userId);
      if (others.some((otherId) => isBlockedEitherWay(userId, otherId))) {
        if (ack) ack({ error: "You can't message this conversation anymore" });
        return;
      }

      const now = Date.now();
      const result = db.prepare(
        'INSERT INTO dm_messages (dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(dmChannelId, userId, trimmed, now);

      const user = db.prepare('SELECT loom_active FROM users WHERE id = ?').get(userId);
      const message = {
        id: result.lastInsertRowid,
        dm_channel_id: dmChannelId,
        user_id: userId,
        username: socket.user.username,
        loom_active: user ? user.loom_active : 0,
        content: trimmed,
        created_at: now,
        edited_at: null,
      };

      io.to(`dm:${dmChannelId}`).emit('dm:new', message);
      notifyMentions(io, trimmed, socket.user.username, { dmChannelId });
      if (ack) ack({ ok: true, message });
    });

    socket.on('dm:edit', ({ dmChannelId, messageId, content }, ack) => {
      const trimmed = (content || '').trim();
      if (!trimmed) { if (ack) ack({ error: 'Invalid message' }); return; }
      const existing = db.prepare('SELECT * FROM dm_messages WHERE id = ? AND dm_channel_id = ?').get(messageId, dmChannelId);
      if (!existing || existing.user_id !== userId) { if (ack) ack({ error: 'Not authorized' }); return; }

      const now = Date.now();
      db.prepare('UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(trimmed, now, messageId);
      io.to(`dm:${dmChannelId}`).emit('dm:edited', { dmChannelId, messageId, content: trimmed, editedAt: now });
      if (ack) ack({ ok: true });
    });

    socket.on('dm:delete', ({ dmChannelId, messageId }, ack) => {
      const existing = db.prepare('SELECT * FROM dm_messages WHERE id = ? AND dm_channel_id = ?').get(messageId, dmChannelId);
      if (!existing || existing.user_id !== userId) { if (ack) ack({ error: 'Not authorized' }); return; }

      db.prepare('DELETE FROM dm_messages WHERE id = ?').run(messageId);
      io.to(`dm:${dmChannelId}`).emit('dm:deleted', { dmChannelId, messageId });
      if (ack) ack({ ok: true });
    });

    socket.on('dm:typing', ({ dmChannelId, isTyping }) => {
      socket.to(`dm:${dmChannelId}`).emit('dm:typing', { dmChannelId, userId, username: socket.user.username, isTyping });
    });

    // ---------- Presence / status ----------
    socket.on('status:update', ({ status, customStatus }) => {
      if (!VALID_STATUSES.has(status)) return;
      const clean = (customStatus || '').slice(0, 100);
      db.prepare('UPDATE users SET status = ?, custom_status = ? WHERE id = ?').run(status, clean, userId);
      broadcastPresence(io, userId, true);
    });

    socket.on('disconnect', () => {
      messageTimestamps.delete(socket.id);
      if (socket.data.voiceChannelId) {
        const participants = voiceParticipants.get(socket.data.voiceChannelId);
        if (participants) {
          participants.delete(userId);
          const ch = channelInfo(socket.data.voiceChannelId);
          if (ch) {
            io.to(`server:${ch.server_id}`).emit('voice:participants', {
              channelId: socket.data.voiceChannelId,
              participants: Array.from(participants.entries()).map(([id, info]) => ({ id, ...info })),
            });
          }
        }
      }

      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          broadcastPresence(io, userId, false);
        }
      }
    });
  });
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

function isOnline(userId) {
  return onlineUsers.has(userId);
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

module.exports = { initSockets, getOnlineUserIds, isOnline, getSocketsForUser, joinUserToServerRoom, joinUserToRoom };
