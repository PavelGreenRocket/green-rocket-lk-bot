// src/bot/admin/users/candidateList.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { deliver } = require("../../../utils/renderHelpers");
const { showCandidateCardLk } = require("./candidateCard");

// Фильтры вынесены в отдельный модуль
const {
  getCandidateFilters,
  setCandidateFilters,
  resetCandidateFilters,
} = require("./candidateFilters");
const { registerCandidateEditHandlers } = require("./candidateEdit");
const declineReasonStates = new Map(); // key: tgId, value: { candidateId }
const restoreModeStates = new Map();
const historyCandidatesFilter = new Map();

// ✅ Геттер restore-mode для candidateEdit.js
function isRestoreModeFor(tgId, candidateId) {
  return restoreModeStates.get(tgId) === candidateId;
}
// key: tgId -> value: 'invited' | 'interviewed' | 'internship_invited' | null

// ----------------------------------------
// СОСТОЯНИЕ РЕДАКТИРОВАНИЯ СОТРУДНИКОВ
// ----------------------------------------

const workerEditStates = new Map();

function getWorkerEditState(tgId) {
  return workerEditStates.get(tgId) || null;
}

function setWorkerEditState(tgId, state) {
  workerEditStates.set(tgId, state);
}

function clearWorkerEditState(tgId) {
  workerEditStates.delete(tgId);
}

// ----------------------------------------
// СОЗДАНИЕ СОТРУДНИКА (wizard) — состояние по tg_id
// ----------------------------------------

const addWorkerStates = new Map(); // tgId -> { step, data... }

function getAddWorkerState(tgId) {
  return addWorkerStates.get(tgId) || null;
}
function setAddWorkerState(tgId, patch) {
  const cur = addWorkerStates.get(tgId) || {};
  addWorkerStates.set(tgId, { ...cur, ...patch });
}
function clearAddWorkerState(tgId) {
  addWorkerStates.delete(tgId);
}

// alias для старых вставок: раньше в ответах называли это getState()
// чтобы не падал bot.on("text") после частичных патчей
function getState(tgId) {
  return getAddWorkerState(tgId);
}

function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return s;
}

function phoneForTelegram(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  // оставляем только цифры и "+"
  let cleaned = s.replace(/[^\d+]/g, "");

  // 8XXXXXXXXXX -> +7XXXXXXXXXX
  if (/^8\d{10}$/.test(cleaned)) cleaned = "+7" + cleaned.slice(1);

  // 7XXXXXXXXXX -> +7XXXXXXXXXX
  if (/^7\d{10}$/.test(cleaned)) cleaned = "+7" + cleaned.slice(1);

  return cleaned;
}

// ----------------------------------------
// СОСТОЯНИЕ "РАСКРЫТА КАРТОЧКА" ДЛЯ СОТРУДНИКОВ
// ----------------------------------------

const workerCardsExpanded = new Map(); // key: tgId -> Set(workerId)

function isWorkerCardExpanded(tgId, workerId) {
  const set = workerCardsExpanded.get(tgId);
  return set ? set.has(workerId) : false;
}

function toggleWorkerCardExpanded(tgId, workerId) {
  let set = workerCardsExpanded.get(tgId);
  if (!set) {
    set = new Set();
    workerCardsExpanded.set(tgId, set);
  }
  if (set.has(workerId)) set.delete(workerId);
  else set.add(workerId);
}

// ----------------------------------------
// ХЕЛПЕРЫ ФОРМАТИРОВАНИЯ
// ----------------------------------------

const WEEK_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function getStatusIcon(status) {
  switch (status) {
    case "invited":
      return "🕒";
    case "interviewed":
      return "✔️";
    case "internship_invited":
      return "☑️";
    case "cancelled":
    case "rejected":
      return "❌";
    default:
      return "🕒";
  }
}

// 07.12 на 11:00 (ср)
function formatDateTimeShort(isoDate, timeStr) {
  if (!isoDate && !timeStr) return "не указана";

  let date = null;

  if (isoDate instanceof Date) {
    date = isoDate;
  } else if (typeof isoDate === "string") {
    const parts = isoDate.split("-");
    if (parts.length === 3) {
      const [y, m, d] = parts.map((x) => parseInt(x, 10));
      if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
        date = new Date(y, m - 1, d);
      }
    }
  }

  let datePart = "";
  let weekdayPart = "";

  if (date && !Number.isNaN(date.getTime())) {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    datePart = `${dd}.${mm}`;
    weekdayPart = WEEK_DAYS[date.getDay()];
  }

  let result = "";
  if (datePart) result += datePart;
  if (timeStr) result += (result ? " на " : "") + timeStr;
  if (weekdayPart) result += ` (${weekdayPart})`;
  return result || "не указана";
}

// ----------------------------------------
// ЗАГРУЗКА КАНДИДАТОВ ИЗ БД
// ----------------------------------------

async function loadCandidatesForAdmin(user, filters) {
  const statuses = [];

  if (filters.waiting) statuses.push("invited");
  if (filters.arrived) statuses.push("interviewed");
  if (filters.internshipInvited) statuses.push("internship_invited");
  if (filters.cancelled) statuses.push("cancelled", "rejected");

  if (!statuses.length) {
    statuses.push("invited", "interviewed", "internship_invited");
  }

  const params = [statuses];
  let where = "c.status = ANY($1)";

  if (filters.scope === "personal") {
    params.push(user.id);
    where += " AND c.admin_id = $2";
  }

  if (!filters.cancelled) {
    where += " AND c.status <> 'cancelled' AND c.status <> 'rejected'";
  }

  const res = await pool.query(
    `
      SELECT
  c.id,
  c.name,
  c.age,
  c.status,
  c.is_deferred,
  c.interview_date,
  c.interview_time,

  c.internship_date,
  c.internship_time_from,
  c.internship_time_to,

  c.declined_at,

  COALESCE(u.full_name, 'не назначен') AS admin_name,

  COALESCE(tp_place.title, 'не указано') AS place_title
FROM candidates c
  LEFT JOIN trade_points tp_place ON c.point_id = tp_place.id
  LEFT JOIN users u ON c.admin_id = u.id
WHERE ${where}
ORDER BY c.interview_date NULLS LAST, c.interview_time NULLS LAST, c.id
    `,
    params
  );

  return res.rows;
}

async function askWorkerName(ctx) {
  const text = "👤 Введите *имя сотрудника*:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
      .catch(() => {});
  } else {
    await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
  }
}

async function askWorkerAge(ctx) {
  const text = "🎂 Введите *возраст* (число) или нажмите «Пропустить»:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⏭ Пропустить", "lk_add_worker_skip_age")],
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);
  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askWorkerPhone(ctx) {
  const text = "📞 Введите *телефон* или нажмите «Пропустить»:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⏭ Пропустить", "lk_add_worker_skip_phone")],
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);
  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askWorkerPosition(ctx) {
  const text = "💼 Введите *должность* или нажмите «Пропустить»:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⏭ Пропустить", "lk_add_worker_skip_position")],
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);
  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askWorkerQual(ctx) {
  const text =
    "🧾 Выберите *статус квалификации*:\n\n" +
    "🔴 – база не сдана\n" +
    "🟡 – база сдана\n" +
    "🟢 – всё сдано";
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("🔴", "lk_add_worker_qual_red"),
      Markup.button.callback("🟡", "lk_add_worker_qual_yellow"),
      Markup.button.callback("🟢 ✅", "lk_add_worker_qual_green"),
    ],
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askWorkerLink(ctx) {
  const text =
    "👥 Теперь *привяжем пользователя ЛК* (чтобы сотруднику приходили уведомления).\n\n" +
    "Выберите вариант:";
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔗 Привязать пользователя",
        "lk_add_worker_link_existing"
      ),
    ],
    [Markup.button.callback("⏳ Привяжу позже", "lk_add_worker_link_later")],
    [Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function showWaitingUsersForWorkerLink(ctx) {
  const { rows } = await pool.query(
    `
    SELECT id, telegram_id, full_name, age, phone, created_at
    FROM lk_waiting_users
    WHERE status = 'new'
    ORDER BY created_at DESC
    `
  );

  if (!rows.length) {
    await ctx.reply(
      "Пока нет новых пользователей ЛК для привязки.\n" +
        "Можно привязать позже из настроек сотрудника."
    );
    await ctx.answerCbQuery().catch(() => {});
    await finalizeWorkerCreate(ctx, null, null);
    return;
  }

  const buttons = rows.map((u) => {
    const agePart = u.age ? ` (${u.age})` : "";
    const phonePart = u.phone ? ` ${u.phone}` : "";
    const nameWithAge = `${u.full_name || "не указано"}${
      u.age ? ` (${u.age})` : ""
    }`;
    const label = `${nameWithAge || "Без имени"}${agePart}${phonePart}`;
    return [Markup.button.callback(label, `lk_add_worker_link_select_${u.id}`)];
  });

  buttons.push([
    Markup.button.callback("⏳ Привязать позже", "lk_add_worker_link_later"),
  ]);
  buttons.push([Markup.button.callback("❌ Отмена", "lk_add_worker_cancel")]);

  const keyboard = Markup.inlineKeyboard(buttons);
  await ctx
    .editMessageText("Выберите пользователя ЛК для привязки:", { ...keyboard })
    .catch(async () => {
      await ctx.reply("Выберите пользователя ЛК для привязки:", {
        ...keyboard,
      });
    });
}

async function showWaitingUsersForInternLink(ctx) {
  const { rows } = await pool.query(
    `
    SELECT id, telegram_id, full_name, age, phone, created_at
    FROM lk_waiting_users
    WHERE status = 'new'
    ORDER BY created_at DESC
    `
  );

  if (!rows.length) {
    await ctx.reply(
      "Пока нет новых пользователей ЛК для привязки.\n" +
        "Пусть сотрудник сначала нажмёт «Я уже сотрудник» в ЛК и появится в списке ожидания."
    );
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const buttons = rows.map((u) => {
    const agePart = u.age ? ` (${u.age})` : "";
    const phonePart = u.phone ? ` ${u.phone}` : "";
    const label = `${u.full_name || "Без имени"}${agePart}${phonePart}`;
    return [Markup.button.callback(label, `lk_add_intern_link_select_${u.id}`)];
  });

  buttons.push([Markup.button.callback("❌ Отмена", "lk_add_intern_cancel")]);

  const keyboard = Markup.inlineKeyboard(buttons);
  await ctx
    .editMessageText(
      "Выберите пользователя ЛК, которого добавить как *стажёра*:",
      {
        ...keyboard,
        parse_mode: "Markdown",
      }
    )
    .catch(async () => {
      await ctx.reply(
        "Выберите пользователя ЛК, которого добавить как *стажёра*:",
        {
          ...keyboard,
          parse_mode: "Markdown",
        }
      );
    });
}

async function finalizeInternCreate(ctx, admin, waitingId) {
  // берём telegram_id + имя из списка ожидания
  const wRes = await pool.query(
    `SELECT id, telegram_id, full_name FROM lk_waiting_users WHERE id = $1 LIMIT 1`,
    [waitingId]
  );
  if (!wRes.rows.length) {
    await ctx.reply("Пользователь ожидания не найден.");
    return;
  }
  const w = wRes.rows[0];

  // создаём users как intern
  const ins = await pool.query(
    `
    INSERT INTO users (telegram_id, full_name, role, staff_status)
    VALUES ($1, $2, 'user', 'intern')
    RETURNING id
    `,
    [w.telegram_id || null, w.full_name || null]
  );
  const userId = ins.rows[0].id;

  // помечаем waiting user как linked
  await pool.query(
    `
    UPDATE lk_waiting_users
    SET status = 'linked',
        linked_user_id = $2,
        linked_at = NOW()
    WHERE id = $1
    `,
    [waitingId, userId]
  );

  // возвращаем в таб стажёров
  setCandidateFilters(ctx.from.id, { activeTab: "interns" });
  await showInternsListLk(ctx, admin, { edit: true });
}

async function finalizeWorkerCreate(ctx, waitingId, telegramIdOverride) {
  const st = getAddWorkerState(ctx.from.id);
  if (!st) return;

  const name = st.name;
  const age = st.age || null;
  const phone = st.phone || null;
  const position = st.position || null;
  const qual = st.qual || "green";

  let telegramId = telegramIdOverride || null;

  // если выбрали waitingId — берём telegram_id оттуда
  if (waitingId) {
    const wRes = await pool.query(
      `SELECT telegram_id FROM lk_waiting_users WHERE id = $1 LIMIT 1`,
      [waitingId]
    );
    if (wRes.rows.length) {
      telegramId = wRes.rows[0].telegram_id;
    }
  }

  // создаём пользователя-сотрудника
  // ВАЖНО: в вашей схеме users.age нет — возраст сохраняем только если есть куда (пока нет).
  // Поэтому age используем лишь в UI из candidates при наличии; тут просто игнорируем.
  // Телефон пишем в work_phone (у вас это поле точно используется у наставников).
  let userId = null;
  try {
    const ins = await pool.query(
      `
      INSERT INTO users (telegram_id, full_name, role, staff_status, position, work_phone, qualification_status)
      VALUES ($1, $2, 'worker', 'worker', $3, $4, $5)
      RETURNING id
      `,
      [telegramId, name, position, phone, qual]
    );
    userId = ins.rows[0].id;
  } catch (e) {
    // если qualification_status отсутствует — создадим без него
    const ins2 = await pool.query(
      `
      INSERT INTO users (telegram_id, full_name, role, staff_status, position, work_phone)
      VALUES ($1, $2, 'worker', 'worker', $3, $4)
      RETURNING id
      `,
      [telegramId, name, position, phone]
    );
    userId = ins2.rows[0].id;
  }

  // помечаем waiting user как linked (если было)
  if (waitingId && userId) {
    await pool
      .query(
        `
      UPDATE lk_waiting_users
      SET status = 'linked',
          linked_user_id = $2,
          linked_at = NOW()
      WHERE id = $1
      `,
        [waitingId, userId]
      )
      .catch(() => {});
  }

  clearAddWorkerState(ctx.from.id);

  // открываем карточку сотрудника
  await showWorkerCardLk(ctx, userId, { edit: true });
}

async function loadInternsForAdmin(user, filters) {
  const params = [];
  let where =
    "(c.status = 'intern' OR EXISTS (SELECT 1 FROM internship_sessions s WHERE s.user_id = u.id AND s.is_canceled = FALSE))";

  // у стажёров привязка к наставнику/админу идёт через internship_admin_id
  if (filters.scope === "personal") {
    params.push(user.id);
    where += ` AND c.internship_admin_id = $${params.length}`;
  }

  const res = await pool.query(
    `
SELECT
  u.id,
  u.full_name,
  u.role,
  u.staff_status,
  u.position,
  u.work_phone,
  u.username,
  u.candidate_id,
  c.age AS age
FROM users u
LEFT JOIN candidates c ON c.id = u.candidate_id
WHERE u.id = $1

ORDER BY c.internship_date NULLS LAST, c.internship_time_from NULLS LAST, c.id
    `,
    params
  );

  return res.rows;
}

async function getActiveShiftToday(userId) {
  const { rows } = await pool.query(
    `
    SELECT s.id, s.trade_point_id, tp.title AS point_title
    FROM shifts s
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.user_id = $1
     AND s.status IN ('opening_in_progress','opened','closing_in_progress')
AND s.closed_at IS NULL
    ORDER BY s.opened_at DESC NULLS LAST, s.id DESC
    LIMIT 1
    `,
    [userId]
  );
  return rows[0] || null;
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ----------------------------------------
// ОТРИСОВКА СПИСКА КАНДИДАТОВ
// ----------------------------------------

async function showInternsListLk(ctx, user, options = {}) {
  const tgId = ctx.from.id;
  const filters = getCandidateFilters(tgId);

  const shouldEdit =
    options.edit !== undefined
      ? options.edit
      : ctx.updateType === "callback_query";

  // ✅ стажёры — это candidates со статусом intern
  const params = [];
  let where =
    "(c.status = 'intern' OR EXISTS (SELECT 1 FROM internship_sessions s WHERE s.user_id = u.id AND s.is_canceled = FALSE))";

  if (filters.scope === "personal") {
    params.push(user.id);
    where += ` AND c.internship_admin_id = $${params.length}`;
  }

  const res = await pool.query(
    `
  SELECT
    c.id                  AS intern_key,
    'candidate'           AS intern_src,
    c.id                  AS candidate_id,
    u.id                  AS lk_user_id,

    c.name,
    c.age,

    c.internship_date,
    c.internship_time_from,
    c.internship_time_to,

    COALESCE(fin.finished_cnt, 0) AS finished_cnt,
    (act.id IS NOT NULL)          AS has_active

  FROM candidates c
  JOIN users u ON u.candidate_id = c.id

  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS finished_cnt
    FROM internship_sessions s
    WHERE s.user_id = u.id
      AND s.finished_at IS NOT NULL
      AND s.is_canceled = FALSE
  ) fin ON TRUE

  LEFT JOIN LATERAL (
    SELECT id
    FROM internship_sessions s
    WHERE s.user_id = u.id
      AND s.finished_at IS NULL
      AND s.is_canceled = FALSE
    ORDER BY s.id DESC
    LIMIT 1
  ) act ON TRUE

  WHERE ${where}
  ORDER BY c.internship_date NULLS LAST, c.id
  `,
    params
  );

  const interns = res.rows;

  let text = "🧑‍🎓 *Стажёры*\n\n";
  text += "▶️ — ожидание стажировки\n";
  text += "⏺️ — идёт обучение\n\n";

  text +=
    filters.scope === "personal"
      ? "Показаны только твои стажёры:\n\n"
      : "Показаны все стажёры:\n\n";

  text += interns.length
    ? "Выбери стажёра:\n\n"
    : "Пока нет ни одного стажёра.\n\n";

  const rows = [];

  for (const c of interns) {
    const icon = c.has_active ? "⏺️" : "▶️";

    const dayNumber = c.has_active
      ? Number(c.finished_cnt) + 1
      : Number(c.finished_cnt);
    const dayText = `${dayNumber}дн.`;

    const name = c.name || "Без имени";
    const ageText = c.age ? ` (${c.age})` : "";

    const when = formatInternshipLabel(
      c.internship_date,
      c.internship_time_from,
      c.internship_time_to
    );

    const openCb =
      c.intern_src === "candidate"
        ? `admin_intern_open_${c.candidate_id}`
        : `admin_intern_user_open_${c.lk_user_id}`;

    rows.push([
      Markup.button.callback(
        `${icon} ${dayText} ${name}${ageText} – ${when}`,
        openCb
      ),
    ]);
  }

  // вкладки
  rows.push([
    Markup.button.callback("Кандидаты", "admin_users_candidates"),
    Markup.button.callback("✅ Стажёры", "admin_users_interns"),
    Markup.button.callback("Сотрудники", "admin_users_workers"),
  ]);

  // низ как у кандидатов
  if (filters.historyExpanded) {
    rows.push([
      Markup.button.callback("+ добавить", "lk_cand_create_start"),
      Markup.button.callback("+ добавить", "lk_add_intern"),
      Markup.button.callback("+ добавить", "lk_add_worker"),
    ]);
    rows.push([Markup.button.callback("▴ Свернуть", "lk_cand_toggle_history")]);
    rows.push([Markup.button.callback("🔮 Общение с ИИ", "admin_ai_logs_1")]);
    rows.push([Markup.button.callback("📜 история", "lk_history_menu")]);
    rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  } else if (filters.filtersExpanded) {
    rows.push([Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history")]);
    rows.push([
      Markup.button.callback("🔎 Фильтр (скрыть)", "lk_cand_filter_toggle"),
    ]);

    rows.push([
      Markup.button.callback(
        filters.scope === "personal" ? "✅ 👤 личные" : "👤 личные",
        "lk_cand_filter_scope_personal"
      ),
      Markup.button.callback(
        filters.scope === "all" ? "✅ 👥 все" : "👥 все",
        "lk_cand_filter_scope_all"
      ),
    ]);

    rows.push([
      Markup.button.callback("🔄 Сбросить фильтры", "lk_cand_filter_reset"),
    ]);
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  } // --- СОСТОЯНИЕ: ОБЫЧНОЕ (ничего не раскрыто) ---
  else {
    rows.push([Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history")]);
    rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  }

  const keyboard = Markup.inlineKeyboard(rows);
  const extra = { ...keyboard, parse_mode: "Markdown" };
  await deliver(ctx, { text, extra }, { edit: shouldEdit });
}

async function showCandidatesListLk(ctx, user, options = {}) {
  const tgId = ctx.from.id;
  const filters = getCandidateFilters(tgId);
  const shouldEdit =
    options.edit !== undefined
      ? options.edit
      : ctx.updateType === "callback_query";

  const candidates = await loadCandidatesForAdmin(user, filters);

  let text = "🟢 *Кандидаты*\n\n";
  text += "🕒 — приглашены на собеседование\n";
  text += "✔️ — пришли на собеседование, ожидают решения\n";
  text += "☑️ — приглашены на стажировку\n\n";

  if (filters.scope === "personal") {
    text += "Показаны только твои кандидаты.\n\n";
  } else {
    text += "Показаны все собеседования.\n\n";
  }

  if (!candidates.length) {
    text += "⚠️ По текущим фильтрам кандидатов нет.\n";
  } else {
    text += "Выбери кандидата:\n\n";
  }

  // Кнопки списка кандидатов
  const rows = [];

  for (const c of candidates) {
    const icon = c.is_deferred ? "🗑️" : getStatusIcon(c.status);
    const agePart = c.age ? ` (${c.age})` : "";
    const isAll = filters.scope === "all";
    const adminTail = isAll ? ` к ${c.admin_name || "не назначен"}` : "";

    let label = "";

    // ❌/🗑️ отказанные/на удалении/отложенные
    if (c.status === "rejected" || c.status === "cancelled") {
      const declinedDate = formatDateOnly(c.declined_at);
      label = `${icon}${c.name}${agePart} - ${declinedDate}`;
    }
    // ☑️ приглашены на стажировку (показываем дату+диапазон времени стажировки)
    else if (c.status === "internship_invited") {
      const dt = formatInternshipLabel(
        c.internship_date,
        c.internship_time_from,
        c.internship_time_to
      );
      label = `${icon} ${c.name}${agePart} — ${dt}`;
    }
    // 🕒 / ✔️ собеседования (как было, но в режиме "все" дописываем "к Павлу")
    else {
      const dt = formatDateTimeShort(c.interview_date, c.interview_time);
      label = `${icon} ${c.name}${agePart} — ${dt}${adminTail}`;
    }

    rows.push([Markup.button.callback(label, `lk_cand_open_${c.id}`)]);
  }

  // 2) ТРИ РЕЖИМА — как в старом users.js

  // 2) НИЗ ЭКРАНА (3 состояния): обычный / раскрыть / фильтр

  // вкладки всегда показываем
  rows.push([
    Markup.button.callback("✅ Кандидаты", "admin_users_candidates"),
    Markup.button.callback("Стажёры", "admin_users_interns"),
    Markup.button.callback("Сотрудники", "admin_users_workers"),
  ]);

  // --- СОСТОЯНИЕ: РАСКРЫТО ("раскрыть") ---
  if (filters.historyExpanded) {
    // + добавить (только внутри раскрыть)
    rows.push([
      Markup.button.callback("+ добавить", "lk_cand_create_start"),
      Markup.button.callback("+ добавить", "lk_add_intern"),
      Markup.button.callback("+ добавить", "lk_add_worker"),
    ]);

    // скрыть
    rows.push([Markup.button.callback("▴ Свернуть", "lk_cand_toggle_history")]);

    // общение с ИИ (заглушка)
    rows.push([Markup.button.callback("🔮 Общение с ИИ", "admin_ai_logs_1")]);

    // история
    rows.push([Markup.button.callback("📜 история", "lk_history_menu")]);

    // фильтр (в свернутом виде)
    rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

    // --- СОСТОЯНИЕ: ФИЛЬТР РАСКРЫТ ---
  } else if (filters.filtersExpanded) {
    // раскрыть (свернутое) — отдельной кнопкой
    rows.push([Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history")]);

    // фильтр (раскрытый) — отдельной кнопкой
    rows.push([
      Markup.button.callback("🔎 Фильтр (скрыть)", "lk_cand_filter_toggle"),
    ]);

    // статусы в 1 строку: 🕒 | ✔️ | ☑️ | ❌
    rows.push([
      Markup.button.callback(
        filters.waiting ? "🕒" : "➖🕒",
        "lk_cand_filter_status_waiting"
      ),
      Markup.button.callback(
        filters.arrived ? "✔️" : "➖✔️",
        "lk_cand_filter_status_arrived"
      ),
      Markup.button.callback(
        filters.internshipInvited ? "☑️" : "➖☑️",
        "lk_cand_filter_status_internship"
      ),
      Markup.button.callback(
        filters.cancelled ? "❌" : "➖❌",
        "lk_cand_filter_status_cancelled"
      ),
    ]);

    // 👤 личные | 👥 все
    rows.push([
      Markup.button.callback(
        filters.scope === "personal" ? "✅ 👤 личные" : "👤 личные",
        "lk_cand_filter_scope_personal"
      ),
      Markup.button.callback(
        filters.scope === "all" ? "✅ 👥 все" : "👥 все",
        "lk_cand_filter_scope_all"
      ),
    ]);

    // сбросить фильтры
    rows.push([
      Markup.button.callback("🔄 Сбросить фильтры", "lk_cand_filter_reset"),
    ]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

    // --- СОСТОЯНИЕ: ОБЫЧНОЕ (ничего не раскрыто) ---
  } else {
    // раскрыть (отдельно)
    rows.push([Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history")]);

    // фильтр (отдельно)
    rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  }

  const keyboard = Markup.inlineKeyboard(rows);
  const extra = { ...keyboard, parse_mode: "Markdown" };

  await deliver(ctx, { text, extra }, { edit: shouldEdit });
}

function formatDateOnly(isoDate) {
  if (!isoDate) return "не указано";
  const d = isoDate instanceof Date ? isoDate : new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "не указано";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

function formatInternshipLabel(isoDate, from, to) {
  if (!isoDate) return "не указано";
  const d = isoDate instanceof Date ? isoDate : new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "не указано";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const wd = WEEK_DAYS[d.getDay()];
  const range = from && to ? `(с ${from} до ${to})` : "";
  return `${dd}.${mm} (${wd}) ${range}`.trim();
}

function calcInternshipDays(isoDate) {
  if (!isoDate) return 0;
  const d = isoDate instanceof Date ? isoDate : new Date(isoDate);
  if (Number.isNaN(d.getTime())) return 0;

  const now = new Date();
  // считаем полные дни от даты стажировки до сегодня включительно
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((today - start) / 86400000) + 1;
  return diff < 0 ? 0 : diff;
}

// ----------------------------------------
// РЕГИСТРАЦИЯ ХЕНДЛЕРОВ ДЛЯ СПИСКА И ФИЛЬТРОВ
// ----------------------------------------

async function showWorkerPositionPicker(ctx, workerId, options = {}) {
  const shouldEdit =
    options.edit !== undefined
      ? options.edit
      : ctx.updateType === "callback_query";

  const { rows } = await pool.query(
    `SELECT id, title FROM positions WHERE is_active = TRUE ORDER BY title`
  );

  let text = "💼 *Выберите должность сотрудника:*";
  const buttons = [];

  if (!rows.length) {
    text += "\n\n— список пуст —\n\nДобавьте должности в настройке должностей.";
  } else {
    for (const p of rows) {
      buttons.push([
        Markup.button.callback(
          p.title,
          `lk_worker_set_position_${workerId}_${p.id}`
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback("⬅️ Назад", `lk_worker_open_${workerId}`),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);
  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit: shouldEdit }
  );
}

async function setWorkerPosition(workerId, positionId) {
  const { rows } = await pool.query(
    `SELECT title FROM positions WHERE id = $1 AND is_active = TRUE LIMIT 1`,
    [positionId]
  );
  if (!rows.length) return { ok: false, reason: "not_found" };

  const title = rows[0].title;

  await pool.query(`UPDATE users SET position = $2 WHERE id = $1`, [
    workerId,
    title,
  ]);

  return { ok: true, title };
}

function registerCandidateListHandlers(bot, ensureUser, logError) {
  registerCandidateEditHandlers(
    bot,
    ensureUser,
    logError,
    showCandidateCardLk,
    isRestoreModeFor
  );

  bot.action(/^admin_worker_edit_age_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        await ctx
          .answerCbQuery("Нет доступа", { show_alert: true })
          .catch(() => {});
        return;
      }

      const workerId = Number(ctx.match[1]);

      // Берём текущего юзера
      const ur = await pool.query(
        `SELECT id, full_name, candidate_id FROM users WHERE id = $1 LIMIT 1`,
        [workerId]
      );
      const u = ur.rows[0];
      if (!u) {
        await ctx
          .answerCbQuery("Сотрудник не найден", { show_alert: true })
          .catch(() => {});
        return;
      }

      let candidateId = u.candidate_id;

      // ✅ Если анкеты кандидата нет — создаём "служебную" и привязываем
      if (!candidateId) {
        const name = (u.full_name || "Сотрудник").trim();

        const cr = await pool.query(
          `
        INSERT INTO candidates (name, status, is_deferred, decline_reason, declined_at, admin_id)
        VALUES ($1, 'rejected', true, 'служебная анкета для сотрудника', NOW(), $2)
        RETURNING id
        `,
          [name, admin.id]
        );

        candidateId = cr.rows[0].id;

        await pool.query(`UPDATE users SET candidate_id = $1 WHERE id = $2`, [
          candidateId,
          workerId,
        ]);
      }

      await ctx.answerCbQuery().catch(() => {});

      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "age",
        candidateId,
      });

      await ctx.reply(
        "🎂 Введи возраст (число).\nЧтобы очистить — отправь «-».\nДля отмены — /cancel"
      );
    } catch (err) {
      logError("admin_worker_edit_age", err);
    }
  });

  // открыть выбор должности
  bot.action(/^lk_worker_edit_position_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin) return;
      if (admin.role !== "admin" && admin.role !== "super_admin") {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const workerId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showWorkerPositionPicker(ctx, workerId, { edit: true });
    } catch (err) {
      logError("lk_worker_edit_position", err);
    }
  });

  // выбрать должность -> записать -> вернуться в карточку сотрудника
  bot.action(/^lk_worker_set_position_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin) return;
      if (admin.role !== "admin" && admin.role !== "super_admin") {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const workerId = Number(ctx.match[1]);
      const positionId = Number(ctx.match[2]);

      const res = await setWorkerPosition(workerId, positionId);
      if (!res.ok) {
        await ctx.answerCbQuery("Должность не найдена").catch(() => {});
        // остаёмся на выборе
        await showWorkerPositionPicker(ctx, workerId, { edit: true });
        return;
      }

      await ctx.answerCbQuery("✅ Должность обновлена").catch(() => {});
      // важно: у тебя уже есть открытие карточки сотрудника по callback
      // ниже я использую универсальный переход "lk_worker_open_<id>"
      // если у тебя другое имя — скажи, поправлю под фактический callback.
      await showWorkerCardLk(ctx, workerId, { edit: true });
    } catch (err) {
      logError("lk_worker_set_position", err);
    }
  });

  // ---------------- ОТКРЫТИЕ КАРТОЧКИ СТАЖЁРА ИЗ СПИСКА ----------------

  // 1) Обычный стажёр (есть candidate_id)
  bot.action(/^admin_intern_open_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin) return;
      if (admin.role !== "admin" && admin.role !== "super_admin") {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const candidateId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("admin_intern_open", err);
    }
  });

  // 2) “Ручной” стажёр (есть только users.id, candidate может отсутствовать)
  bot.action(/^admin_intern_user_open_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin) return;
      if (admin.role !== "admin" && admin.role !== "super_admin") {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const userId = Number(ctx.match[1]);

      // если у этого users есть candidate_id — откроем полноценную карточку кандидата/стажёра
      const { rows } = await pool.query(
        `SELECT candidate_id FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );

      if (rows.length && rows[0].candidate_id) {
        await ctx.answerCbQuery().catch(() => {});
        await showCandidateCardLk(ctx, Number(rows[0].candidate_id), {
          edit: true,
        });
        return;
      }

      // иначе — это реально “ручной” стажёр без кандидата
      await ctx.answerCbQuery().catch(() => {});
      const text =
        "🧑‍🎓 *Стажёр добавлен вручную*\n\n" +
        `user_id=${userId}\n\n` +
        "Карточка кандидата у него пустая (это нормально).\n" +
        "Дальше мы допилим полноценную карточку стажёра без кандидата.";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад к стажёрам", "admin_users_interns")],
      ]);

      await ctx
        .editMessageText(text, { parse_mode: "Markdown", ...keyboard })
        .catch(async () => {
          await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
        });
    } catch (err) {
      logError("admin_intern_user_open", err);
    }
  });

  const POSITIONS = [
    { code: "barista", label: "Бариста" },
    { code: "point_admin", label: "Администратор точки" },
    { code: "senior_admin", label: "Старший админ" },
    { code: "quality_manager", label: "Менеджер по качеству" },
    { code: "supervisor", label: "Руководитель" },
    { code: "control", label: "Управляющий" },
  ];

  const STAFF_STATUSES = [
    { code: "candidate", label: "Кандидат" },
    { code: "intern", label: "Стажёр" },
    { code: "worker", label: "Сотрудник" },
  ];

  const ROLES = [
    { code: "user", label: "Пользователь" },
    { code: "admin", label: "Админ" },
    { code: "super_admin", label: "Супер-админ" },
  ];

  bot.on("text", async (ctx, next) => {
    // 1) Старый сценарий: приглашение на стажировку (дата/время/точка/наставник)
    const st = getAddWorkerState(ctx.from.id);

    if (!st) return next();

    try {
      const raw = (ctx.message.text || "").trim();

      if (st.step === "name") {
        if (!raw) {
          await ctx.reply("Имя не может быть пустым. Введите имя сотрудника:");
          return;
        }
        setAddWorkerState(ctx.from.id, { name: raw, step: "age" });
        await askWorkerAge(ctx);
        return;
      }

      if (st.step === "age") {
        const n = Number(raw.replace(/[^\d]/g, ""));
        if (!Number.isFinite(n) || n <= 0 || n > 120) {
          await ctx.reply(
            "Возраст не распознан. Введите число (например 22) или нажмите «Пропустить»."
          );
          return;
        }
        setAddWorkerState(ctx.from.id, { age: n, step: "phone" });
        await askWorkerPhone(ctx);
        return;
      }

      if (st.step === "phone") {
        setAddWorkerState(ctx.from.id, {
          phone: normalizePhone(raw),
          step: "position",
        });
        await askWorkerPosition(ctx);
        return;
      }

      if (st.step === "position") {
        setAddWorkerState(ctx.from.id, { position: raw || null, step: "qual" });
        await askWorkerQual(ctx);
        return;
      }

      return next();
    } catch (err) {
      logError("lk_add_worker_text", err);
      clearAddWorkerState(ctx.from.id);
      await ctx.reply(
        "Не удалось сохранить данные сотрудника. Попробуйте снова."
      );
    }
  });

  // Вход в раздел "Пользователи" → сразу показываем СОТРУДНИКОВ
  bot.action("admin_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      await showWorkersListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users", err);
    }
  });

  bot.action("lk_add_worker", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      clearAddWorkerState(ctx.from.id);
      setAddWorkerState(ctx.from.id, { step: "name" });

      await askWorkerName(ctx);
    } catch (err) {
      logError("lk_add_worker", err);
    }
  });

  bot.action("lk_add_worker_cancel", async (ctx) => {
    try {
      clearAddWorkerState(ctx.from.id);
      await ctx.answerCbQuery("Отменено").catch(() => {});
      const u = await ensureUser(ctx);
      if (!u) return;
      await showWorkersListLk(ctx, u, { edit: true });
    } catch (err) {
      logError("lk_add_worker_cancel", err);
    }
  });

  bot.action("lk_add_worker_skip_age", async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      setAddWorkerState(ctx.from.id, { age: null, step: "phone" });
      await ctx.answerCbQuery().catch(() => {});
      await askWorkerPhone(ctx);
    } catch (err) {
      logError("lk_add_worker_skip_age", err);
    }
  });

  bot.action("lk_add_worker_skip_phone", async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      setAddWorkerState(ctx.from.id, { phone: null, step: "position" });
      await ctx.answerCbQuery().catch(() => {});
      await askWorkerPosition(ctx);
    } catch (err) {
      logError("lk_add_worker_skip_phone", err);
    }
  });

  bot.action("lk_add_intern", async (ctx) => {
    await ctx.answerCbQuery("⏳ Добавление стажёров будет доступно позже");
  });

  bot.action("lk_add_intern_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery("Отменено").catch(() => {});
      const u = await ensureUser(ctx);
      if (!u) return;
      setCandidateFilters(ctx.from.id, { activeTab: "interns" });
      await showInternsListLk(ctx, u, { edit: true });
    } catch (err) {
      logError("lk_add_intern_cancel", err);
    }
  });

  bot.action(/^lk_add_intern_link_select_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const waitingId = Number(ctx.match[1]);
      await finalizeInternCreate(ctx, admin, waitingId);
    } catch (err) {
      logError("lk_add_intern_link_select", err);
    }
  });

  bot.action("lk_add_worker_skip_position", async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      setAddWorkerState(ctx.from.id, { position: null, step: "qual" });
      await ctx.answerCbQuery().catch(() => {});
      await askWorkerQual(ctx);
    } catch (err) {
      logError("lk_add_worker_skip_position", err);
    }
  });

  bot.action("lk_add_worker_qual_red", async (ctx) => {
    const st = getAddWorkerState(ctx.from.id);
    if (!st) return;
    setAddWorkerState(ctx.from.id, { qual: "red", step: "link" });
    await ctx.answerCbQuery().catch(() => {});
    await askWorkerLink(ctx);
  });

  bot.action("lk_add_worker_qual_yellow", async (ctx) => {
    const st = getAddWorkerState(ctx.from.id);
    if (!st) return;
    setAddWorkerState(ctx.from.id, { qual: "yellow", step: "link" });
    await ctx.answerCbQuery().catch(() => {});
    await askWorkerLink(ctx);
  });

  bot.action("lk_add_worker_qual_green", async (ctx) => {
    const st = getAddWorkerState(ctx.from.id);
    if (!st) return;
    setAddWorkerState(ctx.from.id, { qual: "green", step: "link" });
    await ctx.answerCbQuery().catch(() => {});
    await askWorkerLink(ctx);
  });

  bot.action("lk_add_worker_link_existing", async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      await ctx.answerCbQuery().catch(() => {});
      await showWaitingUsersForWorkerLink(ctx);
    } catch (err) {
      logError("lk_add_worker_link_existing", err);
    }
  });

  bot.action(/^lk_add_worker_link_select_(\d+)$/, async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      const waitingId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await finalizeWorkerCreate(ctx, waitingId, null);
    } catch (err) {
      logError("lk_add_worker_link_select", err);
    }
  });

  bot.action("lk_add_worker_link_later", async (ctx) => {
    try {
      const st = getAddWorkerState(ctx.from.id);
      if (!st) return;
      await ctx.answerCbQuery().catch(() => {});
      await finalizeWorkerCreate(ctx, null, null);
    } catch (err) {
      logError("lk_add_worker_link_later", err);
    }
  });

  // Явно "Кандидаты" из сегмента
  bot.action("admin_users_candidates", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }
      setCandidateFilters(ctx.from.id, { activeTab: "candidates" });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users_candidates", err);
    }
  });

  bot.action("lk_workers_filter_red", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setCandidateFilters(ctx.from.id, { workerQual: "red" });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  bot.action("lk_workers_filter_yellow", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setCandidateFilters(ctx.from.id, { workerQual: "yellow" });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  bot.action("lk_workers_filter_green", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setCandidateFilters(ctx.from.id, { workerQual: "green" });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  bot.action("lk_workers_filter_all", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setCandidateFilters(ctx.from.id, { workerQual: "all" });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  // заглушка "по программе"
  bot.action("lk_workers_filter_program", async (ctx) => {
    try {
      await ctx.answerCbQuery("📉 Пока в разработке.").catch(() => {});
    } catch (_) {}
  });

  bot.action("lk_workers_filter_onshift", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const f = getCandidateFilters(ctx.from.id);
    setCandidateFilters(ctx.from.id, { workerOnShift: !f.workerOnShift });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  bot.action("lk_workers_filter_reset", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setCandidateFilters(ctx.from.id, {
      workerQual: "all",
      workerProgram: false,
      workerOnShift: false,
    });
    const u = await ensureUser(ctx);
    if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;
    await showWorkersListLk(ctx, u, { edit: true });
  });

  // Быстрый переход "Мои собеседования"
  bot.action("lk_admin_my_interviews", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const current = getCandidateFilters(tgId);
      const next = {
        ...current,
        scope: "personal",
        waiting: true,
        arrived: false,
        internshipInvited: false,
        cancelled: false,
      };
      setCandidateFilters(tgId, next);

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_admin_my_interviews", err);
    }
  });

  // ================================
  // ИСТОРИЯ (общий раздел)
  // ================================

  // Главный экран выбора: кандидаты / стажёры / сотрудники
  bot.action("lk_history_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const text = "📜 <b>История</b>\n\n" + "Выберите раздел:";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "👤 история кандидатов",
            "lk_history_candidates"
          ),
        ],
        [Markup.button.callback("🎓 история стажёров", "lk_history_interns")],
        [Markup.button.callback("🧑‍💼 история сотрудников", "lk_history_staff")],
        [Markup.button.callback("⬅️ Назад", "lk_history_back")],
      ]);

      // Если это вызвано из inline-сообщения — редактируем, иначе просто ответ
      if (ctx.callbackQuery?.message?.message_id) {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
        });
      } else {
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch (err) {
      logError("lk_history_menu", err);
    }
  });

  // Назад из истории → возвращаемся к списку кандидатов (тот же экран)
  bot.action("lk_history_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      // Возвращаемся в список кандидатов (как было)
      await showCandidatesListLk(ctx, await ensureUser(ctx), { edit: true });
    } catch (err) {
      logError("lk_history_back", err);
    }
  });

  async function showHistoryEntityScreen(
    ctx,
    title,
    deleteLabel,
    postponeLabel,
    deleteAction,
    postponeAction
  ) {
    const text =
      `📜 <b>${title}</b>\n\n` +
      "Выбери раздел:\n" +
      `1) ❌ ${deleteLabel} — будут удалены через 30 дней после отказа или отмены.\n` +
      `2) 🗑️ ${postponeLabel} — остаются в базе без автоудаления.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`❌ ${deleteLabel}`, deleteAction)],
      [Markup.button.callback(`🗑️ ${postponeLabel}`, postponeAction)],
      [Markup.button.callback("⬅️ Назад", "lk_history_menu")],
    ]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
    });
  }

  // История кандидатов (каркас как на твоём скрине 2)
  bot.action("lk_history_candidates", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_candidates", err);
    }
  });

  // История стажёров (каркас)
  bot.action("lk_history_interns", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_interns", err);
    }
  });

  // История сотрудников (каркас)
  bot.action("lk_history_staff", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_staff", err);
    }
  });

  // Заглушки: функционал добавим позже
  bot.action("lk_history_stub_delete", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим этот раздел.").catch(() => {});
    } catch (err) {
      logError("lk_history_stub_delete", err);
    }
  });

  bot.action("lk_history_stub_postpone", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим этот раздел.").catch(() => {});
    } catch (err) {
      logError("lk_history_stub_postpone", err);
    }
  });

  bot.action(/^lk_cand_postpone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      await pool.query(
        `
      UPDATE candidates
         SET is_deferred = true,
             declined_at = NULL
       WHERE id = $1
      `,
        [candidateId]
      );

      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_postpone", err);
    }
  });

  // Быстрый переход "Мои стажировки"
  bot.action("lk_admin_my_internships", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const current = getCandidateFilters(tgId);
      const next = {
        ...current,
        scope: "personal",
        waiting: false,
        arrived: false,
        internshipInvited: true,
        cancelled: false,
      };
      setCandidateFilters(tgId, next);

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_admin_my_internships", err);
    }
  });

  async function showCandidatesOnDeletion(ctx, { edit } = {}) {
    const tgId = ctx.from.id;
    const stage = historyCandidatesFilter.get(tgId) || null;

    const params = [];
    let where = `
    c.status = 'rejected'
    AND c.is_deferred = false
    AND c.declined_at IS NOT NULL
  `;

    if (stage) {
      params.push(stage);
      where += ` AND c.closed_from_status = $${params.length}`;
    }

    const res = await pool.query(
      `
      SELECT c.id, c.name, c.age, c.declined_at, c.closed_from_status
      FROM candidates c
      WHERE ${where}
      ORDER BY c.declined_at DESC, c.id DESC
      LIMIT 20
    `,
      params
    );

    const total = res.rows.length;

    let text =
      "❌ <b>Кандидаты на удалении</b>\n\n" +
      "Эти кандидаты находятся в списке на удаление и будут автоматически удалены через 30 дней после отказа или отмены.\n\n" +
      "Фильтры по этапу, на котором кандидат выбыл:\n" +
      "✔️ — после собеседования\n" +
      "✅ — после приглашения на стажировку\n" +
      "🕒 — до собеседования\n" +
      "🔄 — снять фильтр\n\n" +
      `Найдено: ${total}\n\n` +
      (total ? "Выбери кандидата:" : "Пока нет кандидатов на удалении.");

    const rows = [];

    // Кнопки-кандидаты
    for (const c of res.rows) {
      const title = `${c.name}${c.age ? ` (${c.age})` : ""} - ${
        c.declined_at ? String(c.declined_at).slice(0, 10) : ""
      }`;
      rows.push([Markup.button.callback(title, `lk_cand_open_${c.id}`)]);
    }

    // Фильтры (как на твоём скрине — 4 кнопки внизу)
    rows.push([
      Markup.button.callback("✔️", "lk_hist_del_filter_interviewed"),
      Markup.button.callback("✅", "lk_hist_del_filter_internship"),
      Markup.button.callback("🕒", "lk_hist_del_filter_invited"),
      Markup.button.callback("🔄", "lk_hist_del_filter_clear"),
    ]);

    // Назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_history_candidates")]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (edit) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    }
  }

  async function showDeferredCandidates(ctx, { edit } = {}) {
    const tgId = ctx.from.id;
    const stage = historyCandidatesFilter.get(tgId) || null;

    const params = [];
    let where = `
    c.status = 'rejected'
    AND c.is_deferred = true
  `;

    if (stage) {
      params.push(stage);
      where += ` AND c.closed_from_status = $${params.length}`;
    }

    const res = await pool.query(
      `
      SELECT c.id, c.name, c.age, c.closed_from_status
      FROM candidates c
      WHERE ${where}
      ORDER BY c.id DESC
      LIMIT 20
    `,
      params
    );

    const total = res.rows.length;

    let text =
      "🗑️ <b>Отложенные кандидаты</b>\n\n" +
      "Такие кандидаты сохранены, чтобы к ним можно было вернуться позже. Они не удаляются автоматически.\n\n" +
      "Фильтры по этапу, на котором кандидат выбыл:\n" +
      "✔️ — после собеседования\n" +
      "✅ — после приглашения на стажировку\n" +
      "🕒 — до собеседования\n" +
      "🔄 — снять фильтр\n\n" +
      (total ? "Выбери кандидата:" : "ℹ️ Пока нет отложенных кандидатов.");

    const rows = [];

    for (const c of res.rows) {
      const title = `${c.name}${c.age ? ` (${c.age})` : ""}`;
      rows.push([Markup.button.callback(title, `lk_cand_open_${c.id}`)]);
    }

    rows.push([
      Markup.button.callback("✔️", "lk_hist_def_filter_interviewed"),
      Markup.button.callback("✅", "lk_hist_def_filter_internship"),
      Markup.button.callback("🕒", "lk_hist_def_filter_invited"),
      Markup.button.callback("🔄", "lk_hist_def_filter_clear"),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", "lk_history_candidates")]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (edit) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    }
  }

  bot.action("lk_hist_del_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showCandidatesOnDeletion(ctx, { edit: true });
  });

  bot.action("lk_hist_def_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showDeferredCandidates(ctx, { edit: true });
  });

  bot.action("lk_hist_del_filter_interviewed", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "interviewed");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_internship", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "internship_invited");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_invited", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "invited");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_clear", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.delete(ctx.from.id);
    await showCandidatesOnDeletion(ctx, { edit: true });
  });

  bot.action("lk_hist_def_filter_interviewed", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "interviewed");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_internship", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "internship_invited");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_invited", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "invited");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_clear", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.delete(ctx.from.id);
    await showDeferredCandidates(ctx, { edit: true });
  });


  

  // ----- СПИСОК СОТРУДНИКОВ -----

  async function showWorkersListLk(ctx, currentUser, options = {}) {
    const tgId = ctx.from.id;
    const filters = getCandidateFilters(tgId);

    let res;
    try {
      const f = getCandidateFilters(ctx.from.id);

      // фильтр квалификации отключён (в users нет колонки qualification_status)
      let qualWhere = "";
      const params = [f.workerOnShift === true];

      res = await pool.query(
        `
  SELECT
    u.id,
    u.full_name,
    c.age AS age,
   u.position,

sh.trade_point_id,
    sh.trade_point_title
  FROM users u
  LEFT JOIN candidates c ON c.id = u.candidate_id

  LEFT JOIN LATERAL (
    SELECT
      s.trade_point_id,
      tp.title AS trade_point_title
    FROM shifts s
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
 WHERE s.user_id = u.id
  AND s.status IN ('opening_in_progress','opened','closing_in_progress')
  AND s.closed_at IS NULL
  AND s.trade_point_id IS NOT NULL


    ORDER BY s.opened_at DESC
    LIMIT 1
  ) sh ON TRUE

  WHERE u.staff_status = 'worker'
    AND ($1::boolean IS FALSE OR sh.trade_point_id IS NOT NULL)
    ${qualWhere}
  ORDER BY u.full_name
  `,
        params
      );
    } catch (e) {
      res = await pool.query(
        `
    SELECT
      u.id,
      u.full_name,
      c.age AS age,
      u.position
    FROM users u
    LEFT JOIN candidates c ON c.id = u.candidate_id
    WHERE u.staff_status = 'worker'
    ORDER BY u.full_name
  `
      );
    }

    const workers = res.rows;

    // ✅ заголовок + пояснение (без ⏺️(Nдн) — оно НЕ уместно для повышения квалификации)
    let text = "🧑‍💼 *Сотрудники*\n\n";
    text += "🔴 – база не сдана\n";
    text += "🟡 – база сдана\n";
    text += "🟢 – всё сдано\n\n";

    if (!workers.length) {
      text += "Пока нет ни одного сотрудника.\n\n";
    } else {
      text += "Выбери сотрудника:\n\n";
    }

    const rows = [];

    for (const w of workers) {
      const name = w.full_name || "Без имени";
      const ageText = w.age ? ` (${w.age})` : "";

      // по умолчанию 🟢, если статус квалификации не задан
      let icon = "🟢";

      const onShiftTail =
        w.trade_point_id && w.trade_point_title
          ? ` - на смене ${w.trade_point_title}`
          : "";

      rows.push([
        Markup.button.callback(
          `${icon} ${name}${ageText}${onShiftTail}`,
          `admin_worker_open_${w.id}`
        ),
      ]);
    }

    // вкладки всегда показываем (единый стиль как у кандидатов)
    rows.push([
      Markup.button.callback("Кандидаты", "admin_users_candidates"),
      Markup.button.callback("Стажёры", "admin_users_interns"),
      Markup.button.callback("✅ Сотрудники", "admin_users_workers"),
    ]);

    // --- СОСТОЯНИЕ: РАСКРЫТО ("раскрыть") ---
    if (filters.historyExpanded) {
      rows.push([
        Markup.button.callback("+ добавить", "lk_cand_create_start"),
        Markup.button.callback("+ добавить", "lk_add_intern"),
        Markup.button.callback("+ добавить", "lk_add_worker"),
      ]);

      rows.push([
        Markup.button.callback("▴ Свернуть", "lk_cand_toggle_history"),
      ]);

      rows.push([Markup.button.callback("🔮 Общение с ИИ", "admin_ai_logs_1")]);

      rows.push([Markup.button.callback("📜 история", "lk_history_menu")]);

      rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);

      rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

      // --- СОСТОЯНИЕ: ФИЛЬТР РАСКРЫТ ---
    } else if (filters.filtersExpanded) {
      rows.push([
        Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history"),
      ]);

      rows.push([
        Markup.button.callback("🔎 Фильтр (скрыть)", "lk_cand_filter_toggle"),
      ]);

      // квалификация
      rows.push([
        Markup.button.callback(
          filters.workerQual === "red" ? "🔴 ✅" : "🔴",
          "lk_workers_filter_red"
        ),
        Markup.button.callback(
          filters.workerQual === "yellow" ? "🟡 ✅" : "🟡",
          "lk_workers_filter_yellow"
        ),
        Markup.button.callback(
          filters.workerQual === "green" ? "🟢 ✅" : "🟢",
          "lk_workers_filter_green"
        ),
        Markup.button.callback(
          filters.workerQual === "all" ? "все ✅" : "все",
          "lk_workers_filter_all"
        ),
      ]);

      // заглушка по программе
      rows.push([
        Markup.button.callback(
          "📉 Отстающие по программе",
          "lk_workers_filter_program"
        ),
      ]);

      // на смене
      rows.push([
        Markup.button.callback(
          filters.workerOnShift ? "💼 на смене ✅" : "💼 на смене",
          "lk_workers_filter_onshift"
        ),
      ]);

      // сброс
      rows.push([
        Markup.button.callback("сбросить фильтр", "lk_workers_filter_reset"),
      ]);

      rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
    } // --- СОСТОЯНИЕ: ОБЫЧНОЕ (ничего не раскрыто) ---
    else {
      rows.push([
        Markup.button.callback("▾ Раскрыть", "lk_cand_toggle_history"),
      ]);
      rows.push([Markup.button.callback("🔎 Фильтр", "lk_cand_filter_toggle")]);
      rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
    }

    const keyboard = Markup.inlineKeyboard(rows);
    const extra = { ...keyboard, parse_mode: "Markdown" };

    const shouldEdit =
      typeof options.edit === "boolean"
        ? options.edit
        : ctx.updateType === "callback_query";

    await deliver(ctx, { text, extra }, { edit: shouldEdit });
  }

  // ----- КАРТОЧКА СОТРУДНИКА -----

  async function showWorkerCardLk(ctx, workerId, options = {}) {
    const res = await pool.query(
      `
    SELECT
  u.id,
  u.full_name,
  u.role,
  u.staff_status,
  u.position,
  u.work_phone,
  u.username,
  u.candidate_id,
  c.age AS age
FROM users u
LEFT JOIN candidates c ON c.id = u.candidate_id
WHERE u.id = $1

      `,
      [workerId]
    );

    if (!res.rows.length) {
      if (!options.silent) {
        await ctx.reply("Этот сотрудник не найден или был удалён.");
      }
      return;
    }

    const u = res.rows[0];

    const roleLabels = {
      super_admin: "супер-админ",
      admin: "админ",
      worker: "сотрудник",
      user: "пользователь",
    };

    const statusLabels = {
      candidate: "кандидат",
      intern: "стажёр",
      worker: "сотрудник",
    };

    const roleText = roleLabels[u.role] || u.role || "не указана";
    const statusText =
      statusLabels[u.staff_status] || u.staff_status || "не указан";
    const positionText = u.position || "не указана";
    const normalizedPhone = phoneForTelegram(u.work_phone);
    const workPhoneText = normalizedPhone || u.work_phone || "не указан";
    const usernameText = u.username ? `@${u.username}` : "не указан";

    const header = (statusLabels[u.staff_status] || "сотрудник").toUpperCase();
    const sep = "────────────────────────────";

    const nameWithAge = `${u.full_name || "не указано"}${
      u.age ? ` (${u.age})` : ""
    }`;
    const nameVal = escHtml(nameWithAge);

    const roleVal = escHtml(roleText);
    const statusVal = escHtml(statusText);
    const posVal = escHtml(positionText);
    const phoneVal = escHtml(workPhoneText);
    const userVal = escHtml(usernameText);

    let text =
      `🔻 <b>${escHtml(header)}</b>\n${sep}\n` +
      `🔹 <b>Общая информация</b>\n` +
      `• <b>Имя:</b> ${nameVal}\n` +
      `• <b>Роль:</b> ${roleVal}\n` +
      `• <b>Статус:</b> ${statusVal}\n` +
      `• <b>Должность:</b> ${posVal}\n` +
      `• <b>Рабочий номер:</b> ${phoneVal}\n` +
      `• <b>Username:</b> ${userVal}\n` +
      `${sep}\n` +
      `🔹 <b>О работе</b>\n` +
      `• <b>Следующая смена:</b> в разработке\n`;

    const rows = [];

    const activeShift = await getActiveShiftToday(workerId);
    if (activeShift) {
      rows.push([
        Markup.button.callback(
          "📝 задачи смены",
          `lk_worker_shift_tasks_${workerId}`
        ),
      ]);
    }

    // 2) успеваемость (заглушка)
    rows.push([
      Markup.button.callback(
        "📊 успеваемость",
        `lk_worker_performance_${u.id}`
      ),
    ]);

    // 3) открыть карточку (toggle как у стажёра)
    const expanded = isWorkerCardExpanded(ctx.from.id, u.id);
    rows.push([
      Markup.button.callback(
        expanded ? "▴ Скрыть карточку" : " Открыть карточку",
        `lk_worker_toggle_cards_${u.id}`
      ),
    ]);

    // (пока ничего внутри expanded не добавляем — просто оставляем механику, как у стажёра)

    // 4) настройки
    rows.push([
      Markup.button.callback("⚙️ Настройки", `admin_worker_settings_${u.id}`),
    ]);

    // 5) назад
    rows.push([
      Markup.button.callback("⬅️ К сотрудникам", "admin_users_workers"),
    ]);

    const keyboard = Markup.inlineKeyboard(rows);
    const extra = { ...keyboard, parse_mode: "HTML" };

    if (options.edit) {
      await deliver(ctx, { text, extra }, { edit: true });
    } else {
      await ctx.reply(text, extra);
    }
  }

  // ----- МЕНЮ НАСТРОЕК СОТРУДНИКА -----

  async function showWorkerSettingsMenu(ctx, workerId, options = {}) {
    const res = await pool.query(
      `
     SELECT
  u.id,
  u.full_name,
  u.role,
  u.staff_status,
  u.position,
  u.work_phone,
  u.username,
  u.candidate_id,
  c.age AS age
FROM users u
LEFT JOIN candidates c ON c.id = u.candidate_id
WHERE u.id = $1

      `,
      [workerId]
    );

    if (!res.rows.length) {
      if (!options.silent) {
        await ctx.reply("Этот сотрудник не найден или был удалён.");
      }
      return;
    }

    const u = res.rows[0];

    const roleLabels = {
      super_admin: "супер-админ",
      admin: "админ",
      user: "пользователь",
    };

    const statusLabels = {
      candidate: "кандидат",
      intern: "стажёр",
      worker: "сотрудник",
    };

    const roleText = roleLabels[u.role] || u.role || "не указана";
    const statusText =
      statusLabels[u.staff_status] || u.staff_status || "не указан";
    const positionText = u.position || "не указана";
    const normalizedPhone = phoneForTelegram(u.work_phone);
    const workPhoneText = normalizedPhone || u.work_phone || "не указан";
    const usernameText = u.username ? `@${u.username}` : "не указан";

    const HR = "────────────────────────────";

    let text = `⚙️ <b>НАСТРОЙКИ СОТРУДНИКА</b>\n`;
    text += `${HR}\n`;
    text += `🔹 <b>Общая информация</b>\n`;
    const nameWithAge = `${u.full_name || "не указано"}${
      u.age ? ` (${u.age})` : ""
    }`;
    text += `• <b>Имя:</b> ${escHtml(nameWithAge)}\n`;

    text += `• <b>Роль:</b> ${escHtml(roleText)}\n`;
    text += `• <b>Статус:</b> ${escHtml(statusText)}\n`;
    text += `• <b>Должность:</b> ${escHtml(positionText)}\n`;
    text += `• <b>Рабочий номер:</b> ${escHtml(workPhoneText)}\n`;
    text += `• <b>Username:</b> ${escHtml(usernameText)}\n`;
    text += `${HR}\n`;
    text += `🔹 <b>О работе</b>\n`;
    text += `• <b>Следующая смена:</b> в разработке`;

    const rows = [];

    rows.push([
      Markup.button.callback(
        "📞 Рабочий номер",
        `admin_worker_edit_phone_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "@ Username",
        `admin_worker_edit_username_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "✏️ Изменить имя",
        `admin_worker_edit_name_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "✏️ Изменить возраст",
        `admin_worker_edit_age_${u.id}`
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "✏️ Изменить должность",
        `lk_worker_edit_position_${workerId}`
      ),
    ]);
    // статус — пока заглушка
    rows.push([
      Markup.button.callback(
        "✏️ Изменить статус",
        `admin_worker_change_status_stub_${u.id}`
      ),
    ]);

    // роль — показываем только супер-админу (тому, кто открыл меню)
    const me = await pool.query(
      `SELECT role FROM users WHERE telegram_id = $1 LIMIT 1`,
      [ctx.from.id]
    );
    const isSuperAdmin = me.rows[0]?.role === "super_admin";
    if (isSuperAdmin) {
      rows.push([
        Markup.button.callback(
          "✏️ Изменить роль",
          `admin_worker_change_role_${u.id}`
        ),
      ]);
    }

    rows.push([
      Markup.button.callback("⬅️ К сотруднику", `admin_worker_open_${u.id}`),
    ]);

    const keyboard = Markup.inlineKeyboard(rows);
    const extra = { ...keyboard, parse_mode: "HTML" };

    if (options.edit) {
      await deliver(ctx, { text, extra }, { edit: true });
    } else {
      await ctx.reply(text, extra);
    }
  }

  async function renderUsersTab(ctx, user, options = {}) {
    const tgId = ctx.from.id;
    const filters = getCandidateFilters(tgId);
    const tab = filters.activeTab || "workers"; // по умолчанию как сейчас: вход ведёт в сотрудников

    if (tab === "candidates") return showCandidatesListLk(ctx, user, options);
    if (tab === "interns") return showInternsListLk(ctx, user, options);
    return showWorkersListLk(ctx, user, options);
  }

  bot.action("admin_users_interns", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const u = await ensureUser(ctx);
      if (!u || (u.role !== "admin" && u.role !== "super_admin")) return;

      setCandidateFilters(ctx.from.id, { activeTab: "interns" });
      await showInternsListLk(ctx, u, { edit: true });
    } catch (err) {
      logError("admin_users_interns", err);
    }
  });

  bot.action(/^admin_worker_change_status_stub_(\d+)$/, async (ctx) => {
    await ctx
      .answerCbQuery("🚧 В разработке", { show_alert: false })
      .catch(() => {});
  });

  // Сотрудники — полноценный экран
  bot.action("admin_users_workers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }
      setCandidateFilters(ctx.from.id, { activeTab: "workers" });

      await showWorkersListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users_workers", err);
    }
  });

  // Открыть карточку сотрудника
  bot.action(/^admin_worker_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      await showWorkerCardLk(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_open", err);
    }
  });

  // Открыть меню настроек сотрудника
  bot.action(/^admin_worker_settings_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_settings", err);
    }
  });

  // Раскрыть/свернуть карточку сотрудника (как у стажёра)
  bot.action(/^lk_worker_toggle_cards_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      toggleWorkerCardExpanded(ctx.from.id, workerId);
      await showWorkerCardLk(ctx, workerId, { edit: true });
    } catch (err) {
      logError("lk_worker_toggle_cards", err);
    }
  });

  bot.action(/^lk_worker_shift_tasks_(\d+)$/, async (ctx) => {
    const workerId = Number(ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});

    const uRes = await pool.query(
      `SELECT id, COALESCE(full_name,'Без имени') AS full_name FROM users WHERE id = $1 LIMIT 1`,
      [workerId]
    );
    const fullName = uRes.rows[0]?.full_name || "Без имени";

    const activeShift = await getActiveShiftToday(workerId);
    if (!activeShift) {
      await ctx.editMessageText("⚠️ У сотрудника нет активной смены сегодня.");
      return;
    }

    const tRes = await pool.query(
      `
    SELECT
      ti.id,
      ti.status,
      tt.title
    FROM task_instances ti
    JOIN task_templates tt ON tt.id = ti.template_id
    WHERE ti.user_id = $1
      AND ti.for_date = CURRENT_DATE
    ORDER BY ti.id
    `,
      [workerId]
    );

    let text = `📝 <b>Задачи смены</b>\n\n`;
    text += `👤 <b>${escHtml(fullName)}</b>\n`;
    text += `📍 Точка: <b>${escHtml(
      activeShift.point_title || "не указано"
    )}</b>\n\n`;

    if (!tRes.rows.length) {
      text += `⚠️ На сегодня задач нет.\n`;
    } else {
      text += `<b>Список задач на сегодня:</b>\n`;
      for (let i = 0; i < tRes.rows.length; i++) {
        const r = tRes.rows[i];
        const icon = r.status === "done" ? "✅" : "▫️";
        text += `${i + 1}. ${icon} ${escHtml(r.title)}\n`;
      }
    }

    const rows = [];
    rows.push([
      Markup.button.callback(
        "➕ создать ещё задачу",
        `admin_shift_tasks_point_${activeShift.trade_point_id}`
      ),
    ]);
    rows.push([
      Markup.button.callback("⬅️ Назад", `admin_worker_open_${workerId}`),
    ]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    });
  });

  // Заглушка: успеваемость
  bot.action(/^lk_worker_performance_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим этот раздел.").catch(() => {});
    } catch (err) {
      logError("lk_worker_performance", err);
    }
  });

  bot.action(/^admin_worker_edit_phone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "work_phone",
      });

      await ctx.reply(
        "Введи рабочий номер для этого сотрудника.\n" +
          "Чтобы очистить — отправь «-».\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_phone", err);
    }
  });

  bot.action(/^admin_worker_edit_username_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "username",
      });

      await ctx.reply(
        "Введи username сотрудника (можно с @).\n" +
          "Чтобы очистить — отправь «-».\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_username", err);
    }
  });

  bot.action(/^admin_worker_edit_name_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "full_name",
      });

      await ctx.reply(
        "Введи новое имя (ФИО) для этого сотрудника.\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_name", err);
    }
  });

  bot.action(/^admin_worker_change_status_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT full_name, staff_status FROM users WHERE id = $1`,
        [workerId]
      );
      if (!res.rows.length) {
        await ctx.reply("Сотрудник не найден.");
        return;
      }
      const u = res.rows[0];

      let text = `✏️ Выбор статуса для: ${u.full_name || "без имени"}\n\n`;
      text += "Выбери статус:";

      const rows = [];

      for (const s of STAFF_STATUSES) {
        const isCurrent = u.staff_status === s.code;
        rows.push([
          Markup.button.callback(
            (isCurrent ? "✅ " : "⚪ ") + s.label,
            `admin_worker_set_status_${workerId}_${s.code}`
          ),
        ]);
      }

      rows.push([
        Markup.button.callback(
          "⬅️ Назад к настройкам",
          `admin_worker_settings_${workerId}`
        ),
      ]);

      const keyboard = Markup.inlineKeyboard(rows);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_worker_change_status", err);
    }
  });

  bot.action(/^admin_worker_set_status_(\d+)_(\w+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const code = ctx.match[2];

      await pool.query(`UPDATE users SET staff_status = $1 WHERE id = $2`, [
        code,
        workerId,
      ]);

      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_set_status", err);
    }
  });

  bot.action(/^admin_worker_change_role_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT full_name, role FROM users WHERE id = $1`,
        [workerId]
      );
      if (!res.rows.length) {
        await ctx.reply("Сотрудник не найден.");
        return;
      }
      const u = res.rows[0];

      if (u.role === "super_admin") {
        await ctx
          .answerCbQuery("Роль супер-админа можно менять только через /more.", {
            show_alert: true,
          })
          .catch(() => {});
        return;
      }

      let text = `✏️ Выбор роли для: ${u.full_name || "без имени"}\n\n`;
      text += "Выбери роль:";

      const rows = [];

      for (const r of ROLES) {
        const isCurrent = u.role === r.code;
        rows.push([
          Markup.button.callback(
            (isCurrent ? "✅ " : "") + r.code,
            `admin_worker_set_role_${workerId}_${r.code}`
          ),
        ]);
      }

      rows.push([
        Markup.button.callback(
          "⬅️ Назад к настройкам",
          `admin_worker_settings_${workerId}`
        ),
      ]);

      const keyboard = Markup.inlineKeyboard(rows);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_worker_change_role", err);
    }
  });

  bot.action(/^admin_worker_set_role_(\d+)_(\w+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const role = ctx.match[2];

      await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [
        role,
        workerId,
      ]);

      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_set_role", err);
    }
  });

  // Текстовый ввод для полей сотрудника (рабочий номер, username, имя)
  bot.on("text", async (ctx, next) => {
    try {
      const state = getWorkerEditState(ctx.from.id);
      if (!state) return next();

      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        clearWorkerEditState(ctx.from.id);
        return next();
      }

      const text = (ctx.message.text || "").trim();
      if (!text) return;

      if (text.toLowerCase() === "/cancel" || text.toLowerCase() === "отмена") {
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Ок, изменения отменены.");
        return;
      }

      const userId = state.userId;

      if (state.field === "age") {
        const candidateId = state.candidateId;
        if (!candidateId) {
          clearWorkerEditState(ctx.from.id);
          await ctx.reply(
            "У сотрудника нет анкеты кандидата — возраст менять нельзя."
          );
          return;
        }

        if (text === "-") {
          await pool.query(`UPDATE candidates SET age = NULL WHERE id = $1`, [
            candidateId,
          ]);
          clearWorkerEditState(ctx.from.id);
          await ctx.reply("Возраст очищен ✅");
          await showWorkerSettingsMenu(ctx, userId, { edit: false });
          return;
        }

        const n = Number(text);
        if (!Number.isInteger(n) || n < 14 || n > 90) {
          await ctx.reply(
            "Возраст должен быть числом от 14 до 90. Или «-» чтобы очистить, или /cancel."
          );
          return;
        }

        await pool.query(`UPDATE candidates SET age = $1 WHERE id = $2`, [
          n,
          candidateId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Возраст обновлён ✅");
        await showWorkerSettingsMenu(ctx, userId, { edit: false });
        return;
      }

      if (state.field === "work_phone") {
        const value = text === "-" ? null : text;
        await pool.query(`UPDATE users SET work_phone = $1 WHERE id = $2`, [
          value,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Рабочий номер обновлён ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      if (state.field === "username") {
        let value = text;
        if (value === "-" || value === "") {
          value = null;
        } else if (value.startsWith("@")) {
          value = value.slice(1);
        }

        await pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [
          value,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Username обновлён ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      if (state.field === "full_name") {
        if (text.length < 2) {
          await ctx.reply(
            "Имя слишком короткое, попробуй ещё раз или /cancel."
          );
          return;
        }

        await pool.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
          text,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Имя сотрудника обновлено ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      return next();
    } catch (err) {
      logError("admin_worker_edit_text", err);
      return next();
    }
  });

  bot.on("text", async (ctx, next) => {
    try {
      // Если админ сейчас НЕ вводит причину отказа — отдаём управление дальше,
      // чтобы не ломать добавление кандидата и прочие сценарии.
      const st = declineReasonStates.get(ctx.from.id);
      if (!st) return next();

      const reason = (ctx.message.text || "").trim();
      if (!reason) return;

      // Сбрасываем режим ввода причины
      declineReasonStates.delete(ctx.from.id);

      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return next();
      }

      await applyCandidateDecline(ctx, st.candidateId, reason, admin.id);
    } catch (err) {
      logError("cand_decline_text_reason", err);
      return next();
    }
  });

  // --- ФИЛЬТРЫ ---

  // Открыть/закрыть фильтр
  bot.action("lk_cand_filter_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);

      // при открытии фильтра — закрываем "раскрыть"
      setCandidateFilters(tgId, {
        filtersExpanded: !filters.filtersExpanded,
        historyExpanded: false,
      });

      await renderUsersTab(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_toggle", err);
    }
  });

  bot.action("lk_workers_filter_onshift", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const f = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { workerOnShift: !f.workerOnShift });

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      await showWorkersListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_workers_filter_onshift", err);
    }
  });

  bot.action("lk_workers_filter_reset", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;

      setCandidateFilters(tgId, {
        workerQual: "all",
        workerProgram: false,
        workerOnShift: false,
      });

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      await showWorkersListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_workers_filter_reset", err);
    }
  });

  // Открыть/закрыть "раскрыть" (история)
  bot.action("lk_cand_toggle_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);

      // при открытии "раскрыть" — закрываем фильтр
      setCandidateFilters(tgId, {
        historyExpanded: !filters.historyExpanded,
        filtersExpanded: false,
      });

      await renderUsersTab(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_toggle_history", err);
    }
  });

  // Заглушка: "Общение с ИИ"
  bot.action("lk_ai_chat_stub", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим 🙂").catch(() => {});
    } catch (err) {
      logError("lk_ai_chat_stub", err);
    }
  });

  bot.action("lk_cand_filter_reset", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      resetCandidateFilters(tgId);
      await renderUsersTab(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_reset", err);
    }
  });

  // Переключение области (личные / все)
  bot.action("lk_cand_filter_scope_personal", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      setCandidateFilters(tgId, { scope: "personal" });
      await renderUsersTab(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_scope_personal", err);
    }
  });

  bot.action("lk_cand_filter_scope_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      setCandidateFilters(tgId, { scope: "all" });
      await renderUsersTab(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_scope_all", err);
    }
  });

  // Переключатели статусов
  bot.action("lk_cand_filter_status_waiting", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { waiting: !filters.waiting });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_waiting", err);
    }
  });

  bot.action("lk_cand_filter_status_arrived", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { arrived: !filters.arrived });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_arrived", err);
    }
  });

  bot.action("lk_cand_filter_status_internship", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, {
        internshipInvited: !filters.internshipInvited,
      });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_internship", err);
    }
  });

  bot.action("lk_cand_filter_status_cancelled", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { cancelled: !filters.cancelled });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_cancelled", err);
    }
  });

  // ================================
  // ОТКАЗ КАНДИДАТУ — ВЫБОР ПРИЧИНЫ
  // ================================
  bot.action(/^lk_cand_decline_reason_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      // Ставим режим ожидания текстовой причины
      declineReasonStates.set(ctx.from.id, { candidateId });

      const text =
        "❓ <b>Укажите причину отказа кандидату</b>\n\n" +
        "Вы можете выбрать причину кнопкой ниже\n" +
        "или написать её текстом сообщением.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🚫 не пришёл и не предупредил",
            `lk_cand_decline_apply_${candidateId}_no_show`
          ),
        ],
        [
          Markup.button.callback(
            "📩 предупредил, что не придёт",
            `lk_cand_decline_apply_${candidateId}_warned`
          ),
        ],
        [
          Markup.button.callback(
            "🤔 странное поведение",
            `lk_cand_decline_apply_${candidateId}_weird`
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Отмена",
            `lk_cand_decline_cancel_${candidateId}`
          ),
        ],
      ]);

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } catch (err) {
      logError("lk_cand_decline_reason", err);
    }
  });

  bot.action(/^lk_cand_decline_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      declineReasonStates.delete(ctx.from.id);

      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_decline_cancel", err);
    }
  });

  async function applyCandidateDecline(ctx, candidateId, reason, adminDbId) {
    // 1) Обновляем кандидата (фиксируем отказ)
    await pool.query(
      `
      UPDATE candidates
         SET status = 'rejected',
             decline_reason = $2,
             declined_at = NOW(),
             is_deferred = false,
             closed_from_status = status,
             closed_by_admin_id = $3
       WHERE id = $1
    `,
      [candidateId, reason, adminDbId || null]
    );

    // 2) Пытаемся уведомить кандидата (ТОЛЬКО если есть привязанный user с telegram_id)
    try {
      const uRes = await pool.query(
        `
        SELECT telegram_id
        FROM users
        WHERE candidate_id = $1
          AND telegram_id IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
        [candidateId]
      );

      const candidateTelegramId = uRes.rows[0]?.telegram_id;

      if (candidateTelegramId) {
        const text =
          "❌ К сожалению, мы не готовы продолжить с вами сотрудничество.\n\n" +
          "Спасибо, что нашли время!";

        await ctx.telegram
          .sendMessage(candidateTelegramId, text)
          .catch(() => {});
      }
    } catch (err) {
      // не валим бота, просто логируем
      console.error("[applyCandidateDecline] notify candidate error", err);
    }

    // 3) Возвращаем карточку админу
    await showCandidateCardLk(ctx, candidateId, { edit: true });
  }

  bot.action(/^lk_cand_decline_apply_(\d+)_no_show$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Не пришёл и не предупредил",
      admin.id
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_warned$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Предупредил, что не придёт",
      admin.id
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_weird$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Странное поведение",
      admin.id
    );
  });
  // ================================
  // ВОССТАНОВЛЕНИЕ КАНДИДАТА
  // ================================
  bot.action(/^lk_cand_restore_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);
      restoreModeStates.set(ctx.from.id, candidateId);

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        restoreMode: true,
      });
    } catch (err) {
      logError("lk_cand_restore", err);
    }
  });

  bot.action(/^lk_cand_restore_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      restoreModeStates.delete(ctx.from.id);

      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_restore_cancel", err);
    }
  });

  bot.action(/^lk_cand_unpostpone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      await pool.query(
        `
      UPDATE candidates
         SET is_deferred = false,
             declined_at = COALESCE(declined_at, NOW())
       WHERE id = $1
      `,
        [candidateId]
      );

      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_unpostpone", err);
    }
  });

  bot.action(/^lk_cand_restore_apply_(\d+)$/, async (ctx) => {
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      // берём состояние ДО апдейта
      const { rows } = await pool.query(
        "SELECT id, closed_from_status FROM candidates WHERE id = $1",
        [candidateId]
      );
      const cand = rows[0];
      if (!cand) return;

      const restoredStatus = cand.closed_from_status || "invited";

      await pool.query(
        `
      UPDATE candidates
         SET status = COALESCE(closed_from_status, 'invited'),
             closed_from_status = NULL,
             decline_reason = NULL,
             declined_at = NULL,
             is_deferred = false,
             closed_by_admin_id = NULL
       WHERE id = $1
      `,
        [candidateId]
      );

      restoreModeStates.delete(ctx.from.id);

      await showCandidateCardLk(ctx, candidateId, { edit: true });

      // ✅ Уведомление кандидату — только если НЕ interviewed
      if (restoredStatus !== "interviewed") {
        const uRes = await pool.query(
          `
  SELECT telegram_id
  FROM users
  WHERE candidate_id = $1
    AND telegram_id IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
  `,
          [candidateId]
        );

        const tgId = uRes.rows[0]?.telegram_id;
        if (tgId) {
          await notifyCandidateAfterRestore(
            { candidateId, restoredStatus, candidateTelegramId: tgId },
            ctx
          );
        }
      }
    } catch (err) {
      logError("lk_cand_restore_apply", err);
    }
  });

  async function notifyCandidateAfterRestore(payload, ctx) {
    const { candidateId, restoredStatus, candidateTelegramId } = payload;

    // 1) Для interviewed — НЕ отправляем ничего
    if (restoredStatus === "interviewed") return;

    // -------------------------
    // helpers
    // -------------------------
    function formatDateRu(date) {
      if (!date) return "не указана";
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return "не указана";
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const weekday = d.toLocaleDateString("ru-RU", { weekday: "short" });
      return `${dd}.${mm} (${weekday})`;
    }

    function escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function normalizePhone(raw) {
      if (!raw) return { display: null, href: null };
      const src = String(raw);
      let digits = src.replace(/\D+/g, "");
      if (digits.length === 11 && digits.startsWith("8")) {
        digits = "7" + digits.slice(1);
      }
      if (digits.length === 11 && digits.startsWith("7")) {
        const v = "+" + digits;
        return { display: v, href: v };
      }
      if (digits.length >= 10) {
        const v = "+" + digits;
        return { display: v, href: v };
      }
      return { display: src.trim(), href: null };
    }

    // -------------------------
    // 2) invited -> полное приглашение на собеседование
    // -------------------------
    if (restoredStatus === "invited") {
      const res = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.age,
          c.interview_date,
          c.interview_time,
          tp.title      AS point_title,
          tp.address    AS point_address,
          tp.landmark   AS point_landmark,
          a.full_name   AS admin_name,
          a.position    AS admin_position,
          a.telegram_id AS admin_telegram_id,
          a.work_phone  AS admin_work_phone
        FROM candidates c
        LEFT JOIN trade_points tp ON tp.id = c.point_id
        LEFT JOIN users a         ON a.id = c.admin_id
        WHERE c.id = $1
      `,
        [candidateId]
      );

      const c = res.rows[0];
      if (!c) return;

      const greetingName = c.name || "Вы";
      const dateStr = formatDateRu(c.interview_date);
      const timeStr = c.interview_time || "не указано";
      const pointAddress = c.point_address || "будет добавлен позже";

      const adminName = c.admin_name || "не указан";
      const adminPosition = c.admin_position || "не указана должность";
      const responsibleLine = `Ответственный: ${adminName}, ${adminPosition}`;

      const phone = normalizePhone(c.admin_work_phone);

      let text =
        `${greetingName}, вы приглашены на собеседование в Green Rocket! 🚀\n\n` +
        "📄 Детали собеседования:\n" +
        `• Дата: ${dateStr}\n` +
        `• Время: ${timeStr}\n` +
        `• Адрес: ${pointAddress}\n` +
        `• ${responsibleLine}\n`;

      if (phone.display) {
        text += `• Телефон для связи: ${phone.display}\n`;
      }

      const keyboardRows = [];

      // Telegram ответственного
      if (c.admin_telegram_id) {
        const firstName = (adminName || "Telegram").split(" ")[0] || "Telegram";
        keyboardRows.push([
          {
            text: `✈️ Telegram ${firstName}`,
            url: `tg://user?id=${c.admin_telegram_id}`,
          },
        ]);
      }

      // Как пройти?
      keyboardRows.push([
        { text: "🧭 Как пройти?", callback_data: "lk_interview_route" },
      ]);

      // Отказаться
      keyboardRows.push([
        {
          text: "❌ Отказаться от собеседования",
          callback_data: "lk_interview_decline",
        },
      ]);

      // 2.1) сообщение кандидату
      await ctx.telegram
        .sendMessage(candidateTelegramId, text, {
          reply_markup: { inline_keyboard: keyboardRows },
        })
        .catch(() => {});

      // 2.2) короткое уведомление ответственному (оставляем как “как в приглашениях”)
      if (c.admin_telegram_id) {
        try {
          const adminTextLines = [];
          adminTextLines.push("♻️ *Восстановление кандидата (собеседование)*");
          adminTextLines.push("");
          adminTextLines.push(
            `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
          );
          adminTextLines.push(`• Дата: ${dateStr}`);
          adminTextLines.push(`• Время: ${timeStr}`);

          const adminKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "👤 Открыть кандидата",
                  callback_data: `lk_cand_open_${candidateId}`,
                },
              ],
              [
                {
                  text: "📋 Мои собеседования",
                  callback_data: "lk_admin_my_interviews",
                },
              ],
            ],
          };

          await ctx.telegram.sendMessage(
            c.admin_telegram_id,
            adminTextLines.join("\n"),
            {
              parse_mode: "Markdown",
              reply_markup: adminKeyboard,
            }
          );
        } catch (err) {
          console.error(
            "[notifyCandidateAfterRestore] notify admin error",
            err
          );
        }
      }

      return;
    }

    // -------------------------
    // 3) internship_invited -> полное приглашение на стажировку + уведомление наставнику
    // -------------------------
    if (restoredStatus === "internship_invited") {
      const cRes = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.age,
          c.internship_date,
          c.internship_time_from,
          c.internship_time_to,
          COALESCE(tp.title, 'не указана') AS point_title,
          COALESCE(tp.address, '') AS point_address,
          COALESCE(tp.landmark, '') AS point_landmark,
          COALESCE(u.full_name, 'не указан') AS mentor_name,
          u.position    AS mentor_position,
          u.telegram_id AS mentor_telegram_id,
          u.work_phone  AS mentor_work_phone
        FROM candidates c
        LEFT JOIN trade_points tp ON tp.id = c.internship_point_id
        LEFT JOIN users u ON u.id = c.internship_admin_id
        WHERE c.id = $1
      `,
        [candidateId]
      );

      const c = cRes.rows[0];
      if (!c) return;

      const datePart = formatDateRu(c.internship_date);
      const timeFromText = c.internship_time_from || "не указано";
      const timeToText = c.internship_time_to || "не указано";

      const pointTitle = c.point_title || "не указана";
      const pointAddress = c.point_address || "будет добавлен позже";
      const mentorName = c.mentor_name || "не указан";

      const phone = normalizePhone(c.mentor_work_phone);

      const nameForText = c.name || "Вы";

      let text =
        `${escapeHtml(
          nameForText
        )}, вы приглашены на стажировку в Green Rocket! 🚀\n\n` +
        `<b>📄 Детали стажировки</b>\n` +
        `• <b>Дата:</b> ${escapeHtml(datePart)}\n` +
        `• <b>Время:</b> с ${escapeHtml(timeFromText)} до ${escapeHtml(
          timeToText
        )}\n` +
        `• <b>Адрес:</b> ${escapeHtml(pointAddress)}\n` +
        `• <b>Наставник:</b> ${escapeHtml(mentorName)}\n`;

      if (phone.display) {
        if (phone.href) {
          text += `• <b>Телефон для связи:</b> <a href="tel:${escapeHtml(
            phone.href
          )}">${escapeHtml(phone.display)}</a>\n`;
        } else {
          text += `• <b>Телефон для связи:</b> ${escapeHtml(phone.display)}\n`;
        }
      }

      const keyboardRows = [];

      // Telegram наставника
      if (c.mentor_telegram_id) {
        const firstName =
          (mentorName || "Telegram").split(" ")[0] || "Telegram";
        keyboardRows.push([
          {
            text: `✈️ Telegram ${firstName}`,
            url: `tg://user?id=${c.mentor_telegram_id}`,
          },
        ]);
      }

      // Как пройти? + По оплате
      keyboardRows.push([
        { text: "🧭 Как пройти?", callback_data: "lk_internship_route" },
        { text: "💰 По оплате", callback_data: "lk_internship_payment" },
      ]);

      // Отказаться
      keyboardRows.push([
        {
          text: "❌ Отказаться от стажировки",
          callback_data: "lk_internship_decline",
        },
      ]);

      // 3.1) сообщение кандидату (HTML)
      await ctx.telegram
        .sendMessage(candidateTelegramId, text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboardRows },
        })
        .catch(() => {});

      // 3.2) уведомление наставнику
      if (c.mentor_telegram_id) {
        try {
          const mentorTextLines = [];
          mentorTextLines.push("♻️ *Восстановление кандидата (стажировка)*");
          mentorTextLines.push("");
          mentorTextLines.push(
            `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
          );
          mentorTextLines.push(`• Дата: ${datePart}`);
          mentorTextLines.push(`• Время: с ${timeFromText} до ${timeToText}`);
          mentorTextLines.push(`• Точка: ${pointTitle}`);
          if (pointAddress) mentorTextLines.push(`• Адрес: ${pointAddress}`);

          const mentorKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "👤 Открыть кандидата",
                  callback_data: `lk_cand_open_${candidateId}`,
                },
              ],
              [
                {
                  text: "📋 Мои стажировки",
                  callback_data: "lk_admin_my_internships",
                },
              ],
            ],
          };

          await ctx.telegram.sendMessage(
            c.mentor_telegram_id,
            mentorTextLines.join("\n"),
            {
              parse_mode: "Markdown",
              reply_markup: mentorKeyboard,
            }
          );
        } catch (err) {
          console.error(
            "[notifyCandidateAfterRestore] notify mentor error",
            err
          );
        }
      }

      return;
    }

    // остальные статусы пока игнорируем
  }
}

module.exports = {
  showCandidatesListLk,
  registerCandidateListHandlers,
};
