const express = require('express');
const router = express.Router();
const passport = require('passport');

// ── Middleware d'authentification ─────────────────────────────────────────
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// ── Page d'accueil ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('landing', { user: req.user || null });
});

// ── Login ─────────────────────────────────────────────────────────────────
router.get('/login', passport.authenticate('discord'));

// ── Callback OAuth2 ───────────────────────────────────────────────────────
router.get('/callback',
  passport.authenticate('discord', { failureRedirect: '/?error=auth' }),
  (req, res) => {
    const returnTo = req.session.returnTo || '/dashboard';
    delete req.session.returnTo;
    res.redirect(returnTo);
  }
);

// ── Logout ────────────────────────────────────────────────────────────────
router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
module.exports.ensureAuth = ensureAuth;
