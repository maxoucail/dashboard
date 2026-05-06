const express = require('express');
const router = express.Router();
const axios = require('axios');
const { ensureAuth } = require('./auth');
const { getGuildConfig, saveGuildConfig } = require('../config/database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim());

// Récupère les guilds de l'utilisateur où le bot est présent
router.get('/guilds', ensureAuth, async (req, res) => {
  try {
    const userGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.user.accessToken}` }
    });
    const userGuilds = userGuildsRes.data;

    // Guilds où le bot est présent
    const botGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const botGuildIds = new Set(botGuildsRes.data.map(g => g.id));

    const manageable = userGuilds.filter(g => {
      const perms = BigInt(g.permissions || 0);
      const isAdmin = (perms & BigInt(0x8)) === BigInt(0x8);
      return isAdmin && botGuildIds.has(g.id);
    });

    res.json({ guilds: manageable });
  } catch (e) {
    console.error('[API /guilds]', e.message);
    res.status(500).json({ error: 'Erreur Discord API' });
  }
});

// Info d'une guilde via bot
router.get('/guild/:id', ensureAuth, async (req, res) => {
  try {
    const guildRes = await axios.get(`https://discord.com/api/v10/guilds/${req.params.id}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const config = await getGuildConfig(req.params.id);
    res.json({ guild: guildRes.data, config });
  } catch (e) {
    res.status(500).json({ error: 'Guild introuvable' });
  }
});

// Config IA
router.get('/guild/:id/ai', ensureAuth, async (req, res) => {
  const config = await getGuildConfig(req.params.id);
  res.json(config?.ai_system || { enabled: true, blockedChannels: [], personality: 'gentle' });
});

router.post('/guild/:id/ai', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.ai_system = config.ai_system || {};
    const { enabled, personality, blockedChannels } = req.body;
    if (enabled !== undefined) config.ai_system.enabled = Boolean(enabled);
    if (personality) config.ai_system.personality = personality;
    if (blockedChannels !== undefined) config.ai_system.blockedChannels = blockedChannels;
    await saveGuildConfig(req.params.id, config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Config Antiraid
router.get('/guild/:id/antiraid', ensureAuth, async (req, res) => {
  const config = await getGuildConfig(req.params.id);
  res.json(config?.antiraid || {});
});

router.post('/guild/:id/antiraid', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.antiraid = { ...(config.antiraid || {}), ...req.body };
    await saveGuildConfig(req.params.id, config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Config Automod
router.get('/guild/:id/automod', ensureAuth, async (req, res) => {
  const config = await getGuildConfig(req.params.id);
  res.json(config?.automod || {});
});

router.post('/guild/:id/automod', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.automod = { ...(config.automod || {}), ...req.body };
    await saveGuildConfig(req.params.id, config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Config Accueil
router.get('/guild/:id/welcome', ensureAuth, async (req, res) => {
  const config = await getGuildConfig(req.params.id);
  res.json(config?.welcome || {});
});

router.post('/guild/:id/welcome', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.welcome = { ...(config.welcome || {}), ...req.body };
    await saveGuildConfig(req.params.id, config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logs config
router.get('/guild/:id/logs', ensureAuth, async (req, res) => {
  const config = await getGuildConfig(req.params.id);
  res.json(config?.logs || {});
});

router.post('/guild/:id/logs', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.logs = { ...(config.logs || {}), ...req.body };
    await saveGuildConfig(req.params.id, config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Channels d'une guilde
router.get('/guild/:id/channels', ensureAuth, async (req, res) => {
  try {
    const r = await axios.get(`https://discord.com/api/v10/guilds/${req.params.id}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json([]);
  }
});

// Rôles d'une guilde
router.get('/guild/:id/roles', ensureAuth, async (req, res) => {
  try {
    const r = await axios.get(`https://discord.com/api/v10/guilds/${req.params.id}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json([]);
  }
});

// Stats XP top 10
router.get('/guild/:id/xp', ensureAuth, async (req, res) => {
  const { getTopXpUsers } = require('../config/database');
  const top = await getTopXpUsers(req.params.id, 10);
  res.json(top);
});

// Warns récents
router.get('/guild/:id/warns', ensureAuth, async (req, res) => {
  const { getRecentWarns } = require('../config/database');
  const warns = await getRecentWarns(req.params.id, 20);
  res.json(warns);
});

// Stats globales (owner only)
router.get('/stats', ensureAuth, async (req, res) => {
  if (!OWNER_IDS.includes(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { getAiConversationCount } = require('../config/database');
    const aiCount = await getAiConversationCount();
    const botGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    res.json({
      guildCount: botGuildsRes.data.length,
      aiConversations: aiCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle IA rapide (owner)
router.post('/guild/:id/ai/toggle', ensureAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.id);
    config.ai_system = config.ai_system || {};
    config.ai_system.enabled = !config.ai_system.enabled;
    await saveGuildConfig(req.params.id, config);
    res.json({ enabled: config.ai_system.enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
