const pool = require("../db/pool");

async function insertAiChatLog({
  userId,
  question,
  answer,
  isOfftopicSuspected = false,
  confidenceScore = null,
  matchedTheoryTopicId = null,
  matchedContactTopicId = null,
}) {
  const r = await pool.query(
    `
    INSERT INTO ai_chat_logs (
      user_id,
      question,
      answer,
      is_new_for_admin,
      is_offtopic_suspected,
      confidence_score,
      matched_theory_topic_id,
      matched_contact_topic_id
    )
    VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7)
    RETURNING id
    `,
    [
      userId,
      question ?? "",
      answer ?? "",
      !!isOfftopicSuspected,
      confidenceScore,
      matchedTheoryTopicId,
      matchedContactTopicId,
    ]
  );

  return r.rows[0].id;
}

async function updateAiChatAnswer({ logId, answer }) {
  await pool.query(`UPDATE ai_chat_logs SET answer = $1 WHERE id = $2`, [
    answer ?? "",
    logId,
  ]);
}

module.exports = {
  insertAiChatLog,
  updateAiChatAnswer,
};
