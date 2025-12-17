// src/ai/settings.js
const pool = require("../db/pool");

// простейший кэш, чтобы не долбить БД на каждый вопрос
const cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 30_000;

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function getSetting(key, defaultValue) {
  const cached = getCached(key);
  if (cached !== null && cached !== undefined) return cached;

  const res = await pool.query(
    `SELECT value FROM ai_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  if (!res.rows.length) {
    // не создаём запись автоматически — просто fallback
    setCached(key, defaultValue);
    return defaultValue;
  }

  const value = res.rows[0].value;
  setCached(key, value);
  return value;
}

async function setSetting(key, value) {
  await pool.query(
    `
    INSERT INTO ai_settings(key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, JSON.stringify(value)]
  );
  setCached(key, value);
}

async function getAiConfig() {
  // JSONB может хранить число/строку как JSON
  const topKRaw = await getSetting("top_k", 3);
  const dailyLimitRaw = await getSetting("daily_limit_default", 3);
  const tzRaw = await getSetting("company_tz", "Europe/Moscow");

  const topK = Number(topKRaw);
  const dailyLimitDefault = Number(dailyLimitRaw);
  const companyTz = typeof tzRaw === "string" ? tzRaw : "Europe/Moscow";

  return {
    topK: Number.isFinite(topK) ? topK : 3,
    dailyLimitDefault: Number.isFinite(dailyLimitDefault)
      ? dailyLimitDefault
      : 3,
    companyTz,
  };
}

module.exports = {
  getSetting,
  setSetting,
  getAiConfig,
};
