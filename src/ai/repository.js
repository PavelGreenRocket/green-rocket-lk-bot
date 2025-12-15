// src/ai/repository.js
const pool = require("../db/pool");

// ===== THEORY =====
async function loadActiveTheoryTopics(limit = 30) {
  const r = await pool.query(
    `
    SELECT id, title, content
    FROM ai_theory_topics
    WHERE is_active = true
    ORDER BY updated_at DESC, id DESC
    LIMIT $1
    `,
    [limit]
  );
  return r.rows || [];
}

// ===== BANS =====
async function loadActiveBanTopics(limit = 50) {
  const r = await pool.query(
    `
    SELECT id, title, description
    FROM ai_ban_topics
    WHERE is_active = true
    ORDER BY updated_at DESC, id DESC
    LIMIT $1
    `,
    [limit]
  );
  return r.rows || [];
}

// ===== CONTACT TOPICS =====
async function loadActiveContactTopics(limit = 50) {
  const r = await pool.query(
    `
    SELECT id, title, description
    FROM ai_contact_topics
    WHERE is_active = true
    ORDER BY updated_at DESC, id DESC
    LIMIT $1
    `,
    [limit]
  );
  return r.rows || [];
}

async function getContactTopic(topicId) {
  const r = await pool.query(
    `SELECT id, title, description FROM ai_contact_topics WHERE id = $1`,
    [topicId]
  );
  return r.rows[0] || null;
}

async function getAdminsForContactTopic(topicId) {
  const r = await pool.query(
    `
    SELECT u.id, u.full_name, u."position", u.username, u.work_phone, u.telegram_id
    FROM ai_contact_topic_admins ta
    JOIN users u ON u.id = ta.admin_user_id
    WHERE ta.topic_id = $1
    ORDER BY u.full_name
    `,
    [topicId]
  );
  return r.rows || [];
}

module.exports = {
  loadActiveTheoryTopics,
  loadActiveBanTopics,
  loadActiveContactTopics,
  getContactTopic,
  getAdminsForContactTopic,
};
