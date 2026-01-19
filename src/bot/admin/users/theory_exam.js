/**
 * src/bot/admin/users/theory_exam.js
 * ЛК наставника: сдача теории стажёра (база ⭐ / продвинутый ⭐⭐+⭐⭐⭐)
 *
 * - вопросы в случайном порядке, максимум 50
 * - наставник сначала видит вопрос, затем "👁 Показать ответ"
 * - после ответа наставник отмечает ✅ Верно / ❌ Не вспомнил
 * - в конце наставник вручную выбирает ✅ Сдал / ❌ Не сдал
 * - сохраняем: conducted_by, checked_by, checked_at, correct_count, question_count, passed
 * - история: 20 последних попыток по теме+уровню
 */

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// mentor telegram_id -> state
const examState = new Map();

function mentorNameFromCtx(ctx) {
  const f = ctx.from?.first_name || "";
  const l = ctx.from?.last_name || "";
  const name = `${f} ${l}`.trim();
  return name || ctx.from?.username || String(ctx.from?.id || "");
}


async function resolveUserId(pool, candidateId) {
  // 1) если вдруг candidateId уже является users.id
  const u1 = await pool.query(`SELECT id FROM users WHERE id = $1`, [candidateId]);
  if (u1.rowCount) return u1.rows[0].id;

  // 2) основной кейс: users.candidate_id = candidates.id
  const u2 = await pool.query(`SELECT id FROM users WHERE candidate_id = $1`, [candidateId]);
  if (u2.rowCount) return u2.rows[0].id;

  // 3) если пользователя ещё нет в users — создаём (минимально)
  const c = await pool.query(`SELECT name FROM candidates WHERE id = $1`, [candidateId]);
  const fullName = c.rows?.[0]?.name || `Candidate #${candidateId}`;

  const ins = await pool.query(
    `INSERT INTO users (candidate_id, full_name) VALUES ($1, $2) RETURNING id`,
    [candidateId, fullName]
  );
  return ins.rows[0].id;
}


async function ensureMentorUser(ctx) {
  const tgId = ctx.from.id;
  const name = mentorNameFromCtx(ctx);

  // users.telegram_id in your schema is bigint; role optional
  const r = await pool.query(
    `INSERT INTO users (telegram_id, role, full_name)
     VALUES ($1, COALESCE((SELECT role FROM users WHERE telegram_id=$1), 'admin'), $2)
     ON CONFLICT (telegram_id) DO UPDATE SET full_name=EXCLUDED.full_name
     RETURNING id, full_name`,
    [tgId, name]
  );
  return r.rows[0];
}

async function getCardIdsForTopic(topicId, level) {
  const diffClause = level === "basic" ? "c.difficulty = 1" : "c.difficulty IN (2,3)";
  const r = await pool.query(
    `
    SELECT c.id
    FROM cards c
    JOIN blocks b ON b.id = c.block_id
    WHERE b.topic_id=$1 AND ${diffClause}
    ORDER BY random()
    LIMIT 50
    `,
    [topicId]
  );
  return r.rows.map((x) => Number(x.id));
}

async function getCardDetails(cardId) {
  const r = await pool.query(
    `
    SELECT c.id, c.question, c.answer, b.title AS block_title
    FROM cards c
    LEFT JOIN blocks b ON b.id = c.block_id
    WHERE c.id=$1
    `,
    [cardId]
  );
  return r.rows[0] || null;
}

async function createSession(candidateId, topicId, level, mentorId, count) {
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";
  const r = await pool.query(
    `
    INSERT INTO test_sessions (user_id, topic_id, mode, question_count, correct_count, created_at, conducted_by)
    VALUES ($1,$2,$3,$4,0,now(),$5)
    RETURNING id
    `,
    [candidateId, topicId, mode, count, mentorId]
  );
  return Number(r.rows[0].id);
}

async function saveSessionCards(sessionId, cardIds) {
  for (let i = 0; i < cardIds.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO test_session_cards(session_id, card_id, order_index)
       VALUES ($1,$2,$3)
       ON CONFLICT (session_id, order_index) DO UPDATE SET card_id=EXCLUDED.card_id`,
      [sessionId, cardIds[i], i]
    );
  }
}

async function recordAnswer(sessionId, cardId, position, isCorrect) {
  await pool.query(
    `INSERT INTO test_session_answers(session_id, card_id, position, is_correct, created_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (session_id, position) DO UPDATE SET card_id=EXCLUDED.card_id, is_correct=EXCLUDED.is_correct`,
    [sessionId, cardId, position, isCorrect]
  );
  if (isCorrect) {
    await pool.query(
      `UPDATE test_sessions SET correct_count=correct_count+1 WHERE id=$1`,
      [sessionId]
    );
  }
}

async function setPassFail(sessionId, mentorId, passed) {
  await pool.query(
    `UPDATE test_sessions
     SET passed=$2, checked_at=now(), checked_by=$3
     WHERE id=$1`,
    [sessionId, passed, mentorId]
  );
}

function pct(correct, total) {
  if (!total) return 0;
  return Math.round((100 * correct) / total);
}

async function safeEditOrReply(ctx, text, keyboard) {
  const extra = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
  try {
    if (ctx.callbackQuery?.message) {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...extra });
    }
    return await ctx.reply(text, { parse_mode: "HTML", ...extra });
  } catch (e) {
    // ignore "message is not modified"
    const desc = e?.response?.description || "";
    if (e?.response?.error_code === 400 && desc.includes("message is not modified")) return;
    throw e;
  }
}

async function showQuestion(ctx, st) {
  const cardId = st.cardIds[st.idx];
  const card = await getCardDetails(cardId);
  if (!card) return;

  const stars = st.level === "basic" ? "⭐️" : "⭐️⭐️";
  const text =
    `${stars} Вопрос ${st.idx + 1}/${st.total}\n` +
    `Блок: ${card.block_title || "—"}\n\n` +
    `❓ ${card.question}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("👁 Показать ответ", `lk_theory_exam_show_${st.sessionId}_${st.idx}`)],
    [Markup.button.callback("⬅️ Назад", `lk_perf_theory_topic_${st.candidateId}_${st.level}_${st.topicId}`)],
  ]);

  return safeEditOrReply(ctx, text, kb);
}

async function showAnswer(ctx, st, idx) {
  const cardId = st.cardIds[idx];
  const card = await getCardDetails(cardId);
  if (!card) return;

  const stars = st.level === "basic" ? "⭐️" : "⭐️⭐️";
  const text =
    `${stars} Вопрос ${idx + 1}/${st.total}\n` +
    `Блок: ${card.block_title || "—"}\n\n` +
    `❓ ${card.question}\n\n` +
    `💡 <b>Ответ:</b>\n${card.answer || "—"}\n\n` +
    `Отметь, как стажёр ответил:`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Верно", `lk_theory_exam_ans_${st.sessionId}_${idx}_1`),
      Markup.button.callback("❌ Не вспомнил", `lk_theory_exam_ans_${st.sessionId}_${idx}_0`),
    ],
    [Markup.button.callback("⬅️ Назад", `lk_perf_theory_topic_${st.candidateId}_${st.level}_${st.topicId}`)],
  ]);

  return safeEditOrReply(ctx, text, kb);
}

async function showFinish(ctx, st) {
  const r = await pool.query(
    `SELECT question_count, correct_count FROM test_sessions WHERE id=$1`,
    [st.sessionId]
  );
  const s = r.rows[0];
  const percent = pct(Number(s.correct_count || 0), Number(s.question_count || 0));
  const stars = st.level === "basic" ? "⭐️" : "⭐️⭐️";

  const text =
    `${stars} Экзамен завершён.\n\n` +
    `Результат: <b>${s.correct_count}/${s.question_count}</b> (${percent}%)\n\n` +
    `Рекомендация: зачёт при <b>≥95%</b> (решение принимает наставник).\n\n` +
    `Отметь итог:`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Сдал", `lk_theory_exam_set_${st.sessionId}_1`)],
    [Markup.button.callback("❌ Не сдал", `lk_theory_exam_set_${st.sessionId}_0`)],
    [Markup.button.callback("⬅️ Назад", `lk_perf_theory_topic_${st.candidateId}_${st.level}_${st.topicId}`)],
  ]);

  return safeEditOrReply(ctx, text, kb);
}

async function showHistory(ctx, candidateId, level, topicId) {
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";
  const r = await pool.query(
    `
    SELECT s.question_count, s.correct_count, COALESCE(s.passed,false) AS passed,
           s.checked_at, u.full_name AS mentor_name
    FROM test_sessions s
    LEFT JOIN users u ON u.id = s.checked_by
    WHERE s.user_id=$1 AND s.topic_id=$2 AND s.mode=$3 AND s.checked_at IS NOT NULL
    ORDER BY s.checked_at DESC
    LIMIT 20
    `,
    [candidateId, topicId, mode]
  );

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад", `lk_perf_theory_topic_${candidateId}_${level}_${topicId}`)],
  ]);

  if (!r.rows.length) {
    return safeEditOrReply(ctx, "История пуста.", kb);
  }

  const lines = r.rows.map((x) => {
    const percent = pct(Number(x.correct_count || 0), Number(x.question_count || 0));
    const when = x.checked_at ? new Date(x.checked_at).toLocaleString("ru-RU") : "—";
    const who = x.mentor_name || "—";
    return `• <b>${when}</b> — ${who} — ${x.correct_count}/${x.question_count} (${percent}%) — ${x.passed ? "✅" : "❌"}`;
  });

  const text = `<b>История сдач:</b>\n\n${lines.join("\n")}`;
  return safeEditOrReply(ctx, text, kb);
}

function registerTheoryExamRoutes(bot) {
  bot.action(/^lk_theory_exam_start_(\d+)_(basic|adv)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);
      const level = ctx.match[2] === "basic" ? "basic" : "adv";
      const topicId = Number(ctx.match[3]);

      const mentor = await ensureMentorUser(ctx);
      const cardIds = await getCardIdsForTopic(topicId, level);

      if (!cardIds.length) {
        return ctx.answerCbQuery("Нет карточек для этого уровня.", { show_alert: true }).catch(() => {});
      }

      const sessionId = await createSession(candidateId, topicId, level, mentor.id, cardIds.length);
      await saveSessionCards(sessionId, cardIds);

      const st = {
        candidateId,
        level,
        topicId,
        sessionId,
        idx: 0,
        total: cardIds.length,
        cardIds,
        mentorId: mentor.id,
      };
      examState.set(ctx.from.id, st);

      return showQuestion(ctx, st);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lk_theory_exam_start] error:", e);
    }
  });

  bot.action(/^lk_theory_exam_history_(\d+)_(basic|adv)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);
      const level = ctx.match[2] === "basic" ? "basic" : "adv";
      const topicId = Number(ctx.match[3]);
      return showHistory(ctx, candidateId, level, topicId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lk_theory_exam_history] error:", e);
    }
  });

  bot.action(/^lk_theory_exam_show_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = Number(ctx.match[1]);
      const idx = Number(ctx.match[2]);
      const st = examState.get(ctx.from.id);
      if (!st || st.sessionId !== sessionId) return;
      return showAnswer(ctx, st, idx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lk_theory_exam_show] error:", e);
    }
  });

  bot.action(/^lk_theory_exam_ans_(\d+)_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = Number(ctx.match[1]);
      const idx = Number(ctx.match[2]);
      const isCorrect = ctx.match[3] === "1";
      const st = examState.get(ctx.from.id);
      if (!st || st.sessionId !== sessionId) return;

      const cardId = st.cardIds[idx];
      await recordAnswer(sessionId, cardId, idx, isCorrect);

      const nextIdx = idx + 1;
      if (nextIdx >= st.total) {
        return showFinish(ctx, st);
      }

      st.idx = nextIdx;
      examState.set(ctx.from.id, st);
      return showQuestion(ctx, st);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lk_theory_exam_ans] error:", e);
    }
  });

  bot.action(/^lk_theory_exam_set_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = Number(ctx.match[1]);
      const passed = ctx.match[2] === "1";
      const mentor = await ensureMentorUser(ctx);

      await setPassFail(sessionId, mentor.id, passed);

      const st = examState.get(ctx.from.id);
      if (st && st.sessionId === sessionId) {
        examState.delete(ctx.from.id);
        return safeEditOrReply(
          ctx,
          passed ? "✅ Экзамен отмечен как сдан." : "❌ Экзамен отмечен как не сдан.",
          Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад", `lk_perf_theory_topic_${st.candidateId}_${st.level}_${st.topicId}`)],
          ])
        );
      }
      return safeEditOrReply(ctx, passed ? "✅ Экзамен отмечен как сдан." : "❌ Экзамен отмечен как не сдан.");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[lk_theory_exam_set] error:", e);
    }
  });
}

module.exports = {
  registerTheoryExamRoutes,
};