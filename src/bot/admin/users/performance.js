// src/bot/admin/users/performance.js
// ЛК наставника: успеваемость стажёра (аттестация/теория/тесты/данные стажировок)

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// Состояния: ожидание файла по элементу аттестации, а также тестирование темы
// key: tg_id, value: { kind: 'attest_file'|'theory_test', ... }
const states = new Map();
const setState = (tgId, s) => states.set(tgId, s);
const getState = (tgId) => states.get(tgId);
const clearState = (tgId) => states.delete(tgId);

async function safeEdit(ctx, text, keyboard) {
  const extra = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
  try {
    if (extra) return await ctx.editMessageText(text, extra);
    return await ctx.editMessageText(text);
  } catch (e) {
    if (extra) return await ctx.reply(text, extra);
    return await ctx.reply(text);
  }
}

async function ensureDefaultAttestationItems() {
  const defaults = [
    { title: "📖 техкарта", order_index: 1 },
    { title: "📘 теория база", order_index: 2 },
    { title: "📕 теория продвинутый", order_index: 3 },
  ];

  for (const d of defaults) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO attestation_items (title, order_index, is_active, is_default, item_type)
       SELECT $1, $2, TRUE, TRUE, 'normal'
       WHERE NOT EXISTS (
         SELECT 1 FROM attestation_items WHERE COALESCE(is_default,FALSE)=TRUE AND order_index=$2
       )`,
      [d.title, d.order_index]
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE attestation_items
       SET title=$1
       WHERE COALESCE(is_default,FALSE)=TRUE AND order_index=$2`,
      [d.title, d.order_index]
    );
  }
}

async function getUserBrief(userId) {
  const r = await pool.query(
    `  SELECT
    id,
    COALESCE(full_name, username, work_phone, '') AS name,
    telegram_id
  FROM users
  WHERE id = $1`,
    [userId]
  );
  return r.rows[0] || { id: userId, name: `ID ${userId}`, telegram_id: "" };
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

async function showPerformanceHome(ctx, candidateId) {
  const text = `📊 Успеваемость\n\nВыбери раздел:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🏅 аттестация", `lk_perf_attest_${candidateId}`)],
    [Markup.button.callback("📊 тесты", `lk_perf_tests_${candidateId}`)],
    [
      Markup.button.callback(
        "🌱 данные стажировок",
        `lk_internship_data_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Назад к карточке",
        `lk_cards_switch_trainee_${candidateId}`
      ),
    ],
  ]);
  await safeEdit(ctx, text, kb);
}

async function showTestsStub(ctx, candidateId) {
  const text = `📊 Тесты\n\nДанные по тестам добавим позже.`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`)],
  ]);
  await safeEdit(ctx, text, kb);
}

async function fetchAttestationItems() {
  const r = await pool.query(
    `SELECT id, title, description, order_index, is_active,
            COALESCE(is_default,FALSE) AS is_default,
            COALESCE(item_type,'normal') AS item_type,
            example_file_id, example_file_type
     FROM attestation_items
     WHERE is_active = TRUE
     ORDER BY order_index, id`
  );
  return r.rows;
}

async function fetchUserAttestationStatuses(candidateId) {
  const r = await pool.query(
    `SELECT item_id, status,
            submission_file_id, submission_file_type,
            submitted_at, submitted_by,
            checked_by, updated_at
     FROM user_attestation_status
     WHERE user_id=$1`,
    [candidateId]
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.item_id, row);
  return map;
}

async function fetchTheoryTopicsWithCards(level) {
  // level: 'basic'|'advanced'
  const diffClause =
    level === "basic" ? "c.difficulty = 1" : "c.difficulty IN (2,3)";
  const r = await pool.query(
    `SELECT t.id, t.title, t.order_index
     FROM topics t
     WHERE EXISTS (
       SELECT 1
       FROM blocks b
       JOIN cards c ON c.block_id = b.id
       WHERE b.topic_id = t.id AND ${diffClause}
     )
     ORDER BY t.order_index, t.id`
  );
  return r.rows;
}

async function fetchLatestTopicResults(candidateId, mode) {
  // mode: 'mentor_basic'|'mentor_adv'
  const r = await pool.query(
    `SELECT DISTINCT ON (topic_id)
        topic_id,
        passed,
        conducted_by,
        COALESCE(finished_at, created_at) AS dt
     FROM test_sessions
     WHERE user_id=$1 AND mode=$2 AND topic_id IS NOT NULL
     ORDER BY topic_id, created_at DESC`,
    [candidateId, mode]
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.topic_id, row);
  return map;
}

async function showAttestMenu(ctx, candidateId) {
  await ensureDefaultAttestationItems();

  const user = await getUserBrief(candidateId);
  const items = await fetchAttestationItems();
  const statuses = await fetchUserAttestationStatuses(candidateId);

  // теория % (пока теория — не заглушка, но тестирование реализуем; проценты считаются по темам)
  const basicTopics = await fetchTheoryTopicsWithCards("basic");
  const advTopics = await fetchTheoryTopicsWithCards("advanced");
  const basicRes = await fetchLatestTopicResults(candidateId, "mentor_basic");
  const advRes = await fetchLatestTopicResults(candidateId, "mentor_adv");

  const basicPassed = [...basicRes.values()].filter(
    (x) => x.passed === true
  ).length;
  const advPassed = [...advRes.values()].filter(
    (x) => x.passed === true
  ).length;
  const basicPct = basicTopics.length
    ? Math.round((basicPassed / basicTopics.length) * 100)
    : 0;
  const advPct = advTopics.length
    ? Math.round((advPassed / advTopics.length) * 100)
    : 0;

  let text =
    `🏅 Элементы аттестации:\n\n` +
    `• Имя: ${user.name} (${user.id}) ${user.telegram_id || ""}\n\n` +
    `Здесь можно отслеживать успехи, тестировать и отмечать выполнение:\n` +
    `Насчёт теории база и продвинутый — процент считается по темам.\n\n`;

  const buttons = [];

  for (const row of items) {
    // дефолтные по order_index
    if (row.is_default && row.order_index === 2) {
      const icon = basicPct === 100 ? "✅" : "⚪";
      text += `${icon} ${row.title} (${basicPct}%)\n`;
      buttons.push([
        Markup.button.callback(
          `${icon} ${row.title} (${basicPct}%)`,
          `lk_perf_theory_${candidateId}_basic`
        ),
      ]);
      continue;
    }
    if (row.is_default && row.order_index === 3) {
      const icon = advPct === 100 ? "✅" : "⚪";
      text += `${icon} ${row.title} (${advPct}%)\n`;
      buttons.push([
        Markup.button.callback(
          `${icon} ${row.title} (${advPct}%)`,
          `lk_perf_theory_${candidateId}_adv`
        ),
      ]);
      continue;
    }
    if (row.is_default && row.order_index === 1) {
      // техкарта пока заглушка
      text += `⚪ ${row.title} (0%)\n`;
      buttons.push([
        Markup.button.callback(
          `⚪ ${row.title} (0%)`,
          `lk_perf_attest_default_${candidateId}_${row.id}`
        ),
      ]);
      continue;
    }

    const st = statuses.get(row.id);
    const passed = st && st.status === "passed";
    const icon = passed ? "✅" : "⚪";
    const pct = passed ? 100 : 0;
    text += `${icon} ${row.title} (${pct}%)\n`;
    buttons.push([
      Markup.button.callback(
        `${icon} ${row.title} (${pct}%)`,
        `lk_perf_attest_do_${candidateId}_${row.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`),
  ]);
  await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showDefaultStub(ctx, candidateId) {
  const text = `📖 техкарта\n\nПока заглушка.`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`)],
  ]);
  await safeEdit(ctx, text, kb);
}

async function getAttestItem(itemId) {
  const r = await pool.query(
    `SELECT id, title, description, COALESCE(item_type,'normal') AS item_type,
            example_file_id, example_file_type
     FROM attestation_items
     WHERE id=$1`,
    [itemId]
  );
  return r.rows[0] || null;
}

async function getUserAttestStatus(candidateId, itemId) {
  const r = await pool.query(
    `SELECT *
     FROM user_attestation_status
     WHERE user_id=$1 AND item_id=$2`,
    [candidateId, itemId]
  );
  return r.rows[0] || null;
}

async function upsertUserAttest(candidateId, itemId, patch) {
  // patch: {status, checked_by, updated_by_admin_id, submission_file_id, submission_file_type, submitted_at, submitted_by}
  const cols = Object.keys(patch);
  const vals = Object.values(patch);
  const sets = cols.map((c, i) => `${c}=$${i + 4}`).join(", ");
  await pool.query(
    `INSERT INTO user_attestation_status (user_id, item_id, status, updated_by_admin_id, ${cols.join(
      ", "
    )})
     VALUES ($1,$2,$3,$4, ${cols.map((_, i) => `$${i + 4}`).join(", ")})
     ON CONFLICT (user_id, item_id)
     DO UPDATE SET status=EXCLUDED.status, updated_by_admin_id=EXCLUDED.updated_by_admin_id, ${sets}, updated_at=now()`,
    [
      candidateId,
      itemId,
      patch.status || "not_passed",
      patch.updated_by_admin_id || null,
      ...vals,
    ]
  );
}

async function showAttestDo(ctx, mentorUser, candidateId, itemId) {
  const item = await getAttestItem(itemId);
  if (!item)
    return safeEdit(
      ctx,
      "Элемент не найден.",
      Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`)],
      ])
    );
  const st = await getUserAttestStatus(candidateId, itemId);

  const passed = st && st.status === "passed";
  const desc = item.description ? `\n\nОписание:\n${item.description}` : "";

  if (item.item_type === "normal") {
    const text = `🏅 ${item.title}\n${passed ? "\n✅ Сдано" : ""}${desc}`;
    const kb = Markup.inlineKeyboard([
      ...(passed
        ? []
        : [
            [
              Markup.button.callback(
                "✅ пометить, сдал",
                `lk_perf_attest_mark_${candidateId}_${itemId}`
              ),
            ],
          ]),
      [Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`)],
    ]);
    return safeEdit(ctx, text, kb);
  }

  // photo/video
  const kindLabel = item.item_type === "video" ? "видео" : "фото";

  if (!st || !st.submission_file_id) {
    // показать пример (если есть) + запросить файл
    const text = `🏅 ${item.title}\n${desc}\n\nПришлите ${kindLabel} одним сообщением.`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`)],
    ]);
    await safeEdit(ctx, text, kb);

    // отправляем пример файлом (если есть)
    if (item.example_file_id && item.example_file_type) {
      try {
        if (item.example_file_type === "photo")
          await ctx.replyWithPhoto(item.example_file_id);
        if (item.example_file_type === "video")
          await ctx.replyWithVideo(item.example_file_id);
      } catch (_) {}
    }

    setState(ctx.from.id, {
      kind: "attest_file",
      candidateId,
      itemId,
      itemType: item.item_type, // photo|video
    });
    return;
  }

  // уже есть файл — показать и дать поменять
  let info = "";
  if (st.submitted_at) info += `\nДата: ${fmtDate(st.submitted_at)}`;
  if (st.submitted_by)
    info += `\nКто прислал: ${mentorUser.name || st.submitted_by}`;
  const text = `🏅 ${item.title}\n✅ Файл прикреплён.${info}${desc}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `🔁 поменять ${kindLabel}`,
        `lk_perf_attest_change_${candidateId}_${itemId}`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`)],
  ]);
  await safeEdit(ctx, text, kb);
  try {
    if (st.submission_file_type === "photo")
      await ctx.replyWithPhoto(st.submission_file_id);
    if (st.submission_file_type === "video")
      await ctx.replyWithVideo(st.submission_file_id);
  } catch (_) {}
}

async function markAttestPassed(ctx, mentorUser, candidateId, itemId) {
  // отметить как passed
  await pool.query(
    `INSERT INTO user_attestation_status (user_id,item_id,status,updated_by_admin_id,checked_by,updated_at)
     VALUES ($1,$2,'passed',$3,$3,now())
     ON CONFLICT (user_id,item_id)
     DO UPDATE SET status='passed', updated_by_admin_id=$3, checked_by=$3, updated_at=now()`,
    [candidateId, itemId, mentorUser.id]
  );
}

async function startTheoryTopics(ctx, candidateId, level) {
  const user = await getUserBrief(candidateId);
  const lvlName =
    level === "basic" ? "📘 теория база" : "📕 теория продвинутый";
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";

  const topics = await fetchTheoryTopicsWithCards(level);
  const latest = await fetchLatestTopicResults(candidateId, mode);

  let text = `${lvlName}\n\n• Имя: ${user.name} (${user.id}) ${
    user.telegram_id || ""
  }\n\nВыбери тему:`;
  const buttons = [];

  for (const t of topics) {
    const r = latest.get(t.id);
    if (!r || r.passed === null || typeof r.passed === "undefined") {
      buttons.push([
        Markup.button.callback(
          t.title,
          `lk_perf_theory_topic_${candidateId}_${level}_${t.id}`
        ),
      ]);
      continue;
    }
    const icon = r.passed ? "✅" : "❌";
    const date = fmtDate(r.dt);
    // тут conducted_by — id наставника. Имя наставника вытянем лениво на экране темы (не в списке), чтобы не делать N запросов
    buttons.push([
      Markup.button.callback(
        `${icon} ${t.title} (${date})`,
        `lk_perf_theory_topic_${candidateId}_${level}_${t.id}`
      ),
    ]);
  }

  // фильтр (заглушка простая) — позже можно сделать отдельные кнопки
  buttons.push([
    Markup.button.callback("⬅️ Назад", `lk_perf_attest_${candidateId}`),
  ]);
  await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
}

async function showTheoryTopicEntry(
  ctx,
  mentorUser,
  candidateId,
  level,
  topicId
) {
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";

  // проверяем есть ли карточки (на всякий случай)
  const diffClause =
    level === "basic" ? "c.difficulty = 1" : "c.difficulty IN (2,3)";
  const cardsRes = await pool.query(
    `SELECT c.id, c.question, c.answer
     FROM blocks b
     JOIN cards c ON c.block_id=b.id
     WHERE b.topic_id=$1 AND ${diffClause}
     ORDER BY c.id`,
    [topicId]
  );
  if (!cardsRes.rows.length) {
    return safeEdit(
      ctx,
      "В этой теме нет вопросов нужного уровня.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад",
            `lk_perf_theory_${candidateId}_${
              level === "basic" ? "basic" : "adv"
            }`
          ),
        ],
      ])
    );
  }

  // найти последнюю сессию по теме
  const lastRes = await pool.query(
    `SELECT id, passed, conducted_by, COALESCE(finished_at, created_at) AS dt
     FROM test_sessions
     WHERE user_id=$1 AND topic_id=$2 AND mode=$3
     ORDER BY created_at DESC
     LIMIT 1`,
    [candidateId, topicId, mode]
  );
  const last = lastRes.rows[0];

  // имя темы
  const tRes = await pool.query(`SELECT title FROM topics WHERE id=$1`, [
    topicId,
  ]);
  const title =
    tRes.rows[0] && tRes.rows[0].title ? tRes.rows[0].title : `Тема ${topicId}`;

  if (!last) {
    const text = `📚 Тема: ${title}\n\nПерейти к тестированию?`;
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Да",
          `lk_perf_theory_start_${candidateId}_${level}_${topicId}`
        ),
      ],
      [
        Markup.button.callback(
          "⬅️ Назад",
          `lk_perf_theory_${candidateId}_${level === "basic" ? "basic" : "adv"}`
        ),
      ],
    ]);
    return safeEdit(ctx, text, kb);
  }

  // уже тестировалась
  const icon =
    last.passed === true ? "✅" : last.passed === false ? "❌" : "⚪";
  const date = fmtDate(last.dt);
  const text = `📚 Тема: ${title}\n\nПоследний результат: ${icon} (${date})\n\nПерейти к тестированию?`;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Да",
        `lk_perf_theory_start_${candidateId}_${level}_${topicId}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Назад",
        `lk_perf_theory_${candidateId}_${level === "basic" ? "basic" : "adv"}`
      ),
    ],
  ]);
  return safeEdit(ctx, text, kb);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function startTheoryTest(ctx, mentorUser, candidateId, level, topicId) {
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";
  const diffClause =
    level === "basic" ? "c.difficulty = 1" : "c.difficulty IN (2,3)";

  const cardsRes = await pool.query(
    `SELECT c.id, c.question, c.answer
     FROM blocks b
     JOIN cards c ON c.block_id=b.id
     WHERE b.topic_id=$1 AND ${diffClause}
     ORDER BY c.id`,
    [topicId]
  );
  if (!cardsRes.rows.length) {
    return safeEdit(
      ctx,
      "В этой теме нет вопросов нужного уровня.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад",
            `lk_perf_theory_${candidateId}_${
              level === "basic" ? "basic" : "adv"
            }`
          ),
        ],
      ])
    );
  }

  let cards = cardsRes.rows;
  shuffle(cards);
  if (cards.length > 50) cards = cards.slice(0, 50);

  // создать сессию
  const ins = await pool.query(
    `INSERT INTO test_sessions (user_id, mode, topic_id, question_count, correct_count, admin_id, conducted_by)
     VALUES ($1,$2,$3,$4,0,$5,$5)
     RETURNING id`,
    [candidateId, mode, topicId, cards.length, mentorUser.id]
  );
  const sessionId = ins.rows[0].id;

  setState(ctx.from.id, {
    kind: "theory_test",
    sessionId,
    candidateId,
    topicId,
    level,
    pos: 0,
    correct: 0,
    cards, // [{id,question,answer}]
  });

  await showTheoryQuestion(ctx, candidateId, sessionId);
}

async function showTheoryQuestion(ctx, candidateId, sessionId) {
  const st = getState(ctx.from.id);
  if (!st || st.kind !== "theory_test" || st.sessionId !== sessionId) return;

  const idx = st.pos;
  const total = st.cards.length;
  const card = st.cards[idx];

  const text =
    `⭐ Вопрос ${idx + 1}/${total}\n\n` +
    `❓ ${card.question}\n\n` +
    `💡 Ответ:\n${card.answer}\n\n` +
    `Отметь как пользователь ответил:`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Верно", `lk_perf_theory_ans_${sessionId}_1`),
      Markup.button.callback("❌ Неверно", `lk_perf_theory_ans_${sessionId}_0`),
    ],
  ]);

  await safeEdit(ctx, text, kb);
}

async function recordTheoryAnswer(ctx, mentorUser, sessionId, isCorrect) {
  const st = getState(ctx.from.id);
  if (!st || st.kind !== "theory_test" || st.sessionId !== sessionId) return;

  const idx = st.pos;
  const card = st.cards[idx];

  await pool.query(
    `INSERT INTO test_session_answers (session_id, card_id, position, is_correct)
     VALUES ($1,$2,$3,$4)`,
    [sessionId, card.id, idx + 1, isCorrect]
  );

  if (isCorrect) st.correct += 1;
  st.pos += 1;
  setState(ctx.from.id, st);

  if (st.pos >= st.cards.length) {
    // финал
    await pool.query(
      `UPDATE test_sessions
       SET correct_count=$2
       WHERE id=$1`,
      [sessionId, st.correct]
    );

    const text =
      `🏁 Тест завершён\n\n` +
      `Верных: ${st.correct} из ${st.cards.length}\n\n` +
      `Отметь итог:`;

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Сдано",
          `lk_perf_theory_finish_${sessionId}_1`
        ),
        Markup.button.callback(
          "❌ Не сдано",
          `lk_perf_theory_finish_${sessionId}_0`
        ),
      ],
    ]);

    await safeEdit(ctx, text, kb);
    return;
  }

  await showTheoryQuestion(ctx, st.candidateId, sessionId);
}

async function finishTheorySession(ctx, mentorUser, sessionId, passed) {
  const st = getState(ctx.from.id);
  if (!st || st.kind !== "theory_test" || st.sessionId !== sessionId) return;

  await pool.query(
    `UPDATE test_sessions
     SET passed=$2, finished_at=now(), conducted_by=$3, admin_id=$3
     WHERE id=$1`,
    [sessionId, passed, mentorUser.id]
  );

  clearState(ctx.from.id);
  // назад к темам
  const levelKey = st.level === "basic" ? "basic" : "adv";
  await startTheoryTopics(
    ctx,
    st.candidateId,
    levelKey === "basic" ? "basic" : "advanced"
  );
}

function registerPerformance(bot, ensureUser, logError) {
  // вход со старой кнопки
  bot.action(/^lk_intern_progress_stub_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      await showPerformanceHome(ctx, candidateId);
    } catch (e) {
      logError("lk_intern_progress_stub_x", e);
    }
  });

  bot.action(/^lk_perf_home_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      await showPerformanceHome(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_home_x", e);
    }
  });

  bot.action(/^lk_perf_tests_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      await showTestsStub(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_tests_x", e);
    }
  });

  bot.action(/^lk_perf_attest_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      await showAttestMenu(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_attest_x", e);
    }
  });

  bot.action(/^lk_perf_attest_default_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      await showDefaultStub(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_attest_default_x", e);
    }
  });

  bot.action(/^lk_perf_attest_do_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      const candidateId = Number(ctx.match[1]);
      const itemId = Number(ctx.match[2]);
      await showAttestDo(ctx, mentor, candidateId, itemId);
    } catch (e) {
      logError("lk_perf_attest_do_x", e);
    }
  });

  bot.action(/^lk_perf_attest_mark_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      const candidateId = Number(ctx.match[1]);
      const itemId = Number(ctx.match[2]);
      await markAttestPassed(ctx, mentor, candidateId, itemId);
      await showAttestMenu(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_attest_mark_x", e);
    }
  });

  bot.action(/^lk_perf_attest_change_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      const candidateId = Number(ctx.match[1]);
      const itemId = Number(ctx.match[2]);

      const item = await getAttestItem(itemId);
      if (!item) return;

      const kindLabel = item.item_type === "video" ? "видео" : "фото";
      await safeEdit(
        ctx,
        `🏅 ${item.title}\n\nПришлите новое ${kindLabel} одним сообщением.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "⬅️ Назад",
              `lk_perf_attest_do_${candidateId}_${itemId}`
            ),
          ],
        ])
      );

      setState(ctx.from.id, {
        kind: "attest_file",
        candidateId,
        itemId,
        itemType: item.item_type,
      });
    } catch (e) {
      logError("lk_perf_attest_change_x", e);
    }
  });

  // теория кнопки
  bot.action(/^lk_perf_theory_(\d+)_(basic|adv)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      const candidateId = Number(ctx.match[1]);
      const lvl = ctx.match[2] === "basic" ? "basic" : "advanced";
      await startTheoryTopics(ctx, candidateId, lvl);
    } catch (e) {
      logError("lk_perf_theory_x", e);
    }
  });

  bot.action(
    /^lk_perf_theory_topic_(\d+)_(basic|advanced)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        clearState(ctx.from.id);
        const mentor = await ensureUser(ctx);
        const candidateId = Number(ctx.match[1]);
        const level = ctx.match[2];
        const topicId = Number(ctx.match[3]);
        await showTheoryTopicEntry(ctx, mentor, candidateId, level, topicId);
      } catch (e) {
        logError("lk_perf_theory_topic_x", e);
      }
    }
  );

  bot.action(
    /^lk_perf_theory_start_(\d+)_(basic|advanced)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const mentor = await ensureUser(ctx);
        const candidateId = Number(ctx.match[1]);
        const level = ctx.match[2];
        const topicId = Number(ctx.match[3]);
        await startTheoryTest(ctx, mentor, candidateId, level, topicId);
      } catch (e) {
        logError("lk_perf_theory_start_x", e);
      }
    }
  );

  bot.action(/^lk_perf_theory_ans_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      const sessionId = Number(ctx.match[1]);
      const ok = ctx.match[2] === "1";
      await recordTheoryAnswer(ctx, mentor, sessionId, ok);
    } catch (e) {
      logError("lk_perf_theory_ans_x", e);
    }
  });

  bot.action(/^lk_perf_theory_finish_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      const sessionId = Number(ctx.match[1]);
      const passed = ctx.match[2] === "1";
      await finishTheorySession(ctx, mentor, sessionId, passed);
    } catch (e) {
      logError("lk_perf_theory_finish_x", e);
    }
  });

  // Приём файлов для элемента аттестации (фото/видео) от наставника
  bot.on(["photo", "video"], async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st || st.kind !== "attest_file") return next();

    const mentor = await ensureUser(ctx);
    const { candidateId, itemId, itemType } = st;

    // принять файл
    let fileId = null;
    let fileType = null;

    if (ctx.message.photo && ctx.message.photo.length) {
      if (itemType !== "photo") {
        await ctx.reply(
          "Ожидается видео, а вы отправили фото. Отправьте видео."
        );
        return;
      }
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      fileType = "photo";
    }

    if (ctx.message.video) {
      if (itemType !== "video") {
        await ctx.reply(
          "Ожидается фото, а вы отправили видео. Отправьте фото."
        );
        return;
      }
      fileId = ctx.message.video.file_id;
      fileType = "video";
    }

    if (!fileId) return;

    await pool.query(
      `INSERT INTO user_attestation_status
         (user_id, item_id, status, updated_by_admin_id, checked_by, updated_at,
          submission_file_id, submission_file_type, submitted_at, submitted_by)
       VALUES ($1,$2,'passed',$3,$3,now(), $4,$5, now(), $3)
       ON CONFLICT (user_id,item_id)
       DO UPDATE SET
         status='passed',
         updated_by_admin_id=$3,
         checked_by=$3,
         updated_at=now(),
         submission_file_id=$4,
         submission_file_type=$5,
         submitted_at=now(),
         submitted_by=$3`,
      [candidateId, itemId, mentor.id, fileId, fileType]
    );

    clearState(ctx.from.id);
    await showAttestMenu(ctx, candidateId);
  });
}

module.exports = registerPerformance;
