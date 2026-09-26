const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { sendVerificationEmail } = require('../utils/mailer');

const router = express.Router();

const AVATAR_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#7289DA', '#43B581', '#F04747'];
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.full_name,
    avatarColor: user.avatar_color,
    bio: user.bio || '',
    status: user.status || 'online',
    customStatus: user.custom_status || '',
    emailVerified: !!user.email_verified,
    isAdmin: !!user.is_admin,
    loomActive: !!user.loom_active,
    boostsAvailable: user.boosts_available,
  };
}

function issueVerification(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + VERIFICATION_TTL_MS;
  db.prepare('UPDATE users SET verification_token = ?, verification_expires = ? WHERE id = ?')
    .run(token, expires, userId);
  return token;
}

router.post('/register', async (req, res) => {
  const {
    username, email, phone, fullName, password, confirmPassword, birthDate, agreedToTerms,
  } = req.body || {};

  if (!username || !email || !fullName || !password || !confirmPassword || !birthDate) {
    return res.status(400).json({ error: 'Please fill in all required fields' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-24 chars: letters, numbers, underscore only' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (fullName.trim().length < 2 || fullName.length > 60) {
    return res.status(400).json({ error: 'Name must be 2-60 characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) {
    return res.status(400).json({ error: 'Invalid date of birth' });
  }
  const age = (Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (age < 13) {
    return res.status(400).json({ error: 'You must be at least 13 years old to use Thredy' });
  }
  if (!agreedToTerms) {
    return res.status(400).json({ error: 'You must agree to the Terms & Policy to create an account' });
  }

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existingEmail) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const now = Date.now();

  const result = db.prepare(`
    INSERT INTO users (username, email, phone, full_name, birth_date, password_hash, avatar_color, terms_accepted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, email.toLowerCase(), phone || null, fullName.trim(), birthDate, passwordHash, avatarColor, now, now);

  const token = issueVerification(result.lastInsertRowid);

  let mailResult;
  try {
    mailResult = await sendVerificationEmail(email.toLowerCase(), username, token);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
    mailResult = { delivered: false };
  }

  res.status(201).json({
    message: 'Account created. Please check your email to verify your account before logging in.',
    // Only surfaced when SMTP isn't configured, so local/dev setups can still verify without a mail server.
    devVerifyUrl: (process.env.NODE_ENV !== 'production' && !mailResult.delivered)
  ? mailResult.verifyUrl
  : undefined,
  });
});

router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing verification token.');

  const user = db.prepare('SELECT * FROM users WHERE verification_token = ?').get(token);
  if (!user) return res.status(400).send('Invalid or already-used verification link.');
  if (user.verification_expires < Date.now()) {
    return res.status(400).send('This verification link has expired. Please request a new one from the login page.');
  }

  db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?')
    .run(user.id);

  res.send('<h2>Email verified!</h2><p>You can close this tab and log in to Thredy.</p>');
});

router.post('/resend-verification', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Don't reveal whether the email exists.
  if (!user || user.email_verified) {
    return res.json({ message: 'If that email exists and needs verification, a new link has been sent.' });
  }

  const token = issueVerification(user.id);
  const mailResult = await sendVerificationEmail(user.email, user.username, token).catch(() => ({ delivered: false }));

  res.json({
    message: 'If that email exists and needs verification, a new link has been sent.',
    devVerifyUrl: (process.env.NODE_ENV !== 'production' && !mailResult.delivered)
  ? mailResult.verifyUrl
  : undefined,
  });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in.', needsVerification: true });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

module.exports = router;
