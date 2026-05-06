require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

// ── Middlewares globaux ──────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ─────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'chell-secret-key-987654321',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // true en prod avec HTTPS terminé au proxy
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 jours
  }
}));

// ── Passport / Discord OAuth2 ─────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport');

// ── EJS ───────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/guild', require('./routes/guild'));

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { 
    user: req.user || null,
    code: 404,
    message: 'Page introuvable'
  });
});

// ── Erreur globale ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Dashboard Error]', err);
  res.status(500).render('error', {
    user: req.user || null,
    code: 500,
    message: 'Erreur interne du serveur'
  });
});

app.listen(PORT, () => {
  console.log(`✅ [Dashboard] Chell Dashboard démarré sur le port ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
});
