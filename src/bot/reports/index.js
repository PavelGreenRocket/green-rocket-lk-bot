const { Markup } = require("telegraf");
const pool = require("../db");
const { deliver, toast } = require("../utils");

const PAGE_SIZE = 10;

// ───────────────────────────────────────────────────────────────
// In-memory state (per Telegram user). Survives within process only.
// ───────────────────────────────────────────────────────────────
const REPORTS_STATE = new Map();

function getSt(tgId) {
  return REPORTS_STATE.get(tgId) || null;
}
function setSt(tgId, patch) {
  const prev = REPORTS_STATE.get(tgId) || {};
  REPORTS_STATE.set(tgId, { ...prev, ...patch });
}
function clrSt(tgId) {
  REPORTS_STATE.delete(tgId);
}

function isAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function fmtMoney(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("ru-RU").format(n);
}

function fmtDateShort(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

const DOW_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function fmtDowShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return DOW_SHORT[d.getDay()];
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function userLabel(row) {
  const name = row.full_name || "—";
  if (row.username) return `${name} @${row.username}`;
  if (row.work_phone) return `${name} ${row.work_phone}`;
  return name;
}

function cashByLabel(row) {
  const name = row.cash_collection_by_name || null;
  const uname = row.cash_collection_by_username
    ? `@${row.cash_collection_by_username}`
    : null;
  return name || uname || null;
}

function normalizeUsername(s) {
  if (!s) return "";
  const t = String(s).trim();
  if (!t) return "";
  return t.startsWith("@") ? t.slice(1) : t;
}

async function purgeOldDeletedReports() {
  // Авто-подчистка: удаляем безвозвратно через 30 дней
  // (без UI восстановления — восстановление вручную через БД).
  try {
    await pool.query(
      `DELETE FROM shift_closings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < (NOW() - INTERVAL '30 days')`
    );
  } catch (_) {
    // если миграцию ещё не применили (нет deleted_at) — молча пропускаем
  }
}

// ───────────────────────────────────────────────────────────────
// DB: reports list
// ───────────────────────────────────────────────────────────────
function buildReportsWhere(filters) {
  const where = [`s.status = 'closed'`];
  const values = [];
  let i = 1;

  const workerIds = Array.isArray(filters?.workerIds) ? filters.workerIds : [];
  const pointIds = Array.isArray(filters?.pointIds) ? filters.pointIds : [];
  const weekdays = Array.isArray(filters?.weekdays) ? filters.weekdays : [];

  if (workerIds.length) {
    values.push(workerIds);
    where.push(`s.user_id = ANY($${i}::int[])`);
    i += 1;
  }
  if (pointIds.length) {
    values.push(pointIds);
    where.push(`s.trade_point_id = ANY($${i}::int[])`);
    i += 1;
  }
  if (weekdays.length) {
    values.push(weekdays);
    where.push(`EXTRACT(ISODOW FROM s.opened_at) = ANY($${i}::int[])`);
    i += 1;
  }

  return { whereSql: where.join(" AND "), values, nextIdx: i };
}

async function loadReportsPage({ page, filters }) {
  const offset = Math.max(0, page) * PAGE_SIZE;
  const limit = PAGE_SIZE;

  const { whereSql, values, nextIdx } = buildReportsWhere(filters);

  // Сначала пробуем с deleted_at (после миграции)
  const sqlWithDelete = `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      tp.title AS trade_point_title,

      u.full_name,
      u.username,
      u.work_phone,

      sc.sales_total,
      sc.sales_cash,
      sc.cash_in_drawer,
      sc.was_cash_collection,
      sc.cash_collection_amount,
      sc.cash_collection_by_user_id,
      sc.checks_count,

      cu.full_name AS cash_collection_by_name,
      cu.username  AS cash_collection_by_username

    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users cu ON cu.id = sc.cash_collection_by_user_id
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id

    WHERE ${whereSql}
      AND sc.deleted_at IS NULL

    ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
    LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
  `;

  const sqlNoDelete = `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      tp.title AS trade_point_title,

      u.full_name,
      u.username,
      u.work_phone,

      sc.sales_total,
      sc.sales_cash,
      sc.cash_in_drawer,
      sc.was_cash_collection,
      sc.cash_collection_amount,
      sc.cash_collection_by_user_id,
      sc.checks_count,

      cu.full_name AS cash_collection_by_name,
      cu.username  AS cash_collection_by_username

    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users cu ON cu.id = sc.cash_collection_by_user_id
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id

    WHERE ${whereSql}

    ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
    LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
  `;

  const params = [...values, limit + 1, offset];

  try {
    const r = await pool.query(sqlWithDelete, params);
    const rows = r.rows.slice(0, limit);
    const hasMore = r.rows.length > limit;
    return { rows, hasMore };
  } catch (e) {
    // fallback до миграции
    const r = await pool.query(sqlNoDelete, params);
    const rows = r.rows.slice(0, limit);
    const hasMore = r.rows.length > limit;
    return { rows, hasMore };
  }
}

async function loadUsersPage({ page, search }) {
  const offset = Math.max(0, page) * PAGE_SIZE;
  const limit = PAGE_SIZE;

  const s = String(search || "").trim();
  const isId = /^\d+$/.test(s);
  const uname = normalizeUsername(s);

  let sql = `
    SELECT id, full_name, username, work_phone
    FROM users
  `;
  const vals = [];
  const where = [];

  if (s) {
    if (isId) {
      vals.push(Number(s));
      where.push(`id = $${vals.length}`);
    } else if (uname) {
      vals.push(`%${uname.toLowerCase()}%`);
      where.push(`LOWER(username) LIKE $${vals.length}`);
    }
  }

  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

  sql += `
    ORDER BY full_name NULLS LAST, id
    LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}
  `;

  vals.push(limit + 1, offset);

  const r = await pool.query(sql, vals);
  const rows = r.rows.slice(0, limit);
  const hasMore = r.rows.length > limit;
  return { rows, hasMore };
}

async function loadTradePointsPage({ page }) {
  const offset = Math.max(0, page) * PAGE_SIZE;
  const limit = PAGE_SIZE;

  const r = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    ORDER BY title NULLS LAST, id
    LIMIT $1 OFFSET $2
    `,
    [limit + 1, offset]
  );
  const rows = r.rows.slice(0, limit);
  const hasMore = r.rows.length > limit;
  return { rows, hasMore };
}

async function loadReportByShiftId(shiftId) {
  const r = await pool.query(
    `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      tp.title AS trade_point_title,

      u.full_name,
      u.username,
      u.work_phone,

      sc.sales_total,
      sc.sales_cash,
      sc.cash_in_drawer,
      sc.was_cash_collection,
      sc.cash_collection_amount,
      sc.cash_collection_by_user_id,
      sc.checks_count,

      cu.full_name AS cash_collection_by_name,
      cu.username  AS cash_collection_by_username

    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users cu ON cu.id = sc.cash_collection_by_user_id
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id

    WHERE s.id = $1
    `,
    [shiftId]
  );
  return r.rows[0] || null;
}

// ───────────────────────────────────────────────────────────────
// Render helpers
// ───────────────────────────────────────────────────────────────
function formatReportCard(row, idx, { admin, elements, selectedMark = "" }) {
  const lines = [];

  // 1) сотрудник (username если есть, если нет — номер)
  lines.push(`${idx}. ${selectedMark}${userLabel(row)}`.trim());

  // 2) дата + день недели
  const date = fmtDateShort(row.opened_at);
  const dow = fmtDowShort(row.opened_at);
  lines.push(`${date} (${dow})`.trim());

  // 3) точка (+ время для админа)
  const tp = row.trade_point_title || `Точка #${row.trade_point_id}`;
  if (admin) {
    const from = fmtTime(row.opened_at);
    const to = row.closed_at ? fmtTime(row.closed_at) : "-";
    lines.push(`${tp} (с ${from} до ${to})`);
  } else {
    lines.push(tp);
  }

  const set = new Set(Array.isArray(elements) ? elements : []);

  if (set.has("sales_total")) {
    lines.push(`Сумма продаж: ${fmtMoney(row.sales_total)}`);
  }
  if (set.has("sales_cash")) {
    lines.push(`Наличными: ${fmtMoney(row.sales_cash)}`);
  }
  if (set.has("cash_in_drawer")) {
    lines.push(`В кассе: ${fmtMoney(row.cash_in_drawer)}`);
  }
  if (set.has("cash_collection")) {
    if (row.was_cash_collection) {
      const who = cashByLabel(row);
      const amount = fmtMoney(row.cash_collection_amount);
      lines.push(
        who ? `Инкассация: ${amount} (${who})` : `Инкассация: ${amount}`
      );
    } else if (row.was_cash_collection === false) {
      lines.push("Инкассация: Нет");
    } else {
      lines.push("Инкассация: -");
    }
  }
  if (set.has("checks_count")) {
    lines.push(`Чеков: ${row.checks_count ?? "-"}`);
  }

  return lines.join("\n");
}

function defaultElementsFor(user) {
  const base = [
    "sales_total",
    "sales_cash",
    "cash_in_drawer",
    "cash_collection",
    "checks_count",
  ];
  if (isAdmin(user)) return [...base, "time"];
  return base;
}

function buildFiltersSummary(filters) {
  const parts = [];
  const w = Array.isArray(filters?.workerIds) ? filters.workerIds.length : 0;
  const p = Array.isArray(filters?.pointIds) ? filters.pointIds.length : 0;
  const d = Array.isArray(filters?.weekdays) ? filters.weekdays.length : 0;

  if (w) parts.push(`сотр.: ${w}`);
  if (p) parts.push(`точки: ${p}`);
  if (d) parts.push(`дни: ${d}`);

  return parts.length ? `Фильтры: ${parts.join(" · ")}` : "Фильтры: нет";
}

// ───────────────────────────────────────────────────────────────
// Screens
// ───────────────────────────────────────────────────────────────
async function showReportsList(ctx, user, { edit = true } = {}) {
  const admin = isAdmin(user);
  setSt(ctx.from.id, { view: "list" });

  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = admin ? st.filters || {} : { workerIds: [user.id] };
  const elements = st.elements || defaultElementsFor(user);

  // housekeeping (best-effort)
  await purgeOldDeletedReports();

  const { rows, hasMore } = await loadReportsPage({ page, filters });

  const header = "📊 <b>Отчёты</b>";
  const filterLine = admin ? buildFiltersSummary(filters) : "";
  const body = rows.length
    ? rows
        .map((r, i) =>
          formatReportCard(r, i + 1 + page * PAGE_SIZE, {
            admin,
            elements,
          })
        )
        .join("\n\n")
    : "Пока нет закрытых смен.";

  const text = [header, filterLine, "", body].filter(Boolean).join("\n");

  const buttons = [];

  // top controls
  if (admin) {
    const filterOpened = Boolean(st.filterOpened);
    buttons.push([
      Markup.button.callback(
        filterOpened ? "▴ Фильтр" : "▾ Фильтр",
        "lk_reports_filter_toggle"
      ),
      Markup.button.callback("⚙️ Настройки", "lk_reports_settings"),
    ]);
  } else {
    buttons.push([
      Markup.button.callback("✏️ Изменить отчёт", "lk_reports_edit_last"),
    ]);
  }

  // expanded filter menu
  if (admin && st.filterOpened) {
    buttons.push([
      Markup.button.callback("👥 По сотрудникам", "lk_reports_filter_workers"),
      Markup.button.callback("🏬 По точке", "lk_reports_filter_points"),
    ]);
    buttons.push([
      Markup.button.callback("📆 По дням недели", "lk_reports_filter_weekdays"),
      Markup.button.callback("▾ По элементам", "lk_reports_filter_elements"),
    ]);
    buttons.push([
      Markup.button.callback("📅 Выбрать дату", "lk_reports_filter_date"),
    ]);
    buttons.push([
      Markup.button.callback("ℹ️ Доп. информация", "lk_reports_filter_info"),
    ]);
    buttons.push([
      Markup.button.callback("🧹 Сбросить фильтр", "lk_reports_filter_clear"),
    ]);
  }

  if (hasMore) {
    buttons.push([Markup.button.callback("➡️ ещё", "lk_reports_more")]);
  }
  buttons.push([Markup.button.callback("⬅️ К смене", "lk_profile_shift")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showFiltersWorkers(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "fw" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
  const search = st.pickerSearch || "";
  const filters = st.filters || {};
  const selected = new Set(
    Array.isArray(filters.workerIds) ? filters.workerIds : []
  );

  const { rows, hasMore } = await loadUsersPage({ page, search });

  const title = "👥 <b>Фильтр по сотрудникам</b>";
  const info = [
    `Выбрано: <b>${selected.size}</b>`,
    search ? `Поиск: <b>${search}</b>` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const listText = rows.length
    ? rows
        .map((u) => {
          const label =
            u.full_name || (u.username ? `@${u.username}` : `ID ${u.id}`);
          const mark = selected.has(u.id) ? "✅" : "☑️";
          const extra = u.username ? `@${u.username}` : u.work_phone || "";
          return `${mark} ${label}${extra ? ` (${extra})` : ""}`;
        })
        .join("\n")
    : "Ничего не найдено.";

  const text = `${title}\n${info}${listText}`;

  const buttons = [];

  // toggle buttons (1 per row for reliability)
  for (const u of rows) {
    const labelBase =
      u.full_name || (u.username ? `@${u.username}` : `ID ${u.id}`);
    const mark = selected.has(u.id) ? "✅" : "☑️";
    buttons.push([
      Markup.button.callback(
        `${mark} ${labelBase}`,
        `lk_reports_fw_toggle_${u.id}`
      ),
    ]);
  }

  // nav row
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", "lk_reports_fw_prev"));
  if (hasMore) nav.push(Markup.button.callback("➡️", "lk_reports_fw_next"));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback("🔎 Поиск", "lk_reports_fw_search")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showFiltersPoints(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "tp" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
  const filters = st.filters || {};
  const selected = new Set(
    Array.isArray(filters.pointIds) ? filters.pointIds : []
  );

  const { rows, hasMore } = await loadTradePointsPage({ page });

  const title = "🏬 <b>Фильтр по точкам</b>";
  const info = `Выбрано: <b>${selected.size}</b>\n`;
  const text = `${title}\n${info}`;

  const buttons = [];

  buttons.push([
    Markup.button.callback(
      "✅ Выбрать всё (на странице)",
      "lk_reports_tp_toggle_page"
    ),
  ]);

  for (const tp of rows) {
    const mark = selected.has(tp.id) ? "✅" : "☑️";
    buttons.push([
      Markup.button.callback(
        `${mark} ${tp.title || `Точка #${tp.id}`}`,
        `lk_reports_tp_toggle_${tp.id}`
      ),
    ]);
  }

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", "lk_reports_tp_prev"));
  if (hasMore) nav.push(Markup.button.callback("➡️", "lk_reports_tp_next"));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showFiltersWeekdays(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "dow" });
  const st = getSt(ctx.from.id) || {};
  const filters = st.filters || {};
  const selected = new Set(
    Array.isArray(filters.weekdays) ? filters.weekdays : []
  );

  const title = "📆 <b>Фильтр по дням недели</b>\n";
  const text = title;

  const btn = (isoDow, label) => {
    const mark = selected.has(isoDow) ? "✅" : "☑️";
    return Markup.button.callback(
      `${mark} ${label}`,
      `lk_reports_dow_${isoDow}`
    );
  };

  const buttons = [
    [btn(1, "пн"), btn(2, "вт"), btn(3, "ср")],
    [btn(4, "чт"), btn(5, "пт"), btn(6, "сб")],
    [btn(7, "вс")],
    [Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showFiltersElements(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "el" });
  const st = getSt(ctx.from.id) || {};
  const elements = Array.isArray(st.elements)
    ? st.elements
    : defaultElementsFor(user);
  const set = new Set(elements);

  const title = "▾ <b>Элементы отчёта</b>\n";
  const text = title;

  const items = [
    ["sales_total", "Сумма продаж"],
    ["sales_cash", "Наличными"],
    ["cash_in_drawer", "В кассе"],
    ["cash_collection", "Инкассация"],
    ["checks_count", "Чеков"],
  ];

  const buttons = [];

  for (const [key, label] of items) {
    const mark = set.has(key) ? "✅" : "☑️";
    buttons.push([
      Markup.button.callback(`${mark} ${label}`, `lk_reports_el_${key}`),
    ]);
  }

  buttons.push([Markup.button.callback("✅ Выбрать всё", "lk_reports_el_all")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showSettings(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "settings" });
  const text = "⚙️ <b>Настройки отчётов</b>";

  const buttons = [
    [Markup.button.callback("🗑 Удалить отчёты", "lk_reports_delete_mode")],
    [Markup.button.callback("✏️ Изменить отчёт", "lk_reports_edit_pick")],
    [Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showDeleteMode(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "delete" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = st.filters || {};
  const selected = new Set(Array.isArray(st.delSelected) ? st.delSelected : []);

  const { rows, hasMore } = await loadReportsPage({ page, filters });

  const header = "🗑 <b>Удаление отчётов</b>";
  const body = rows.length
    ? rows
        .map((r, i) => {
          const mark = selected.has(r.shift_id) ? "❌ " : "";
          return formatReportCard(r, i + 1 + page * PAGE_SIZE, {
            admin: true,
            elements: defaultElementsFor(user),
            selectedMark: mark,
          });
        })
        .join("\n\n")
    : "Нечего удалять (нет закрытых смен по фильтру).";

  const text = `${header}\n\n${body}`;

  const buttons = [];

  // number buttons for quick toggle
  const rowBtns = [];
  for (const r of rows) {
    const n = rowBtns.length + 1;
    const isSel = selected.has(r.shift_id);
    rowBtns.push(
      Markup.button.callback(
        isSel ? `❌${n}` : `${n}`,
        `lk_reports_del_${r.shift_id}`
      )
    );
    if (rowBtns.length === 5) {
      buttons.push([...rowBtns]);
      rowBtns.length = 0;
    }
  }
  if (rowBtns.length) buttons.push([...rowBtns]);

  buttons.push([
    Markup.button.callback("🗑 Удалить выбранное", "lk_reports_del_confirm"),
  ]);

  if (hasMore)
    buttons.push([Markup.button.callback("➡️ ещё", "lk_reports_more")]);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_settings")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showDeleteConfirm(ctx, user, { edit = true } = {}) {
  const st = getSt(ctx.from.id) || {};
  const selected = Array.isArray(st.delSelected) ? st.delSelected : [];
  const n = selected.length;

  const text =
    n === 0
      ? "Вы ничего не выбрали."
      : `Удалить <b>${n}</b> отчётов?\n\nМожно восстановить в течение 30 дней (через БД).`;

  const buttons =
    n === 0
      ? [[Markup.button.callback("⬅️ Назад", "lk_reports_delete_mode")]]
      : [
          [Markup.button.callback("✅ Да, удалить", "lk_reports_del_do")],
          [Markup.button.callback("⬅️ Отмена", "lk_reports_delete_mode")],
        ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showEditPick(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "edit_pick" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = st.filters || {};

  const { rows, hasMore } = await loadReportsPage({ page, filters });

  const header = "✏️ <b>Выберите отчёт для изменения</b>";
  const body = rows.length
    ? rows
        .map((r, i) =>
          formatReportCard(r, i + 1 + page * PAGE_SIZE, {
            admin: true,
            elements: defaultElementsFor(user),
          })
        )
        .join("\n\n")
    : "Нет закрытых смен по фильтру.";

  const text = `${header}\n\n${body}`;

  const buttons = [];

  // number buttons open editor
  const rowBtns = [];
  for (const r of rows) {
    const n = rowBtns.length + 1;
    rowBtns.push(
      Markup.button.callback(`${n}`, `lk_reports_edit_open_${r.shift_id}`)
    );
    if (rowBtns.length === 5) {
      buttons.push([...rowBtns]);
      rowBtns.length = 0;
    }
  }
  if (rowBtns.length) buttons.push([...rowBtns]);

  if (hasMore)
    buttons.push([Markup.button.callback("➡️ ещё", "lk_reports_more")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_settings")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showEditMenu(ctx, user, shiftId, { edit = true } = {}) {
  const admin = isAdmin(user);
  setSt(ctx.from.id, { view: "edit_menu" });

  const row = await loadReportByShiftId(shiftId);
  if (!row) {
    return deliver(
      ctx,
      {
        text: "Отчёт не найден.",
        extra: {
          ...(Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")],
          ]) || {}),
          parse_mode: "HTML",
        },
      },
      { edit }
    );
  }

  // безопасность: сотрудник может менять только последнюю свою закрытую смену
  if (!admin) {
    const r = await pool.query(
      `
      SELECT s.id
      FROM shifts s
      WHERE s.user_id = $1
        AND s.status = 'closed'
      ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
      LIMIT 1
      `,
      [user.id]
    );
    const last = r.rows[0]?.id;
    if (!last || Number(last) !== Number(shiftId)) {
      await toast(ctx, "Можно изменить только последний отчёт.");
      return showReportsList(ctx, user, { edit: true });
    }
  }

  // сохраняем активный shiftId в state
  setSt(ctx.from.id, { editShiftId: shiftId, await: null });

  const elements = [
    "sales_total",
    "sales_cash",
    "cash_in_drawer",
    "cash_collection",
    "checks_count",
  ];
  const card = formatReportCard(row, 1, { admin, elements });

  const text = `✏️ <b>Редактирование отчёта</b>\n\n${card}\n\nВыберите поле:`;

  const buttons = [
    [
      Markup.button.callback(
        "Сумма продаж",
        "lk_reports_edit_field_sales_total"
      ),
    ],
    [Markup.button.callback("Наличными", "lk_reports_edit_field_sales_cash")],
    [Markup.button.callback("В кассе", "lk_reports_edit_field_cash_in_drawer")],
    [
      Markup.button.callback(
        "Инкассация",
        "lk_reports_edit_field_cash_collection_amount"
      ),
    ],
    [Markup.button.callback("Чеков", "lk_reports_edit_field_checks_count")],
  ];

  if (admin) {
    buttons.push([
      Markup.button.callback("Кто инкассировал", "lk_reports_edit_cash_by"),
    ]);
    buttons.push([
      Markup.button.callback("Время работы", "lk_reports_edit_time"),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "⬅️ Назад",
      admin ? "lk_reports_edit_pick" : "lk_reports_back_to_list"
    ),
  ]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function askEditValue(ctx, user, fieldKey, { edit = true } = {}) {
  const st = getSt(ctx.from.id) || {};
  const shiftId = st.editShiftId;
  if (!shiftId) {
    await toast(ctx, "Сначала выберите отчёт.");
    return showReportsList(ctx, user, { edit: true });
  }

  setSt(ctx.from.id, { await: { type: "edit_field", fieldKey } });

  const hints = {
    sales_total: "Введите новую сумму продаж (числом).",
    sales_cash: "Введите новую сумму наличных продаж (числом).",
    cash_in_drawer: "Введите новую сумму наличных в кассе (числом).",
    cash_collection_amount:
      "Введите сумму инкассации (числом). Если инкассации не было — введите 0.",
    checks_count: "Введите количество чеков (целым числом).",
  };

  const text = `✏️ <b>Редактирование</b>\n\n${
    hints[fieldKey] || "Введите значение."
  }`;

  const buttons = [
    [Markup.button.callback("⬅️ Назад", "lk_reports_edit_back")],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function askEditCashBy(ctx, user, { edit = true } = {}) {
  const st = getSt(ctx.from.id) || {};
  const shiftId = st.editShiftId;
  if (!shiftId) {
    await toast(ctx, "Сначала выберите отчёт.");
    return showReportsList(ctx, user, { edit: true });
  }

  setSt(ctx.from.id, { await: { type: "edit_cash_by" } });

  const text =
    "✏️ <b>Кто инкассировал</b>\n\nВведите id или @username сотрудника.\nЧтобы очистить — отправьте '-'.";
  const buttons = [
    [Markup.button.callback("⬅️ Назад", "lk_reports_edit_back")],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function askEditTime(ctx, user, { edit = true } = {}) {
  const st = getSt(ctx.from.id) || {};
  const shiftId = st.editShiftId;
  if (!shiftId) {
    await toast(ctx, "Сначала выберите отчёт.");
    return showReportsList(ctx, user, { edit: true });
  }

  setSt(ctx.from.id, { await: { type: "edit_time" } });

  const text =
    "✏️ <b>Время работы</b>\n\nВведите время в формате <b>08:00-20:00</b>.\nЕсли закрытие неизвестно — <b>08:00-</b> (тире в конце).";
  const buttons = [
    [Markup.button.callback("⬅️ Назад", "lk_reports_edit_back")],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

// ───────────────────────────────────────────────────────────────
// Register
// ───────────────────────────────────────────────────────────────
function registerReports(bot, ensureUser, logError) {
  // Entry
  bot.action("lk_reports", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setSt(ctx.from.id, {
        page: 0,
        filterOpened: false,
        filters: { workerIds: [], pointIds: [], weekdays: [] },
        elements: defaultElementsFor(user),
        pickerPage: 0,
        pickerSearch: "",
        delSelected: [],
        editShiftId: null,
        await: null,
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports", e);
    }
  });

  // Pagination (used in list/delete/edit pick). Just increments page and re-render current view.
  bot.action("lk_reports_more", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const nextPage = (Number.isInteger(st.page) ? st.page : 0) + 1;
      setSt(ctx.from.id, { page: nextPage });

      // Decide by last view
      if (st.view === "delete")
        return showDeleteMode(ctx, user, { edit: true });
      if (st.view === "edit_pick")
        return showEditPick(ctx, user, { edit: true });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_more", e);
    }
  });

  // Filter toggle
  bot.action("lk_reports_filter_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, { filterOpened: !st.filterOpened, view: "list" });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_toggle", e);
    }
  });

  // Filter: workers
  bot.action("lk_reports_filter_workers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "fw", pickerPage: 0, pickerSearch: "" });
      await showFiltersWorkers(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_workers", e);
    }
  });

  bot.action(/^lk_reports_fw_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const id = Number(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};
      const arr = Array.isArray(filters.workerIds)
        ? [...filters.workerIds]
        : [];
      const has = arr.includes(id);
      const next = has ? arr.filter((x) => x !== id) : [...arr, id];

      setSt(ctx.from.id, { filters: { ...filters, workerIds: next } });
      await showFiltersWorkers(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_fw_toggle", e);
    }
  });

  bot.action("lk_reports_fw_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
      setSt(ctx.from.id, { pickerPage: Math.max(0, page - 1) });
      await showFiltersWorkers(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_fw_prev", e);
    }
  });

  bot.action("lk_reports_fw_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
      setSt(ctx.from.id, { pickerPage: page + 1 });
      await showFiltersWorkers(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_fw_next", e);
    }
  });

  bot.action("lk_reports_fw_search", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { await: { type: "fw_search" } });

      const text = "🔎 <b>Поиск сотрудника</b>\n\nВведите id или @username.";
      const buttons = [
        [Markup.button.callback("⬅️ Назад", "lk_reports_filter_workers")],
      ];

      await deliver(
        ctx,
        {
          text,
          extra: {
            ...(Markup.inlineKeyboard(buttons) || {}),
            parse_mode: "HTML",
          },
        },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_fw_search", e);
    }
  });

  // Filter: points
  bot.action("lk_reports_filter_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "tp", pickerPage: 0 });
      await showFiltersPoints(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_points", e);
    }
  });

  bot.action(/^lk_reports_tp_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const id = Number(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};
      const arr = Array.isArray(filters.pointIds) ? [...filters.pointIds] : [];
      const has = arr.includes(id);
      const next = has ? arr.filter((x) => x !== id) : [...arr, id];

      setSt(ctx.from.id, { filters: { ...filters, pointIds: next } });
      await showFiltersPoints(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_tp_toggle", e);
    }
  });

  bot.action("lk_reports_tp_toggle_page", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
      const { rows } = await loadTradePointsPage({ page });
      const pageIds = rows.map((x) => x.id);

      const filters = st.filters || {};
      const cur = new Set(
        Array.isArray(filters.pointIds) ? filters.pointIds : []
      );

      const allSelected = pageIds.every((id) => cur.has(id));
      if (allSelected) {
        // снять все на странице
        for (const id of pageIds) cur.delete(id);
      } else {
        // выбрать все на странице
        for (const id of pageIds) cur.add(id);
      }

      setSt(ctx.from.id, {
        filters: { ...filters, pointIds: Array.from(cur) },
      });
      await showFiltersPoints(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_tp_toggle_page", e);
    }
  });

  bot.action("lk_reports_tp_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
      setSt(ctx.from.id, { pickerPage: Math.max(0, page - 1) });
      await showFiltersPoints(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_tp_prev", e);
    }
  });

  bot.action("lk_reports_tp_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
      setSt(ctx.from.id, { pickerPage: page + 1 });
      await showFiltersPoints(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_tp_next", e);
    }
  });

  // Filter: weekdays
  bot.action("lk_reports_filter_weekdays", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "dow" });
      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_weekdays", e);
    }
  });

  bot.action(/^lk_reports_dow_(\d)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const isoDow = Number(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};
      const arr = Array.isArray(filters.weekdays) ? [...filters.weekdays] : [];
      const has = arr.includes(isoDow);
      const next = has ? arr.filter((x) => x !== isoDow) : [...arr, isoDow];

      setSt(ctx.from.id, { filters: { ...filters, weekdays: next } });
      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_toggle", e);
    }
  });

  // Filter: elements
  bot.action("lk_reports_filter_elements", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "el" });
      await showFiltersElements(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_elements", e);
    }
  });

  bot.action(/^lk_reports_el_([a-z_]+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const key = ctx.match[1];
      const st = getSt(ctx.from.id) || {};
      const arr = Array.isArray(st.elements)
        ? [...st.elements]
        : defaultElementsFor(user);
      const set = new Set(arr);

      if (set.has(key)) set.delete(key);
      else set.add(key);

      setSt(ctx.from.id, { elements: Array.from(set) });
      await showFiltersElements(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_el_toggle", e);
    }
  });

  bot.action("lk_reports_el_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setSt(ctx.from.id, { elements: defaultElementsFor(user) });
      await showFiltersElements(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_el_all", e);
    }
  });

  // Stubs
  bot.action("lk_reports_filter_date", async (ctx) => {
    await ctx
      .answerCbQuery("В разработке.", { show_alert: true })
      .catch(() => {});
  });
  bot.action("lk_reports_filter_info", async (ctx) => {
    await ctx
      .answerCbQuery("В разработке.", { show_alert: true })
      .catch(() => {});
  });

  bot.action("lk_reports_filter_clear", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, {
        filters: { workerIds: [], pointIds: [], weekdays: [] },
        page: 0,
      });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_clear", e);
    }
  });

  // Back to list
  bot.action("lk_reports_back_to_list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      // reset picker state
      setSt(ctx.from.id, {
        view: "list",
        pickerPage: 0,
        pickerSearch: "",
        await: null,
      });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_back_to_list", e);
    }
  });

  // Settings (admin only)
  bot.action("lk_reports_settings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, { view: "settings", page: 0, await: null });
      await showSettings(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_settings", e);
    }
  });

  // Delete mode (admin)
  bot.action("lk_reports_delete_mode", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "delete", page: 0, delSelected: [] });
      await showDeleteMode(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_delete_mode", e);
    }
  });

  bot.action(/^lk_reports_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const shiftId = Number(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      const arr = Array.isArray(st.delSelected) ? [...st.delSelected] : [];
      const has = arr.includes(shiftId);
      const next = has ? arr.filter((x) => x !== shiftId) : [...arr, shiftId];
      setSt(ctx.from.id, { delSelected: next });

      await showDeleteMode(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_del_toggle", e);
    }
  });

  bot.action("lk_reports_del_confirm", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      await showDeleteConfirm(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_del_confirm", e);
    }
  });

  bot.action("lk_reports_del_do", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const selected = Array.isArray(st.delSelected) ? st.delSelected : [];
      if (!selected.length) {
        await toast(ctx, "Ничего не выбрано.");
        return showDeleteMode(ctx, user, { edit: true });
      }

      // soft delete
      try {
        await pool.query(
          `UPDATE shift_closings
           SET deleted_at = NOW(),
               deleted_by_user_id = $1
           WHERE shift_id = ANY($2::int[])`,
          [user.id, selected]
        );
      } catch (e) {
        // если миграции нет — не ломаемся, но сообщаем
        await toast(
          ctx,
          "Нет полей deleted_at/deleted_by_user_id (нужна миграция)."
        );
        return showDeleteMode(ctx, user, { edit: true });
      }

      setSt(ctx.from.id, { delSelected: [], page: 0 });
      await toast(ctx, "Удалено.");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_del_do", e);
    }
  });

  // Edit pick (admin)
  bot.action("lk_reports_edit_pick", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { view: "edit_pick", page: 0, await: null });
      await showEditPick(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_pick", e);
    }
  });

  bot.action(/^lk_reports_edit_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      await showEditMenu(ctx, user, shiftId, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_open", e);
    }
  });

  // Edit last (worker)
  bot.action("lk_reports_edit_last", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const admin = isAdmin(user);
      if (admin) {
        // админ редактирует через settings
        return toast(ctx, "Откройте через ⚙️ Настройки → ✏️ Изменить отчёт.");
      }

      const r = await pool.query(
        `
        SELECT s.id
        FROM shifts s
        WHERE s.user_id = $1
          AND s.status = 'closed'
        ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
        LIMIT 1
        `,
        [user.id]
      );
      const shiftId = r.rows[0]?.id;
      if (!shiftId) {
        await toast(ctx, "Нет закрытых смен.");
        return showReportsList(ctx, user, { edit: true });
      }

      await showEditMenu(ctx, user, Number(shiftId), { edit: true });
    } catch (e) {
      logError("lk_reports_edit_last", e);
    }
  });

  // Edit menu actions
  bot.action(/^lk_reports_edit_field_([a-z_]+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const fieldKey = ctx.match[1];
      await askEditValue(ctx, user, fieldKey, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_field", e);
    }
  });

  bot.action("lk_reports_edit_cash_by", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      await askEditCashBy(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_cash_by", e);
    }
  });

  bot.action("lk_reports_edit_time", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      await askEditTime(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_time", e);
    }
  });

  bot.action("lk_reports_edit_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const shiftId = st.editShiftId;
      if (!shiftId) return showReportsList(ctx, user, { edit: true });

      await showEditMenu(ctx, user, shiftId, { edit: true });
    } catch (e) {
      logError("lk_reports_edit_back", e);
    }
  });

  // Text input handler (search + edit fields)
  bot.on("text", async (ctx) => {
    const st = getSt(ctx.from.id);
    if (!st?.await) return;

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const payload = st.await || {};
      const msg = (ctx.message?.text || "").trim();

      // search workers
      if (payload.type === "fw_search") {
        setSt(ctx.from.id, { pickerSearch: msg, pickerPage: 0, await: null });
        return showFiltersWorkers(ctx, user, { edit: true });
      }

      // edit field
      if (payload.type === "edit_field") {
        const shiftId = st.editShiftId;
        const fieldKey = payload.fieldKey;

        if (!shiftId || !fieldKey) {
          setSt(ctx.from.id, { await: null });
          return showReportsList(ctx, user, { edit: true });
        }

        const num = Number(String(msg).replace(",", "."));
        if (Number.isNaN(num)) {
          await toast(ctx, "Введите число.");
          return;
        }

        if (fieldKey === "checks_count" && !Number.isInteger(num)) {
          await toast(ctx, "Введите целое число.");
          return;
        }

        // cash_collection_amount: 0 => "не было"
        if (fieldKey === "cash_collection_amount") {
          if (num <= 0) {
            await pool.query(
              `
              UPDATE shift_closings
              SET was_cash_collection = false,
                  cash_collection_amount = NULL,
                  cash_collection_by_user_id = NULL
              WHERE shift_id = $1
              `,
              [shiftId]
            );
          } else {
            await pool.query(
              `
              UPDATE shift_closings
              SET was_cash_collection = true,
                  cash_collection_amount = $2
              WHERE shift_id = $1
              `,
              [shiftId, num]
            );
          }
        } else {
          const map = {
            sales_total: "sales_total",
            sales_cash: "sales_cash",
            cash_in_drawer: "cash_in_drawer",
            checks_count: "checks_count",
          };
          const col = map[fieldKey];
          if (!col) {
            await toast(ctx, "Поле не поддерживается.");
            setSt(ctx.from.id, { await: null });
            return showEditMenu(ctx, user, shiftId, { edit: true });
          }

          await pool.query(
            `UPDATE shift_closings SET ${col} = $2 WHERE shift_id = $1`,
            [shiftId, fieldKey === "checks_count" ? Math.trunc(num) : num]
          );
        }

        setSt(ctx.from.id, { await: null });
        await toast(ctx, "Сохранено.");
        return showEditMenu(ctx, user, shiftId, { edit: true });
      }

      // edit cash by (admin)
      if (payload.type === "edit_cash_by") {
        if (!isAdmin(user)) {
          setSt(ctx.from.id, { await: null });
          return;
        }

        const shiftId = st.editShiftId;
        if (!shiftId) return;

        if (msg === "-" || msg === "—") {
          await pool.query(
            `UPDATE shift_closings SET cash_collection_by_user_id = NULL WHERE shift_id = $1`,
            [shiftId]
          );
          setSt(ctx.from.id, { await: null });
          await toast(ctx, "Очищено.");
          return showEditMenu(ctx, user, shiftId, { edit: true });
        }

        const isId = /^\d+$/.test(msg);
        const uname = normalizeUsername(msg);

        const q = isId
          ? await pool.query(`SELECT id FROM users WHERE id = $1`, [
              Number(msg),
            ])
          : await pool.query(
              `SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
              [uname]
            );

        const foundId = q.rows[0]?.id;
        if (!foundId) {
          await toast(ctx, "Пользователь не найден.");
          return;
        }

        await pool.query(
          `UPDATE shift_closings SET cash_collection_by_user_id = $2 WHERE shift_id = $1`,
          [shiftId, foundId]
        );

        setSt(ctx.from.id, { await: null });
        await toast(ctx, "Сохранено.");
        return showEditMenu(ctx, user, shiftId, { edit: true });
      }

      // edit time (admin)
      if (payload.type === "edit_time") {
        if (!isAdmin(user)) {
          setSt(ctx.from.id, { await: null });
          return;
        }

        const shiftId = st.editShiftId;
        if (!shiftId) return;

        const m = msg.match(
          /^(\d{1,2}):(\d{2})\s*-\s*(?:(\d{1,2}):(\d{2}))?\s*$/
        );
        if (!m) {
          await toast(ctx, "Формат: 08:00-20:00 или 08:00-");
          return;
        }

        const hh1 = String(m[1]).padStart(2, "0");
        const mm1 = m[2];
        const from = `${hh1}:${mm1}`;

        let to = null;
        if (m[3] && m[4]) {
          const hh2 = String(m[3]).padStart(2, "0");
          const mm2 = m[4];
          to = `${hh2}:${mm2}`;
        }

        // Обновляем в пределах даты opened_at
        await pool.query(
          `
          UPDATE shifts
          SET opened_at = (opened_at::date + $2::time),
              closed_at = CASE WHEN $3 IS NULL THEN NULL ELSE (opened_at::date + $3::time) END
          WHERE id = $1
          `,
          [shiftId, from, to]
        );

        setSt(ctx.from.id, { await: null });
        await toast(ctx, "Сохранено.");
        return showEditMenu(ctx, user, shiftId, { edit: true });
      }
    } catch (e) {
      logError("lk_reports_text", e);
    }
  });
}

module.exports = { registerReports };
