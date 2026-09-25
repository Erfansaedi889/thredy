// Usage: node scripts/make-admin.js <username>
// Run this directly on your server to grant an existing account admin rights.
require('dotenv').config();
const db = require('../db');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node scripts/make-admin.js <username>');
  process.exit(1);
}

const user = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user found with username "${username}". Make sure the account exists and its email is verified first.`);
  process.exit(1);
}

db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
console.log(`✔ ${user.username} is now a Thredy admin.`);
