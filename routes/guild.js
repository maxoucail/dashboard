const express = require('express');
const router = express.Router();
const axios = require('axios');
const { ensureAuth } = require('./auth');
const { getGuildConfig, getAiConversationCount, getWarnCount } = require('../config/database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim());

// ── Middleware pour vérifier admin guilde ──────────────────────────────────
async function ensureGuildAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/login');
  try {
    const userGuilds = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.user.accessToken}` }
    });
    const guild = userGuilds.data.find(g => g.id === req.params.id);
    if (!guild) return res.redirect('/dashboard?error=noaccess');
    const perms = BigInt(guild.permissions || 0);
    const isAdmin = (perms & BigInt(0x8)) === BigInt(0x8);
    if (!isAdmin) return res.redirect('/dashboard?error=noperm');
    req.targetGuild = guild;
    next();
  } catch (e) {
    res.redirect('/dashboard?error=auth');
  }
}

// ── /dashboard — Sélection des serveurs ──────────────────────────────────
router.get('/', ensureAuth, async (req, res) => {
  try {
    const userGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.user.accessToken}` }
    });
    const botGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const botGuildIds = new Set(botGuildsRes.data.map(g => g.id));

    const manageable = userGuildsRes.data.filter(g => {
      const perms = BigInt(g.permissions || 0);
      return (perms & BigInt(0x8)) === BigInt(0x8) && botGuildIds.has(g.id);
    });

    const notIn = userGuildsRes.data.filter(g => {
      const perms = BigInt(g.permissions || 0);
      return (perms & BigInt(0x8)) === BigInt(0x8) && !botGuildIds.has(g.id);
    });

    let globalStats = null;
    if (OWNER_IDS.includes(req.user.id)) {
      globalStats = {
        guildCount: botGuildsRes.data.length,
        aiConversations: await getAiConversationCount()
      };
    }

    res.render('dashboard', {
      user: req.user,
      guilds: manageable,
      notIn,
      globalStats,
      isOwner: OWNER_IDS.includes(req.user.id),
      error: req.query.error || null
    });
  } catch (e) {
    console.error('[Dashboard]', e.message);
    res.render('dashboard', { user: req.user, guilds: [], notIn: [], globalStats: null, isOwner: false, error: 'api_error' });
  }
});

// ── /guild/:id — Vue principale d'un serveur ─────────────────────────────
router.get('/:id', ensureAuth, ensureGuildAdmin, async (req, res) => {
  try {
    const [guildRes, channelsRes, rolesRes] = await Promise.all([
      axios.get(`https://discord.com/api/v10/guilds/${req.params.id}?with_counts=true`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      }),
      axios.get(`https://discord.com/api/v10/guilds/${req.params.id}/channels`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      }),
      axios.get(`https://discord.com/api/v10/guilds/${req.params.id}/roles`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      })
    ]);

    const config = await getGuildConfig(req.params.id);
    const warnCount = await getWarnCount(req.params.id).catch(() => 0);

    const textChannels = channelsRes.data.filter(c => c.type === 0 || c.type === 5);
    const roles = rolesRes.data.filter(r => r.id !== req.params.id);

    res.render('guild/overview', {
      user: req.user,
      guild: guildRes.data,
      config,
      textChannels,
      roles,
      warnCount,
      isOwner: OWNER_IDS.includes(req.user.id)
    });
  } catch (e) {
    console.error('[Guild Overview]', e.message);
    res.redirect('/dashboard?error=guild_error');
  }
});

// ── Pages de config individuelles ─────────────────────────────────────────

async function getGuildBase(guildId) {
  const [guildRes, channelsRes, rolesRes] = await Promise.all([
    axios.get(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    }),
    axios.get(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    }),
    axios.get(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    })
  ]);
  return {
    guild: guildRes.data,
    textChannels: channelsRes.data.filter(c => c.type === 0 || c.type === 5),
    roles: rolesRes.data.filter(r => r.id !== guildId)
  };
}

// IA
router.get('/:id/ai', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/ai', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Modération / Warns
router.get('/:id/moderation', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const { getRecentWarns } = require('../config/database');
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  const warns = await getRecentWarns(req.params.id, 20).catch(() => []);
  res.render('guild/moderation', { user: req.user, ...base, config, warns, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Accueil / Bienvenue
router.get('/:id/welcome', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/welcome', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Automod
router.get('/:id/automod', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/automod', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Anti-Raid
router.get('/:id/antiraid', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/antiraid', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// XP / Niveaux
router.get('/:id/xp', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const { getTopXpUsers } = require('../config/database');
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  const topXp = await getTopXpUsers(req.params.id, 10).catch(() => []);
  res.render('guild/xp', { user: req.user, ...base, config, topXp, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Logs
router.get('/:id/logs', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/logs', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Tickets
router.get('/:id/tickets', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/tickets', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Autoroles
router.get('/:id/autoroles', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/autoroles', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

// Réseaux sociaux / RSS
router.get('/:id/social', ensureAuth, ensureGuildAdmin, async (req, res) => {
  const base = await getGuildBase(req.params.id);
  const config = await getGuildConfig(req.params.id);
  res.render('guild/social', { user: req.user, ...base, config, isOwner: OWNER_IDS.includes(req.user.id) });
});

module.exports = router;
