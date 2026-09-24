const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'thredy.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);
`);

module.exports = db;
