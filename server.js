require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is not set. Copy .env.example to .env and set a secret.');
  process.exit(1);
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const serverRoutes = require('./routes/servers');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const friendRoutes = require('./routes/friends');
const blockRoutes = require('./routes/blocks');
const dmRoutes = require('./routes/dms');
const premiumRoutes = require('./routes/premium');
const adminRoutes = require('./routes/admin');
const { initSockets, getOnlineUserIds } = require('./sockets');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
});

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('io', io);

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/blocks', blockRoutes);
app.use('/api/dms', dmRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/online', (req, res) => {
  res.json({ online: getOnlineUserIds() });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

initSockets(io);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Thredy is running at http://localhost:${PORT}`);
});
