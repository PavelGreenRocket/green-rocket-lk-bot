// src/bot/admin/users/performance.js
// ЛК наставника: успеваемость стажёра (группы аттестации + элементы + теория тестирование)

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// state: waiting for file or theory test
const states = new Map();
const setState = (tgId, s) => states.set(tgId, s);
const getState = (tgId) => states.get(tgId);
const clearState = (tgId) => states.delete(tgId);

async function safeEdit(ctx, text, keyboard) {
  const extra = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;
  try {
    if (ctx.callbackQuery?.message) {
      return await ctx.editMessageText(text, { parse_mode: "HTML", ...extra });
    }
    return await ctx.reply(text, { parse_mode: "HTML", ...extra });
  } catch {
    return await ctx.reply(text, { parse_mode: "HTML", ...extra });
  }
}

// ---- candidate brief (candidateId) + optional username (from linked users) ----
async function getCandidateBrief(candidateId) {
  const cRes = await pool.query(
    `SELECT id, name, age, phone
     FROM candidates
     WHERE id=$1`,
    [candidateId]
  );
  const cand = cRes.rows[0];
  if (!cand)
    return { id: candidateId, name: `ID ${candidateId}`, username: "" };

  // try to find linked LK user (last known) to show username
  const uRes = await pool.query(
    `SELECT u.username
     FROM internship_schedules s
     JOIN users u ON u.id = s.user_id
     WHERE s.candidate_id=$1 AND s.user_id IS NOT NULL
     ORDER BY s.id DESC
     LIMIT 1`,
    [candidateId]
  );
  const username = uRes.rows[0]?.username ? `@${uRes.rows[0].username}` : "";

  const agePart = cand.age ? ` (${cand.age})` : "";
  const phonePart = cand.phone ? ` ${cand.phone}` : "";
  return {
    id: cand.id,
    name: `${cand.name || "—"}${agePart}${phonePart}`,
    username,
  };
}

// ---- groups + items ----
async function ensureDefaultGroupAndItems() {
  // ensure group1
  const g = await pool.query(
    `SELECT id FROM attestation_groups ORDER BY order_index, id LIMIT 1`
  );
  let groupId = g.rows[0]?.id;
  if (!groupId) {
    const ins = await pool.query(
      `INSERT INTO attestation_groups(title, reward_text, order_index, is_active)
       VALUES ('группа 1', NULL, 0, TRUE)
       RETURNING id`
    );
    groupId = ins.rows[0].id;
  }

  const defaults = [
    { title: "📖 техкарта", order_index: 1, item_type: "normal" },
    { title: "📘 теория база", order_index: 2, item_type: "normal" },
    { title: "📕 теория продвинутый", order_index: 3, item_type: "normal" },
    {
      title: "🗣️ Коммуникация с клиентами",
      order_index: 4,
      item_type: "normal",
    },
    { title: "🌱 курс стажировки", order_index: 5, item_type: "normal" },
  ];

  for (const d of defaults) {
    // eslint-disable-next-line no-await-in-loop
    const ex = await pool.query(
      `SELECT id FROM attestation_items WHERE title=$1 LIMIT 1`,
      [d.title]
    );
    if (!ex.rows[0]) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO attestation_items(title, description, order_index, is_active, is_default, item_type, group_id)
         VALUES ($1,NULL,$2,TRUE,TRUE,$3,$4)`,
        [d.title, d.order_index, d.item_type, groupId]
      );
    }
  }

  // attach existing items without group to group1
  await pool
    .query(`UPDATE attestation_items SET group_id=$1 WHERE group_id IS NULL`, [
      groupId,
    ])
    .catch(() => {});
}

async function fetchGroupsActive() {
  const r = await pool.query(
    `SELECT id, title, reward_text, order_index
     FROM attestation_groups
     WHERE COALESCE(is_active,true)=true
     ORDER BY order_index, id`
  );
  return r.rows;
}

async function fetchGroup(groupId) {
  const r = await pool.query(
    `SELECT id, title, reward_text, order_index, COALESCE(is_active,true) AS is_active
     FROM attestation_groups WHERE id=$1`,
    [groupId]
  );
  return r.rows[0] || null;
}

async function fetchItemsByGroup(groupId) {
  const r = await pool.query(
    `SELECT id, title, description, order_index, is_active,
            COALESCE(is_default,false) AS is_default,
            COALESCE(item_type,'normal') AS item_type,
            example_file_id, example_file_type
     FROM attestation_items
     WHERE group_id=$1 AND is_active=TRUE
     ORDER BY order_index, id`,
    [groupId]
  );
  return r.rows;
}

async function fetchUserAttestationStatuses(candidateId) {
  const r = await pool.query(
    `SELECT item_id, status, updated_at, checked_by, updated_by_admin_id,
            submission_file_id, submission_file_type, submitted_at, submitted_by
     FROM user_attestation_status
     WHERE user_id=$1`,
    [candidateId]
  );
  const map = new Map();
  for (const row of r.rows) map.set(Number(row.item_id), row);
  return map;
}

// theory helpers (existing model in DB)
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
  // mode: mentor_basic / mentor_adv
  const r = await pool.query(
    `SELECT DISTINCT ON (topic_id)
       topic_id, passed, checked_by, checked_at
     FROM test_sessions
     WHERE user_id=$1 AND mode=$2
     ORDER BY topic_id, checked_at DESC NULLS LAST, id DESC`,
    [candidateId, mode]
  );
  const map = new Map();
  for (const row of r.rows) map.set(Number(row.topic_id), row);
  return map;
}

function itemPercent(itTitle, statusesMap, basicPct, advPct, internshipPct) {
  if (itTitle.includes("теория база")) return basicPct;
  if (itTitle.includes("теория продвинутый")) return advPct;
  if (itTitle.includes("курс стажировки")) return internshipPct;
  const st = statusesMap.get ? statusesMap.get : (id) => statusesMap.get(id);
  return 0;
}

async function getInternshipOverallPercent(candidateId) {
  // get linked user_id
  const candRes = await pool.query(
    `SELECT s.user_id
     FROM internship_schedules s
     WHERE s.candidate_id=$1 AND s.user_id IS NOT NULL
     ORDER BY s.id DESC
     LIMIT 1`,
    [candidateId]
  );
  const userId = candRes.rows[0]?.user_id;
  if (!userId) return 0;
  const totalStepsRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM internship_steps`
  );
  const totalSteps = totalStepsRes.rows[0]?.cnt || 0;
  if (!totalSteps) return 0;
  const passedAllRes = await pool.query(
    `
    SELECT COUNT(DISTINCT r.step_id)::int AS cnt
    FROM internship_step_results r
    JOIN internship_sessions s ON s.id = r.session_id
    WHERE s.user_id = $1
      AND s.is_canceled = FALSE
      AND r.is_passed = TRUE
    `,
    [userId]
  );
  const passedAll = passedAllRes.rows[0]?.cnt || 0;
  return Math.round((passedAll / totalSteps) * 100);
}

// ---- main screens ----
async function showPerformanceHome(ctx, candidateId) {
  await ensureDefaultGroupAndItems();

  const user = await getCandidateBrief(candidateId);

  const groups = await fetchGroupsActive();
  const statuses = await fetchUserAttestationStatuses(candidateId);

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

  const internshipPct = await getInternshipOverallPercent(candidateId);

  const header =
    `📊 <b>Успеваемость</b>\n\n` +
    `<b>имя:</b> ${user.name}${user.username ? `\n${user.username}` : ""}\n\n` +
    `Здесь можно отслеживать <b>KPI</b>, <b>активность</b> пользователя и проводить <b>аттестацию</b>\n\n` +
    `<u>🏅 <b>→</b> это группы которые относится\n к повышению квалификации.</u>\n` +
    `•   <b>За выполнение</b> каждой группы обычно прилагаются <b>доп. выплаты</b>\n\n` 

  const rows = [];
  for (const g of groups) {
    // progress in group
    const items = await fetchItemsByGroup(g.id);
    const total = items.length || 0;
    let completed = 0;
    let sumPct = 0;
    for (const it of items) {
      let pct = 0;
      if (it.title.includes("теория база")) pct = basicPct;
      else if (it.title.includes("теория продвинутый")) pct = advPct;
      else if (it.title.includes("курс стажировки")) pct = internshipPct;
      else {
        const st = statuses.get(Number(it.id));
        pct = st?.status === "passed" ? 100 : 0;
      }
      if (pct >= 100) completed += 1;
      sumPct += pct;
    }
    const pctGroup = total ? Math.round(sumPct / total) : 0;
    const doneMark = total && completed === total ? "✅ " : "";
    rows.push([
      Markup.button.callback(
        `${doneMark}🏅 ${g.title} ${completed}/${total} (${pctGroup}%)`,
        `lk_perf_attest_group_${candidateId}_${g.id}`
      ),
    ]);
  }
  rows.push([Markup.button.callback("📋 KPI (по работе)", `lk_perf_kpi_${candidateId}`)]);
  rows.push([
    Markup.button.callback("📊 Тесты (проверь активность)", `lk_perf_tests_${candidateId}`),
  ]);
  rows.push([
    // возвращаемся в карточку стажёра (тот же колбэк, что и в candidateCard.js)
    Markup.button.callback(
      "⬅️ Назад к карточке",
      `lk_cards_switch_trainee_${candidateId}`
    ),
  ]);

  return safeEdit(ctx, header, Markup.inlineKeyboard(rows));
}

async function showTestsStub(ctx, candidateId) {
  return safeEdit(
    ctx,
    "📊 Тесты\n\nВ разработке.",
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`)],
    ])
  );
}

async function showKpiStub(ctx, candidateId) {
  return safeEdit(
    ctx,
    "📋 KPI\n\nВ разработке.",
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`)],
    ])
  );
}

async function showGroupItemsScreen(ctx, candidateId, groupId) {
  await ensureDefaultGroupAndItems();

  const user = await getCandidateBrief(candidateId);
  const g = await fetchGroup(groupId);
  if (!g) return;

  const items = await fetchItemsByGroup(groupId);
  const statuses = await fetchUserAttestationStatuses(candidateId);

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
  const internshipPct = await getInternshipOverallPercent(candidateId);

  const reward = g.reward_text ? g.reward_text : "—";

  const text =
    `🏅 <b>Элементы аттестации</b>\n\n` +
    `${user.name}${user.username ? `\n${user.username}` : ""}\n\n` +
    `💰 Вознаграждение за выполнение: ${reward}`;

  const rows = [];
  for (const it of items) {
    let icon = "⚪";
    let pct = 0;
    if (it.title.includes("теория база")) {
      pct = basicPct;
      icon = pct === 100 ? "✅" : "⚪";
      rows.push([
        Markup.button.callback(
          `${icon} ${it.title} (${pct}%)`,
          `lk_perf_theory_${candidateId}_basic`
        ),
      ]);
      continue;
    }
    if (it.title.includes("теория продвинутый")) {
      pct = advPct;
      icon = pct === 100 ? "✅" : "⚪";
      rows.push([
        Markup.button.callback(
          `${icon} ${it.title} (${pct}%)`,
          `lk_perf_theory_${candidateId}_adv`
        ),
      ]);
      continue;
    }
    if (it.title.includes("курс стажировки")) {
      pct = internshipPct;
      icon = pct === 100 ? "✅" : "⚪";
      // must keep existing implementation
      rows.push([
        Markup.button.callback(
          `${icon} ${it.title} (${pct}%)`,
          `lk_internship_data_${candidateId}`
        ),
      ]);
      continue;
    }

    const st = statuses.get(Number(it.id));
    icon = st?.status === "passed" ? "✅" : "⚪";
    pct = st?.status === "passed" ? 100 : 0;
    rows.push([
      Markup.button.callback(
        `${icon} ${it.title} (${pct}%)`,
        `lk_perf_attest_do_${candidateId}_${it.id}`
      ),
    ]);
  }
  rows.push([
    Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`),
  ]);

  return safeEdit(ctx, text, Markup.inlineKeyboard(rows));
}

// ---- attest item execution ----
async function getAttestItem(itemId) {
  const r = await pool.query(
    `SELECT id, title, description, COALESCE(item_type,'normal') AS item_type,
            example_file_id, example_file_type
     FROM attestation_items WHERE id=$1`,
    [itemId]
  );
  return r.rows[0] || null;
}

async function getUserAttestStatus(candidateId, itemId) {
  const r = await pool.query(
    `SELECT status, updated_at, checked_by, submission_file_id, submission_file_type, submitted_at, submitted_by
     FROM user_attestation_status WHERE user_id=$1 AND item_id=$2 LIMIT 1`,
    [candidateId, itemId]
  );
  return r.rows[0] || null;
}

async function upsertUserAttest(candidateId, itemId, mentorId, patch) {
  // patch: { status?, fileId?, fileType?, submitted? }
  const status = patch.status || "not_passed";
  const fileId = patch.fileId || null;
  const fileType = patch.fileType || null;
  const submittedAt = patch.submittedAt || null;
  const submittedBy = patch.submittedBy || null;

  // try new columns; if migration not applied yet, fall back
  try {
    await pool.query(
      `
      INSERT INTO user_attestation_status(user_id, item_id, status, updated_by_admin_id, checked_by, updated_at,
        submission_file_id, submission_file_type, submitted_at, submitted_by)
      VALUES ($1,$2,$3,$4,$4,now(),$5,$6,$7,$8)
      ON CONFLICT (user_id, item_id)
      DO UPDATE SET
        status=EXCLUDED.status,
        updated_by_admin_id=EXCLUDED.updated_by_admin_id,
        checked_by=EXCLUDED.checked_by,
        updated_at=now(),
        submission_file_id=EXCLUDED.submission_file_id,
        submission_file_type=EXCLUDED.submission_file_type,
        submitted_at=EXCLUDED.submitted_at,
        submitted_by=EXCLUDED.submitted_by
      `,
      [
        candidateId,
        itemId,
        status,
        mentorId,
        fileId,
        fileType,
        submittedAt,
        submittedBy,
      ]
    );
  } catch {
    await pool.query(
      `
      INSERT INTO user_attestation_status(user_id, item_id, status, updated_by_admin_id, checked_by, updated_at)
      VALUES ($1,$2,$3,$4,$4,now())
      ON CONFLICT (user_id, item_id)
      DO UPDATE SET status=EXCLUDED.status, updated_by_admin_id=EXCLUDED.updated_by_admin_id, checked_by=EXCLUDED.checked_by, updated_at=now()
      `,
      [candidateId, itemId, status, mentorId]
    );
  }
}

async function showAttestDo(ctx, candidateId, itemId, { edit = true } = {}) {
  const it = await getAttestItem(itemId);
  if (!it) return;

  const st = await getUserAttestStatus(candidateId, itemId);
  const passed = st?.status === "passed";

  let text =
    `🏅 <b>${it.title}</b>\n\n` +
    (it.description ? `${it.description}\n\n` : "");

  // If already submitted file for video/photo: show info + replace
  if (it.item_type === "video" || it.item_type === "photo") {
    if (st?.submission_file_id) {
      text += `Файл уже отправлен ✅\n`;
      if (st.submitted_at)
        text += `Дата: ${new Date(st.submitted_at).toLocaleString("ru-RU")}\n`;
      if (st.submitted_by) text += `Кто прислал: ${st.submitted_by}\n`;
    } else {
      text += it.item_type === "video" ? "Пришлите видео." : "Пришлите фото.";
    }
  }

  const rows = [];

  if (it.item_type === "normal") {
    rows.push([
      Markup.button.callback(
        "✅ Пометить: сдал",
        `lk_perf_attest_mark_${candidateId}_${itemId}`
      ),
    ]);
  } else {
    // show example if exists
    if (it.example_file_id) {
      rows.push([
        Markup.button.callback(
          "🧩 Пример",
          `lk_perf_attest_example_${candidateId}_${itemId}`
        ),
      ]);
    }
    if (st?.submission_file_id) {
      rows.push([
        Markup.button.callback(
          "🔁 Поменять",
          `lk_perf_attest_change_${candidateId}_${itemId}`
        ),
      ]);
    }
  }

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `lk_perf_attest_back_${candidateId}_${itemId}`
    ),
  ]);

  const kb = Markup.inlineKeyboard(rows);
  if (edit) return safeEdit(ctx, text, kb);
  return ctx.reply(text, { parse_mode: "HTML", ...kb });
}

async function markAttestPassed(ctx, candidateId, itemId, mentor) {
  await upsertUserAttest(candidateId, itemId, mentor.id, { status: "passed" });
  return showPerformanceHome(ctx, candidateId);
}

// show example media
async function showExample(ctx, candidateId, itemId) {
  const it = await getAttestItem(itemId);
  if (!it?.example_file_id) return;
  if (it.example_file_type === "video") {
    await ctx.replyWithVideo(it.example_file_id).catch(() => {});
  } else if (it.example_file_type === "photo") {
    await ctx.replyWithPhoto(it.example_file_id).catch(() => {});
  }
  return showAttestDo(ctx, candidateId, itemId, { edit: false });
}

// ---- theory testing (kept from previous implementation) ----
async function startTheoryTopics(ctx, candidateId, level) {
  const topics = await fetchTheoryTopicsWithCards(
    level === "basic" ? "basic" : "advanced"
  );
  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";
  const latest = await fetchLatestTopicResults(candidateId, mode);

  const user = await getCandidateBrief(candidateId);

  const rows = [];
  for (const t of topics) {
    const res = latest.get(Number(t.id));
    const mark = res ? (res.passed ? "✅" : "❌") : "⚪";
    const by = res?.checked_by ? ` (${res.checked_by})` : "";
    const date = res?.checked_at
      ? `, ${new Date(res.checked_at).toLocaleDateString("ru-RU")}`
      : "";
    const suffix = res ? `${by}${date}` : "";
    rows.push([
      Markup.button.callback(
        `${mark} ${t.title}${suffix}`,
        `lk_perf_theory_topic_${candidateId}_${level}_${t.id}`
      ),
    ]);
  }
  rows.push([
    Markup.button.callback("⬅️ Назад", `lk_perf_home_${candidateId}`),
  ]);

  const title =
    level === "basic" ? "📘 Теория (база)" : "📕 Теория (продвинутый)";
  const text = `${title}\n\n${user.name}${
    user.username ? `\n${user.username}` : ""
  }\n\nВыберите тему:`;
  return safeEdit(ctx, text, Markup.inlineKeyboard(rows));
}

async function showTheoryTopicEntry(ctx, candidateId, level, topicId) {
  const topicRes = await pool.query(
    `SELECT id, title FROM topics WHERE id=$1`,
    [topicId]
  );
  const topic = topicRes.rows[0];
  if (!topic) return;

  const rows = [
    [
      Markup.button.callback(
        "▶️ Перейти к тестированию",
        `lk_perf_theory_start_${candidateId}_${level}_${topicId}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Назад",
        `lk_perf_theory_${candidateId}_${level === "basic" ? "basic" : "adv"}`
      ),
    ],
  ];
  const text = `Тема: <b>${topic.title}</b>\n\nПерейти к тестированию?`;
  return safeEdit(ctx, text, Markup.inlineKeyboard(rows));
}

async function startTheoryTest(ctx, candidateId, level, topicId, mentor) {
  // collect up to 50 random cards across blocks of topic with difficulty filter
  const diffClause =
    level === "basic" ? "c.difficulty = 1" : "c.difficulty IN (2,3)";
  const cardsRes = await pool.query(
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
  const cardIds = cardsRes.rows.map((x) => Number(x.id));
  if (!cardIds.length) {
    return safeEdit(
      ctx,
      "В этой теме пока нет вопросов для тестирования.",
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

  const mode = level === "basic" ? "mentor_basic" : "mentor_adv";
  const sess = await pool.query(
    `INSERT INTO test_sessions(user_id, topic_id, mode, started_at, checked_by)
     VALUES ($1,$2,$3,now(),$4) RETURNING id`,
    [
      candidateId,
      topicId,
      mode,
      mentor.full_name || mentor.username || String(mentor.id),
    ]
  );
  const sessionId = sess.rows[0].id;

  // save session cards
  for (let i = 0; i < cardIds.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO test_session_cards(session_id, card_id, order_index) VALUES ($1,$2,$3)`,
      [sessionId, cardIds[i], i]
    );
  }

  setState(ctx.from.id, {
    kind: "theory_test",
    sessionId,
    idx: 0,
    total: cardIds.length,
    candidateId,
    level,
  });
  return showTheoryQuestion(ctx, sessionId, 0);
}

async function showTheoryQuestion(ctx, sessionId, index) {
  const q = await pool.query(
    `
    SELECT c.question, c.answer, c.hint, c.id AS card_id
    FROM test_session_cards sc
    JOIN cards c ON c.id = sc.card_id
    WHERE sc.session_id=$1
    ORDER BY sc.order_index
    OFFSET $2 LIMIT 1
    `,
    [sessionId, index]
  );
  const row = q.rows[0];
  if (!row) return;

  const text =
    `⭐️ Вопрос ${index + 1}\n\n` +
    `❓ ${row.question || ""}\n\n` +
    `💡 Ответ:\n${row.answer || ""}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Верно", `lk_perf_theory_ans_${sessionId}_1`),
      Markup.button.callback("❌ Неверно", `lk_perf_theory_ans_${sessionId}_0`),
    ],
  ]);
  return safeEdit(ctx, text, kb);
}

async function recordTheoryAnswer(sessionId, isCorrect) {
  const stRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM test_session_answers WHERE session_id=$1`,
    [sessionId]
  );
  const idx = stRes.rows[0]?.cnt || 0;

  const cardRes = await pool.query(
    `SELECT card_id FROM test_session_cards WHERE session_id=$1 ORDER BY order_index OFFSET $2 LIMIT 1`,
    [sessionId, idx]
  );
  const cardId = cardRes.rows[0]?.card_id;
  if (!cardId) return { done: true };

  await pool.query(
    `INSERT INTO test_session_answers(session_id, card_id, is_correct) VALUES ($1,$2,$3)`,
    [sessionId, cardId, isCorrect]
  );

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM test_session_cards WHERE session_id=$1`,
    [sessionId]
  );
  const total = totalRes.rows[0]?.cnt || 0;
  const nextIdx = idx + 1;
  return { done: nextIdx >= total, nextIdx, total };
}

async function finishTheorySession(ctx, sessionId, passed, mentorName) {
  await pool.query(
    `UPDATE test_sessions
     SET finished_at=now(), checked_at=now(), passed=$2, checked_by=$3
     WHERE id=$1`,
    [sessionId, passed, mentorName]
  );
  const sess = await pool.query(
    `SELECT user_id, topic_id, mode FROM test_sessions WHERE id=$1`,
    [sessionId]
  );
  const row = sess.rows[0];
  if (!row) return;
  const level = row.mode === "mentor_basic" ? "basic" : "adv";
  const candidateId = Number(row.user_id);
  return startTheoryTopics(ctx, candidateId, level);
}

// ---- register ----
function registerPerformance(bot, ensureUser, logError) {
  // entry from candidate card
  bot.action(/^lk_perf_home_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      await showPerformanceHome(ctx, candId);
    } catch (e) {
      logError("lk_perf_home_x", e);
    }
  });

  bot.action(/^lk_perf_tests_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showTestsStub(ctx, Number(ctx.match[1]));
    } catch (e) {
      logError("lk_perf_tests_x", e);
    }
  });

  bot.action(/lk_perf_menu_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);
      // По ТЗ: сразу показываем группы аттестаций + KPI/Тесты (без отдельной кнопки "аттестация")
      await showPerformanceHome(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_menu_x", e);
    }
  });

  bot.action(/^lk_perf_kpi_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showKpiStub(ctx, Number(ctx.match[1]));
    } catch (e) {
      logError("lk_perf_kpi_x", e);
    }
  });

  bot.action(/^lk_perf_attest_group_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showGroupItemsScreen(
        ctx,
        Number(ctx.match[1]),
        Number(ctx.match[2])
      );
    } catch (e) {
      logError("lk_perf_attest_group_x", e);
    }
  });

  // attest normal / media
  bot.action(/^lk_perf_attest_do_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showAttestDo(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
    } catch (e) {
      logError("lk_perf_attest_do_x", e);
    }
  });

  bot.action(/^lk_perf_attest_back_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      await showPerformanceHome(ctx, candId);
    } catch (e) {
      logError("lk_perf_attest_back_x", e);
    }
  });

  bot.action(/^lk_perf_attest_mark_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      const itemId = Number(ctx.match[2]);
      const mentor = await ensureUser(ctx);
      await markAttestPassed(ctx, candId, itemId, mentor);
    } catch (e) {
      logError("lk_perf_attest_mark_x", e);
    }
  });

  bot.action(/^lk_perf_attest_example_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showExample(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
    } catch (e) {
      logError("lk_perf_attest_example_x", e);
    }
  });

  bot.action(/^lk_perf_attest_change_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      const itemId = Number(ctx.match[2]);
      const it = await getAttestItem(itemId);
      if (!it) return;
      setState(ctx.from.id, {
        kind: "attest_file",
        candidateId: candId,
        itemId,
        expected: it.item_type,
      });
      await safeEdit(
        ctx,
        it.item_type === "video"
          ? "Пришлите новое видео одним сообщением."
          : "Пришлите новое фото одним сообщением.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "⬅️ Назад",
              `lk_perf_attest_do_${candId}_${itemId}`
            ),
          ],
        ])
      );
    } catch (e) {
      logError("lk_perf_attest_change_x", e);
    }
  });

  // receive file
  bot.on(["video", "photo"], async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st || st.kind !== "attest_file") return next();
    try {
      const mentor = await ensureUser(ctx);
      const { candidateId, itemId, expected } = st;
      let fileId = null,
        fileType = null;
      if (ctx.message.video) {
        if (expected !== "video") return ctx.reply("Ожидается фото.");
        fileId = ctx.message.video.file_id;
        fileType = "video";
      } else if (ctx.message.photo) {
        if (expected !== "photo") return ctx.reply("Ожидается видео.");
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        fileType = "photo";
      }
      await upsertUserAttest(candidateId, itemId, mentor.id, {
        status: "passed",
        fileId,
        fileType,
        submittedAt: new Date(),
        submittedBy: mentor.full_name || mentor.username || String(mentor.id),
      });
      clearState(ctx.from.id);
      await showPerformanceHome(ctx, candidateId);
    } catch (e) {
      logError("lk_perf_attest_file", e);
      clearState(ctx.from.id);
    }
  });

  // theory menus
  bot.action(/^lk_perf_theory_(\d+)_(basic|adv)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      const lvl = ctx.match[2] === "basic" ? "basic" : "advanced";
      await startTheoryTopics(ctx, candId, lvl === "basic" ? "basic" : "adv");
    } catch (e) {
      logError("lk_perf_theory_x", e);
    }
  });

  bot.action(/^lk_perf_theory_(\d+)_basic$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startTheoryTopics(ctx, Number(ctx.match[1]), "basic");
    } catch (e) {
      logError("lk_perf_theory_basic_x", e);
    }
  });
  bot.action(/^lk_perf_theory_(\d+)_adv$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await startTheoryTopics(ctx, Number(ctx.match[1]), "adv");
    } catch (e) {
      logError("lk_perf_theory_adv_x", e);
    }
  });

  bot.action(/^lk_perf_theory_topic_(\d+)_(basic|adv)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showTheoryTopicEntry(
        ctx,
        Number(ctx.match[1]),
        ctx.match[2],
        Number(ctx.match[3])
      );
    } catch (e) {
      logError("lk_perf_theory_topic_x", e);
    }
  });

  bot.action(/^lk_perf_theory_start_(\d+)_(basic|adv)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mentor = await ensureUser(ctx);
      await startTheoryTest(
        ctx,
        Number(ctx.match[1]),
        ctx.match[2],
        Number(ctx.match[3]),
        mentor
      );
    } catch (e) {
      logError("lk_perf_theory_start_x", e);
    }
  });

  bot.action(/^lk_perf_theory_ans_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = Number(ctx.match[1]);
      const isCorrect = ctx.match[2] === "1";
      const r = await recordTheoryAnswer(sessionId, isCorrect);
      if (r.done) {
        await safeEdit(
          ctx,
          "Тестирование завершено.\n\nОтметь результат:",
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Сдано",
                `lk_perf_theory_finish_${sessionId}_1`
              ),
            ],
            [
              Markup.button.callback(
                "❌ Не сдано",
                `lk_perf_theory_finish_${sessionId}_0`
              ),
            ],
          ])
        );
      } else {
        await showTheoryQuestion(ctx, sessionId, r.nextIdx);
      }
    } catch (e) {
      logError("lk_perf_theory_ans_x", e);
    }
  });

  bot.action(/^lk_perf_theory_finish_(\d+)_(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const sessionId = Number(ctx.match[1]);
      const passed = ctx.match[2] === "1";
      const mentor = await ensureUser(ctx);
      const mentorName =
        mentor.full_name || mentor.username || String(mentor.id);
      await finishTheorySession(ctx, sessionId, passed, mentorName);
    } catch (e) {
      logError("lk_perf_theory_finish_x", e);
    }
  });
}

module.exports = registerPerformance;
