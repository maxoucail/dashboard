const { Pool } = require('pg');
const mysql = require('mysql2/promise');

// ── PostgreSQL (bot data) ─────────────────────────────────────────────────
const pgPool = new Pool({
  host: process.env.DB_PG_HOST,
  port: parseInt(process.env.DB_PG_PORT || '5432'),
  user: process.env.DB_PG_USER,
  password: process.env.DB_PG_PASSWORD,
  database: process.env.DB_PG_NAME,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

// ── MySQL (JSON KV store du bot) ──────────────────────────────────────────
let mysqlPool = null;

async function getMysqlPool() {
  if (!mysqlPool) {
    mysqlPool = await mysql.createPool({
      host: process.env.DB_HOST || '10.0.70.3',
      user: process.env.DB_USERNAME || 'chell',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 's2_chell',
      waitForConnections: true,
      connectionLimit: 10
    });
  }
  return mysqlPool;
}

// ── Helpers DB JSON (guildConfig) ────────────────────────────────────────
async function getGuildConfig(guildId) {
  try {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute(
      'SELECT value FROM `kv_store` WHERE `key` = ? LIMIT 1',
      [`guild_${guildId}`]
    );
    if (rows.length > 0) return JSON.parse(rows[0].value);
  } catch (e) {}
  return {};
}

async function saveGuildConfig(guildId, config) {
  const pool = await getMysqlPool();
  const json = JSON.stringify(config);
  await pool.execute(
    'INSERT INTO `kv_store` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
    [`guild_${guildId}`, json, json]
  );
}

async function getGlobalDb() {
  try {
    const pool = await getMysqlPool();
    const [rows] = await pool.execute(
      'SELECT value FROM `kv_store` WHERE `key` = ? LIMIT 1',
      ['global']
    );
    if (rows.length > 0) return JSON.parse(rows[0].value);
  } catch (e) {}
  return {};
}

// ── Stats PostgreSQL ──────────────────────────────────────────────────────
async function getAiConversationCount() {
  try {
    const res = await pgPool.query('SELECT COUNT(*) FROM ai_history');
    return parseInt(res.rows[0].count || 0);
  } catch { return 0; }
}

async function getAiMessageStats(guildId) {
  try {
    const res = await pgPool.query(
      'SELECT COUNT(*) as cnt FROM ai_history WHERE guild_id = $1',
      [guildId]
    );
    return parseInt(res.rows[0]?.cnt || 0);
  } catch { return 0; }
}

async function getWarnCount(guildId) {
  try {
    const res = await pgPool.query(
      'SELECT COUNT(*) FROM warns WHERE guild_id = $1',
      [guildId]
    );
    return parseInt(res.rows[0]?.count || 0);
  } catch { return 0; }
}

async function getTopXpUsers(guildId, limit = 10) {
  try {
    const res = await pgPool.query(
      'SELECT user_id, xp, level FROM xp WHERE guild_id = $1 ORDER BY xp DESC LIMIT $2',
      [guildId, limit]
    );
    return res.rows;
  } catch { return []; }
}

async function getRecentWarns(guildId, limit = 5) {
  try {
    const res = await pgPool.query(
      'SELECT user_id, reason, moderator_id, created_at FROM warns WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
      [guildId, limit]
    );
    return res.rows;
  } catch { return []; }
}

async function getMemberCount(guildId) {
  try {
    const res = await pgPool.query(
      'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
      [guildId]
    );
    return parseInt(res.rows[0]?.count || 0);
  } catch { return 0; }
}

module.exports = {
  pgPool,
  getMysqlPool,
  getGuildConfig,
  saveGuildConfig,
  getGlobalDb,
  getAiConversationCount,
  getAiMessageStats,
  getWarnCount,
  getTopXpUsers,
  getRecentWarns,
  getMemberCount
};
