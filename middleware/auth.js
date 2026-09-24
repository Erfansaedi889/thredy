const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { requireAuth, signToken, verifyToken };
