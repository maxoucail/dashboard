const express = require('express');
const router = express.Router();
const { ensureAuth } = require('./auth');
const { getGuildConfig } = require('../config/database');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;

// Redirige /guild/:id/* vers les bonnes pages
router.get('/:id/ai/save', ensureAuth, async (req, res) => res.redirect(`/guild/${req.params.id}/ai`));

module.exports = router;
