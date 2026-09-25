const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/me', (req, res) => {
  const user = db.prepare('SELECT loom_active, boosts_available FROM users WHERE id = ?').get(req.user.id);
  res.json({ loomActive: !!user.loom_active, boostsAvailable: user.boosts_available });
});

// Purchasing isn't wired up to any payment provider yet — by design. Anyone who wants
// Loom or boosts right now goes through Abolfazl directly (see README / admin panel).
router.post('/purchase', (req, res) => {
  res.status(403).json({
    error: "Loom isn't available for purchase yet. Contact Abolfazl to get it — he can grant it for free or let you know if it's currently invite-only.",
  });
});

module.exports = router;
