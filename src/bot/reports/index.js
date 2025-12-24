// src/bot/reports/index.js
const { Markup } = require("telegraf");

const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast, alert } = require("../../utils/toast");

// Picker pages (users/points) — по 10, как и было
const PAGE_SIZE_PICKER = 10;

// Reports list page sizes
const LIST_LIMIT_CASH = 10;
const LIST_LIMIT_ANALYTICS = 20;

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

function defaultFormatFor(user) {
  // По умолчанию: у сотрудников кассовый, у админов "анализ 1"
  return isAdmin(user) ? "analysis1" : "cash";
}

function fmtMoneyRub(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  return `${new Intl.NumberFormat("ru-RU").format(n)} ₽`;
}

function userLabelCash(row, { admin }) {
  const name = row.full_name || "—";
  // username — только для админа
  if (admin && row.username) return `${name} (@${row.username})`;
  // если нет username — показываем телефон
  if (row.work_phone) return `${name} (${row.work_phone})`;
  return name;
}

function renderCashCard(row, { admin }) {
  const lines = [];

  lines.push(`<b>Сотрудник:</b> ${userLabelCash(row, { admin })}`);

  const date = fmtDateShort(row.opened_at);
  const dow = fmtDowShort(row.opened_at);
  lines.push(`<b>Дата:</b> ${date} (${dow})`);

  const tp = row.trade_point_title || `Точка #${row.trade_point_id}`;
  if (admin) {
    const from = fmtTime(row.opened_at);
    const to = row.closed_at ? fmtTime(row.closed_at) : "-";
    lines.push(`<b>${tp}:</b> (${from} → ${to})`);
  } else {
    lines.push(`<b>${tp}</b>`);
  }

  lines.push("");

  lines.push(`<b>Продажи:</b> ${fmtMoneyRub(row.sales_total)}`);
  lines.push(`<b>Наличные:</b> ${fmtMoneyRub(row.sales_cash)}`);
  lines.push(`<b>В кассе:</b> ${fmtMoneyRub(row.cash_in_drawer)}`);

  lines.push("");

  lines.push(`<b>Чеков:</b> ${row.checks_count ?? "-"}`);

  if (row.was_cash_collection) {
    lines.push(`<b>Инкассация:</b> ${fmtMoneyRub(row.cash_collection_amount)}`);
  } else if (row.was_cash_collection === false) {
    lines.push(`<b>Инкассация:</b> НЕТ`);
  } else {
    lines.push(`<b>Инкассация:</b> -`);
  }

  lines.push("──────────────");
  return lines.join("\n");
}

function renderAnalysisTable(rows, { elements, filters }) {
  const set = new Set(Array.isArray(elements) ? elements : []);

  // Фиксированные колонки по умолчанию:
  // Дата | ДН | Продажи | Чек | ВП
  // Остальные метрики (если включат через "По элементам") можно добавить позже.
  const pointIds = Array.isArray(filters?.pointIds) ? filters.pointIds : [];
  const showTp = pointIds.length !== 1; // если выбрана ровно 1 точка — колонку скрываем

  const cols = [
    { key: "date", title: "Дата", w: 8 },
    { key: "dow", title: "ДН", w: 2 },
  ];

  if (showTp) cols.push({ key: "tp", title: "точ", w: 3 });

  cols.push(
    { key: "sales_total", title: "Продажи", w: 8 },
    { key: "checks_count", title: "Чек", w: 3 },
    { key: "gp", title: "ВП", w: 3 }
  );

  // Если позже захочешь включать доп. колонки через elements — вот тут добавлять.
  // Сейчас по задаче "всё остальное выключено по умолчанию", поэтому ничего не добавляем.

  const cut = (v, w) => {
    const s = String(v ?? "");
    return s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w, " ");
  };

  const makeMap = (r) => ({
    date: fmtDateShort(r.opened_at),
    dow: fmtDowShort(r.opened_at),
    tp: r.trade_point_title || `#${r.trade_point_id}`, // влезет в 3 символа через cut()
    sales_total: fmtMoney(r.sales_total),
    checks_count: r.checks_count ?? "-",
    gp: "-", // Валовая прибыль — пока заглушка
  });

  const header = cols.map((c) => cut(c.title, c.w)).join(" | ");

  const body = rows
    .map((r) => {
      const map = makeMap(r);
      return cols.map((c) => cut(map[c.key], c.w)).join(" | ");
    })
    .join("\n");

  return `<pre>${header}\n${body}</pre>`;
}

function renderAnalysisTable2(rows, { filters }) {
  // Группируем по точке (short name уже в trade_points.title)
  const byTp = new Map();

  for (const r of rows) {
    const tp = r.trade_point_title || `#${r.trade_point_id}`;
    const cur = byTp.get(tp) || { tp, sales: 0, checks: 0 };
    cur.sales += Number(r.sales_total) || 0;
    cur.checks += Number(r.checks_count) || 0;
    byTp.set(tp, cur);
  }

  const list = [...byTp.values()].sort((a, b) =>
    a.tp.localeCompare(b.tp, "ru")
  );

  const cols = [
    { key: "tp", title: "Точ" },
    { key: "to", title: "ТО" },
    { key: "gp", title: "ВП" },
    { key: "np", title: "ЧП" },
    { key: "avg", title: "ср. чек" },
  ];

  const fmtAvg = (n) => {
    const x = Number(n);
    if (!x || Number.isNaN(x)) return "-";
    // 1 знак после запятой, как в скрине "31,7"
    return x.toFixed(1).replace(".", ",");
  };

  const makeRow = (x) => {
    const avg = x.checks ? x.sales / x.checks : 0;
    const map = {
      tp: x.tp,
      to: fmtMoney(x.sales),
      gp: "-",
      np: "-",
      avg: fmtAvg(avg),
    };
    return cols.map((c) => String(map[c.key] ?? "")).join(" | ");
  };

  // если хочешь ровные колонки — используем padding как в renderAnalysisTable
  const tableRaw = [cols.map((c) => c.title).join(" | "), ...list.map(makeRow)];

  // простая выравнивалка по ширинам
  const split = tableRaw.map((line) => line.split(" | "));
  const widths = [];
  for (const parts of split) {
    parts.forEach((p, i) => {
      widths[i] = Math.max(widths[i] || 0, (p || "").length);
    });
  }
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - s.length));
  const aligned = split
    .map((parts) => parts.map((p, i) => pad(p || "", widths[i])).join(" | "))
    .join("\n");

  return `<pre>${aligned}</pre>`;
}

function renderFormatKeyboard(st) {
  const cur = st.format || "cash";
  const mark = (v) => (cur === v ? "✅ " : "");

  const buttons = [
    [
      Markup.button.callback(
        `${mark("cash")}Кассовый`,
        "lk_reports_format_set_cash"
      ),
    ],
    [
      Markup.button.callback(
        `${mark("analysis1")}Для анализа 1`,
        "lk_reports_format_set_analysis1"
      ),
    ],
    [
      Markup.button.callback(
        `${mark("analysis2")}Для анализа 2`,
        "lk_reports_format_set_analysis2"
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "lk_reports_format_close")],
  ];

  return Markup.inlineKeyboard(buttons);
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

  const dateFrom = filters?.dateFrom; // 'YYYY-MM-DD'
  const dateTo = filters?.dateTo; // 'YYYY-MM-DD'

  if (dateFrom) {
    values.push(dateFrom);
    where.push(`s.opened_at >= $${i}::date`);
    i += 1;
  }
  if (dateTo) {
    values.push(dateTo);
    where.push(`s.opened_at < ($${i}::date + INTERVAL '1 day')`);
    i += 1;
  }

  return { whereSql: where.join(" AND "), values, nextIdx: i };
}

async function loadReportsPage({ page, filters, limit }) {
  const safeLimit = Math.max(1, Number(limit) || LIST_LIMIT_CASH);
  const offset = Math.max(0, page) * safeLimit;

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

  const params = [...values, safeLimit + 1, offset];

  try {
    const r = await pool.query(sqlWithDelete, params);
    const rows = r.rows.slice(0, safeLimit);
    const hasMore = r.rows.length > safeLimit;
    return { rows, hasMore };
  } catch (e) {
    // fallback до миграции
    const r = await pool.query(sqlNoDelete, params);
    const rows = r.rows.slice(0, safeLimit);
    const hasMore = r.rows.length > safeLimit;
    return { rows, hasMore };
  }
}

async function loadUsersPage({ page, search }) {
  const offset = Math.max(0, page) * PAGE_SIZE_PICKER;
  const limit = PAGE_SIZE_PICKER;

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
  const offset = Math.max(0, page) * PAGE_SIZE_PICKER;
  const limit = PAGE_SIZE_PICKER;

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
  // По умолчанию включены только базовые метрики
  // (остальное пользователь может включить через "По элементам")
  return ["sales_total", "checks_count"];
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
  const filters = admin ? { ...(st.filters || {}) } : { workerIds: [user.id] };

  // Подключаем период
  if (st.periodFrom) filters.dateFrom = st.periodFrom;
  if (st.periodTo) filters.dateTo = st.periodTo;

  const elements = st.elements || defaultElementsFor(user);
  const format = st.format || defaultFormatFor(user);
  const isAnalysis = ["analysis", "analysis1", "analysis2"].includes(format);
  const limit = isAnalysis ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  // housekeeping (best-effort)
  await purgeOldDeletedReports();

  const { rows, hasMore } = await loadReportsPage({ page, filters, limit });

  const inDateUi = Boolean(st.dateUi); // открыт выбор периода
  const filterOpened = !inDateUi && admin && Boolean(st.filterOpened);

  const formatLabel = isAnalysis ? "для анализа" : "стандарт";

  // label точек для заголовка аналитики
  let pointsLabel = "Все";
  try {
    const f = filters || {};
    if (Array.isArray(f.pointIds) && f.pointIds.length) {
      const r = await pool.query(
        `SELECT id, title FROM trade_points WHERE id = ANY($1::int[]) ORDER BY title NULLS LAST, id`,
        [f.pointIds]
      );
      const titles = r.rows.map((x) => x.title || `Точка #${x.id}`);
      if (titles.length) pointsLabel = titles.join(", ");
    }
  } catch (_) {
    // молча оставляем "Все"
  }

  const header = admin
    ? format === "cash"
      ? ` <b>Отчёты (стандарт)</b>`
      : ` <b>(${pointsLabel}) АНАЛИТИКА ЗА ПЕРИОД</b>`
    : "";

  // Фильтры показываем ТОЛЬКО когда фильтр раскрыт
  let filterBlock = null;

  if (filterOpened) {
    const lines = [];
    const f = filters || {};

    // 1) Точки (показываем реальные названия)
    if (Array.isArray(f.pointIds) && f.pointIds.length) {
      try {
        const r = await pool.query(
          `SELECT id, title FROM trade_points WHERE id = ANY($1::int[]) ORDER BY title NULLS LAST, id`,
          [f.pointIds]
        );
        const titles = r.rows.map((x) => x.title || `Точка #${x.id}`);
        if (titles.length) lines.push(titles.join(", "));
      } catch (_) {
        // если вдруг не получилось — не ломаем экран
        lines.push("Точки");
      }
    }

    // 2) Элементы (то, что сейчас выбрано)
    const el = Array.isArray(st.elements) ? st.elements : [];
    const names = [];
    if (el.includes("sales_total")) names.push("Продажи");
    if (el.includes("checks_count")) names.push("Чек");
    if (el.includes("sales_cash")) names.push("Нал");
    if (el.includes("cash_in_drawer")) names.push("В кассе");
    if (el.includes("cash_collection")) names.push("Инкассация");
    if (names.length) lines.push(names.join(", "));

    filterBlock = lines.length
      ? "Фильтры:\n" + lines.map((x, i) => `${i + 1}. ${x}`).join("\n")
      : "Фильтры: Нет";
  }

  const hideTable = Boolean(st.hideTable);

  let body = "Пока нет закрытых смен.";
  if (rows.length) {
    const isAnalysis = format === "analysis1" || format === "analysis2";

    const rowsForUi = isAnalysis
      ? [...rows].sort(
          (a, b) =>
            new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
        )
      : rows;

    body = isAnalysis
      ? format === "analysis2"
        ? renderAnalysisTable2(rowsForUi, { filters })
        : renderAnalysisTable(rowsForUi, { elements, filters })
      : rowsForUi.map((r) => renderCashCard(r, { admin })).join("\n\n");
  }

  // Сводка показывается ТОЛЬКО когда фильтр закрыт (и только для формата анализа)
  let summaryBlock = null;

  if (!filterOpened && isAnalysis && rows.length) {
    const dates = rows
      .map((r) => (r.opened_at ? new Date(r.opened_at) : null))
      .filter(Boolean);

    const dayStart = (d) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const minD = new Date(Math.min(...dates.map((d) => dayStart(d).getTime())));
    const maxD = new Date(Math.max(...dates.map((d) => dayStart(d).getTime())));

    const msPerDay = 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.round((maxD - minD) / msPerDay) + 1);

    const sumSales = rows.reduce(
      (acc, r) => acc + (Number(r.sales_total) || 0),
      0
    );
    const sumChecks = rows.reduce(
      (acc, r) => acc + (Number(r.checks_count) || 0),
      0
    );

    const fmtRub0 = (n) => `${fmtMoney(n)} ₽`;
    const fmtRub1 = (n) =>
      `${new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(n)} ₽`;

    const periodFrom = fmtDateShort(minD);
    const periodTo = fmtDateShort(maxD);

    // 4) Среднее кол-во чеков в день = сумма чеков / дни
    const avgChecksPerDay = sumChecks ? sumChecks / days : 0;

    // 3) Средний чек = продажи / чеки, округление до десятых
    const avgCheck = sumChecks ? sumSales / sumChecks : 0;

    // 5) Средние продажи в день = продажи / дни
    const avgSalesPerDay = sumSales ? sumSales / days : 0;

    summaryBlock = [
      `📊 ${periodFrom} — ${periodTo} (${days} дн)`,

      "",
      `<u><b>Финансы</b></u>`,
      `• <b>Продажи:</b> ${fmtRub0(sumSales)}`,
      `• <b>Валовая прибыль:</b> —`,
      `• <b>Средние продажи в день:</b> ${fmtRub0(avgSalesPerDay)}`,
      "",
      `<u><b>Поведение гостей</b></u>`,
      `• <b>Кол-во чеков за период:</b> ${fmtMoney(sumChecks)}`,
      `• <b>Средний чек:</b> ${avgCheck ? fmtRub1(avgCheck) : "—"}`,
      `• <b>Среднее кол-во чеков в день:</b> ${
        avgChecksPerDay ? avgChecksPerDay.toFixed(0) : "—"
      }`,
    ].join("\n");
  }

  const text = [header, filterBlock, summaryBlock, "", body]
    .filter(Boolean)
    .join("\n");

  const buttons = [];

  // top controls
  if (admin) {
    if (!filterOpened) {
      // закрыт: показываем фильтр + настройки
      buttons.push([
        Markup.button.callback("🔍 Фильтр", "lk_reports_filter_toggle"),
        Markup.button.callback("⚙️ Настройки", "lk_reports_settings"),
      ]);
    } else {
      // открыт: настройки скрываем, показываем только "скрыть фильтр"
      buttons.push([
        Markup.button.callback(
          "🔍 Фильтр (скрыть)",
          "lk_reports_filter_toggle"
        ),
      ]);
    }
  } else {
    buttons.push([
      Markup.button.callback("✏️ Изменить отчёт", "lk_reports_edit_last"),
      Markup.button.callback("⚙️ Настройки", "lk_reports_settings"),
    ]);
  }

  // expanded filter menu
  if (admin && st.filterOpened) {
    // 2) Выбрать дату
    buttons.push([
      Markup.button.callback("📅 Выбрать дату", "lk_reports_filter_date"),
    ]);

    // 3) По сотрудникам | по точке
    buttons.push([
      Markup.button.callback("👥 По сотрудникам", "lk_reports_filter_workers"),
      Markup.button.callback("🏬 По точке", "lk_reports_filter_points"),
    ]);

    // 4) По дням недели | По элементам
    buttons.push([
      Markup.button.callback("📆 По дням недели", "lk_reports_filter_weekdays"),
      Markup.button.callback("🧩 По элементам", "lk_reports_filter_elements"),
    ]);

    // 5) Сбросить фильтр
    buttons.push([
      Markup.button.callback("🧹 Сбросить фильтр", "lk_reports_filter_clear"),
    ]);
  }

  if (hasMore) {
    buttons.push([Markup.button.callback("➡️ ещё", "lk_reports_more")]);
  }
  if (admin) {
    buttons.push([
      Markup.button.callback("⬅️ К смене", "lk_profile_shift"),
      Markup.button.callback("🎛 Формат", "lk_reports_format_open"),
    ]);
  } else {
    buttons.push([Markup.button.callback("⬅️ К смене", "lk_profile_shift")]);
  }

  const st2 = getSt(ctx.from.id) || {};

  // Если открыт выбор даты — показываем его клавиатуру (main или pick)

  let kb = null;

  if (st2.dateUi?.mode === "main") {
    kb = renderDateMainKeyboard(st2);
  } else if (st2.dateUi?.mode === "pick") {
    kb = renderPickKeyboard(st2.dateUi);
  } else if (st2.formatUi?.mode === "menu") {
    kb = renderFormatKeyboard(st2);
  } else {
    kb = Markup.inlineKeyboard(buttons);
  }

  return deliver(
    ctx,
    {
      text,
      extra: { ...(kb || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function loadPeriodSettings(userId) {
  const r = await pool.query(
    `SELECT preset, date_from, date_to
     FROM report_period_settings
     WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function savePeriodSettings(userId, preset, dateFrom, dateTo) {
  await pool.query(
    `INSERT INTO report_period_settings(user_id, preset, date_from, date_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
     SET preset = EXCLUDED.preset,
         date_from = EXCLUDED.date_from,
         date_to = EXCLUDED.date_to,
         updated_at = now()`,
    [userId, preset, dateFrom, dateTo]
  );
}

function todayLocalDate() {
  // Берём "сегодня" как календарную дату (без времени)
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function toPgDate(d) {
  // d = Date (00:00)
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampToToday(d) {
  const t = todayLocalDate();
  return d > t ? t : d;
}

function swapIfFromAfterTo(from, to) {
  return from > to ? [to, from] : [from, to];
}

function startOfWeekMonday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay(); // 0 Sun..6 Sat
  const diff = day === 0 ? 6 : day - 1; // Monday=0
  x.setDate(x.getDate() - diff);
  return x;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
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

  // вместо отдельного экрана фильтра — показываем АНАЛИЗ (как в списке отчётов)
  const pageList = Number.isInteger((getSt(ctx.from.id) || {}).page)
    ? (getSt(ctx.from.id) || {}).page
    : 0;
  const st2 = getSt(ctx.from.id) || {};
  const admin2 = isAdmin(user);
  const filters2 = admin2 ? st2.filters || {} : { workerIds: [user.id] };
  const format2 = st2.format || defaultFormatFor(user);
  const elements2 = st2.elements || defaultElementsFor(user);
  const limit2 =
    format2 === "analysis" ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: pageList,
    filters: filters2,
    limit: limit2,
  });

  // формируем summaryBlock (копия логики showReportsList)
  let summaryBlock2 = null;
  if (format2 === "analysis" && listRows.length) {
    const dates = listRows
      .map((r) => (r.opened_at ? new Date(r.opened_at) : null))
      .filter(Boolean);

    const dayStart = (d) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const minD = new Date(Math.min(...dates.map((d) => dayStart(d).getTime())));
    const maxD = new Date(Math.max(...dates.map((d) => dayStart(d).getTime())));

    const msPerDay = 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.round((maxD - minD) / msPerDay) + 1);

    const sumSales = listRows.reduce(
      (acc, r) => acc + (Number(r.sales_total) || 0),
      0
    );
    const sumChecks = listRows.reduce(
      (acc, r) => acc + (Number(r.checks_count) || 0),
      0
    );

    const fmtRub0 = (n) => `${fmtMoney(n)} ₽`;
    const fmtRub1 = (n) =>
      `${new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(n)} ₽`;

    const periodFrom = fmtDateShort(minD);
    const periodTo = fmtDateShort(maxD);

    const avgChecksPerDay = sumChecks ? sumChecks / days : 0;
    const avgCheck = sumChecks ? sumSales / sumChecks : 0;
    const avgSalesPerDay = sumSales ? sumSales / days : 0;

    summaryBlock2 = [
      `📊 ${periodFrom} — ${periodTo} (${days} дн)`,

      "",
      `<b>Финансы</b>`,
      `• <b>Продажи:</b> ${fmtRub0(sumSales)}`,
      `• <b>Валовая прибыль:</b> —`,
      `• <b>Средние продажи в день:</b> ${fmtRub0(avgSalesPerDay)}`,
      "",
      `<b>Поведение гостей</b>`,
      `• Кол-во чеков за период: ${fmtMoney(sumChecks)}`,
      `• <b>Средний чек:</b> ${avgCheck ? fmtRub1(avgCheck) : "—"}`,
      `• <b>Среднее кол-во чеков в день:</b> ${
        avgChecksPerDay ? avgChecksPerDay.toFixed(0) : "—"
      }`,
    ].join("\n");
  }

  let body2 = "Пока нет закрытых смен.";
  if (listRows.length) {
    const rowsForUi =
      format2 === "analysis1" || format2 === "analysis2"
        ? [...listRows].sort(
            (a, b) =>
              new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
          )
        : listRows;

    body2 =
      format2 === "analysis1" || format2 === "analysis2"
    
        ? renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
        : rowsForUi
            .map((r) => renderCashCard(r, { admin: admin2 }))
            .join("\n\n");
  }

  const text = [summaryBlock2, "", body2].filter(Boolean).join("\n");

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

  // показываем АНАЛИЗ (как на экране отчёта), а не отдельный экран "фильтр"
  const st2 = getSt(ctx.from.id) || {};
  const admin2 = isAdmin(user);
  const filters2 = admin2 ? st2.filters || {} : { workerIds: [user.id] };
  const format2 = st2.format || defaultFormatFor(user);
  const elements2 = st2.elements || defaultElementsFor(user);
  const limit2 =
    format2 === "analysis" ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: 0,
    filters: filters2,
    limit: limit2,
  });

  let summaryBlock2 = null;
  let body2 = "Пока нет закрытых смен.";
  if (listRows.length) {
    const rowsForUi =
      format2 === "analysis1" || format2 === "analysis2"
        ? [...listRows].sort(
            (a, b) =>
              new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
          )
        : listRows;

    body2 =
      format2 === "analysis1" || format2 === "analysis2"
        ? renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
        : rowsForUi
            .map((r) => renderCashCard(r, { admin: admin2 }))
            .join("\n\n");
  }

  const text = [summaryBlock2, "", body2].filter(Boolean).join("\n");

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

  // показываем АНАЛИЗ (как на экране отчёта), а не отдельный экран "фильтр"
  const st2 = getSt(ctx.from.id) || {};
  const admin2 = isAdmin(user);
  const filters2 = admin2 ? st2.filters || {} : { workerIds: [user.id] };
  const format2 = st2.format || defaultFormatFor(user);
  const elements2 = st2.elements || defaultElementsFor(user);
  const limit2 =
    format2 === "analysis" ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: 0,
    filters: filters2,
    limit: limit2,
  });

  let summaryBlock2 = null;
  let body2 = "Пока нет закрытых смен.";
  if (listRows.length) {
    const rowsForUi =
      format2 === "analysis1" || format2 === "analysis2"
        ? [...listRows].sort(
            (a, b) =>
              new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
          )
        : listRows;

    body2 =
      format2 === "analysis1" || format2 === "analysis2"
        ? renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
        : rowsForUi
            .map((r) => renderCashCard(r, { admin: admin2 }))
            .join("\n\n");
  }

  const text = [summaryBlock2, "", body2].filter(Boolean).join("\n");

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

  const st = getSt(ctx.from.id) || {};
  const format = st.format || defaultFormatFor(user);
  const fmtLabel =
    format === "analysis"
      ? "🧾 Формат отчёта: для анализа"
      : "🧾 Формат отчёта: кассовый";

  const text = "⚙️ <b>Настройки отчётов</b>\n\nВыберите действие:";

  const buttons = [];

  // Доступно всем
  buttons.push([Markup.button.callback(fmtLabel, "lk_reports_format_toggle")]);
  buttons.push([
    Markup.button.callback("ℹ️ Доп. информация", "lk_reports_info"),
  ]);

  // Только админские действия
  if (isAdmin(user)) {
    buttons.push([
      Markup.button.callback("🗑 Удалить отчёты", "lk_reports_delete_mode"),
    ]);
    buttons.push([
      Markup.button.callback("✏️ Изменить отчёт", "lk_reports_edit_pick"),
    ]);
  }

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
          return formatReportCard(r, i + 1 + page * LIST_LIMIT_CASH, {
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
          formatReportCard(r, i + 1 + page * LIST_LIMIT_CASH, {
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

function monthNameRu(m) {
  const names = [
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь",
  ];
  return names[m] || "";
}

function renderDateMainKeyboard(st) {
  const from = st.periodFrom; // 'YYYY-MM-DD'
  const to = st.periodTo;

  const f = from.split("-"); // [yyyy, mm, dd]
  const t = to.split("-");

  const fd = f[2],
    fm = f[1],
    fy = String(f[0]).slice(-2);
  const td = t[2],
    tm = t[1],
    ty = String(t[0]).slice(-2);

  const preset = st.periodPreset || "month";
  const hideTable = Boolean(st.hideTable);

  // месяц для заголовка берём из periodFrom
  const curMonthIdx = Number(fm) - 1; // 0..11
  const monthTitle = monthNameRu(curMonthIdx);

  const btn = (text, data) => Markup.button.callback(text, data);

  // 1) Месяц: ← февраль →
  const rowMonth = [
    btn("←", "date_month:prev"),
    btn(monthTitle, "noop"),
    btn("→", "date_month:next"),
  ];

  // 2) Конструктор дат (точки на дд. и мм.)
  const rowDates = [
    btn(`${fd}.`, "date_part:from:d"),
    btn(`${fm}.`, "date_part:from:m"),
    btn(`${fy}`, "date_part:from:y"),
    btn("—", "noop"),
    btn(`${td}.`, "date_part:to:d"),
    btn(`${tm}.`, "date_part:to:m"),
    btn(`${ty}`, "date_part:to:y"),
  ];

  // 3) неделя/месяц
  const rowWeekMonth = [
    btn(preset === "week" ? "✅ эта неделя" : "эта неделя", "date_preset:week"),
    btn(
      preset === "month" ? "✅ этот месяц" : "этот месяц",
      "date_preset:month"
    ),
  ];

  // 4) вчера/сегодня
  const rowYesterdayToday = [
    btn(preset === "yesterday" ? "✅ вчера" : "вчера", "date_preset:yesterday"),
    btn(preset === "today" ? "✅ сегодня" : "сегодня", "date_preset:today"),
  ];

  // 5) назад/скрыть таб
  const rowBottom = [
    btn("⬅️ назад", "date_back"),
    btn(hideTable ? "Показать таб" : "Скрыть таб", "date_table:toggle"),
  ];

  return Markup.inlineKeyboard([
    rowMonth,
    rowDates,
    rowWeekMonth,
    rowYesterdayToday,
    rowBottom,
  ]);
}

async function showDateMenu(ctx, user, { edit = true } = {}) {
  const st = getSt(ctx.from.id) || {};
  setSt(ctx.from.id, { dateUi: { mode: "main" } });

  const text =
    "📅 <b>Выбор периода</b>\n\nНажми на день/месяц/год чтобы изменить дату.";
  return deliver(
    ctx,
    {
      text,
      extra: { ...(renderDateMainKeyboard(st) || {}), parse_mode: "HTML" },
    },
    { edit }
  );
}

function renderPickKeyboard({ side, part, page = 0 }) {
  const btn = (text, data) => Markup.button.callback(text, data);

  const rows = [];
  if (part === "d") {
    const start = page === 0 ? 1 : 17;
    const end = page === 0 ? 16 : 31;
    let cur = [];
    for (let i = start; i <= end; i++) {
      cur.push(btn(String(i).padStart(2, "0"), `date_pick:${side}:d:${i}`));
      if (cur.length === 4) {
        rows.push(cur);
        cur = [];
      }
    }
    if (cur.length) rows.push(cur);

    rows.push([
      btn("⬅️", `date_pick_page:${side}:d:0`),
      btn("➡️", `date_pick_page:${side}:d:1`),
    ]);
  }

  if (part === "m") {
    let cur = [];
    for (let i = 1; i <= 12; i++) {
      cur.push(btn(String(i).padStart(2, "0"), `date_pick:${side}:m:${i}`));
      if (cur.length === 4) {
        rows.push(cur);
        cur = [];
      }
    }
    if (cur.length) rows.push(cur);
  }

  if (part === "y") {
    const y = todayLocalDate().getFullYear();
    const years = [y - 1, y, y + 1];
    rows.push(
      years.map((yy) => btn(String(yy).slice(-2), `date_pick:${side}:y:${yy}`))
    );
  }

  rows.push([btn("⬅️ Назад", "date_open")]);
  return Markup.inlineKeyboard(rows);
}

async function showPickMenu(ctx, side, part, page = 0, { edit = true } = {}) {
  const label = part === "d" ? "день" : part === "m" ? "месяц" : "год";
  const text = `📅 <b>Выбери ${label}</b>`;
  return deliver(
    ctx,
    {
      text,
      extra: {
        ...(renderPickKeyboard({ side, part, page }) || {}),
        parse_mode: "HTML",
      },
    },
    { edit }
  );
}

// ───────────────────────────────────────────────────────────────
// Register
// ───────────────────────────────────────────────────────────────
function registerReports(bot, ensureUser, logError) {
  bot.action("noop", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action("date_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    setSt(ctx.from.id, { dateUi: { mode: "main" } });
    await showReportsList(ctx, user, { edit: true });
  });

  bot.action("date_back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    setSt(ctx.from.id, { dateUi: null });
    await showReportsList(ctx, user, { edit: true });
  });

  bot.action(/^date_part:(from|to):(d|m|y)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const [, side, part] = ctx.match;
      setSt(ctx.from.id, { dateUi: { mode: "pick", side, part, page: 0 } });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_part", e);
    }
  });

  bot.action(/^date_pick_page:(from|to):d:(0|1)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const [, side, page] = ctx.match;
      const st = getSt(ctx.from.id) || {};
      const prev = st.dateUi || { mode: "pick", side, part: "d", page: 0 };

      setSt(ctx.from.id, {
        dateUi: {
          ...prev,
          mode: "pick",
          side,
          part: "d",
          page: Number(page),
        },
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_pick_page", e);
    }
  });

  bot.action(/^date_pick:(from|to):(d|m|y):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    const [, side, part, rawVal] = ctx.match;
    const st = getSt(ctx.from.id) || {};
    const from = (st.periodFrom || toPgDate(startOfMonth(todayLocalDate())))
      .split("-")
      .map(Number);
    const to = (st.periodTo || toPgDate(todayLocalDate()))
      .split("-")
      .map(Number);

    // from/to = [yyyy, mm, dd]
    const pick = (arr) => {
      if (part === "y") arr[0] = Number(rawVal); // full year
      if (part === "m") arr[1] = Number(rawVal);
      if (part === "d") arr[2] = Number(rawVal);
    };

    if (side === "from") pick(from);
    else pick(to);

    // normalize invalid day (31 in April etc)
    const normalize = (yyyy, mm, dd) => {
      const maxDay = new Date(yyyy, mm, 0).getDate(); // mm is 1..12
      return [yyyy, mm, Math.min(dd, maxDay)];
    };

    let [fy, fm, fd] = normalize(from[0], from[1], from[2]);
    let [ty, tm, td] = normalize(to[0], to[1], to[2]);

    let dFrom = new Date(fy, fm - 1, fd);
    let dTo = new Date(ty, tm - 1, td);

    dTo = clampToToday(dTo);
    [dFrom, dTo] = swapIfFromAfterTo(dFrom, dTo);

    const preset = "custom";

    setSt(ctx.from.id, {
      periodPreset: preset,
      periodFrom: toPgDate(dFrom),
      periodTo: toPgDate(dTo),
    });

    await savePeriodSettings(user.id, preset, toPgDate(dFrom), toPgDate(dTo));

    // Возвращаемся в основное меню конструктора (или сразу в отчёт — решишь)
    setSt(ctx.from.id, { dateUi: { mode: "main" } });
    await showReportsList(ctx, user, { edit: true });
  });

  bot.action(/^date_preset:(yesterday|today|week|month)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    const [, p] = ctx.match;
    const t = todayLocalDate();

    let from = t;
    let to = t;

    if (p === "yesterday") {
      from = new Date(t);
      from.setDate(from.getDate() - 1);
      to = new Date(from);
    } else if (p === "today") {
      from = t;
      to = t;
    } else if (p === "week") {
      from = startOfWeekMonday(t);
      to = t;
    } else if (p === "month") {
      from = startOfMonth(t);
      to = t;
    }

    setSt(ctx.from.id, {
      periodPreset: p,
      periodFrom: toPgDate(from),
      periodTo: toPgDate(to),
      monthOffset: 0,
    });

    await savePeriodSettings(user.id, p, toPgDate(from), toPgDate(to));

    setSt(ctx.from.id, { dateUi: { mode: "main" } });
    await showReportsList(ctx, user, { edit: true });
  });
  // Листание месяцев: ← / →
  bot.action(/^date_month:(prev|next)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const [, dir] = ctx.match;
      const st = getSt(ctx.from.id) || {};

      const t = todayLocalDate();
      const base = new Date(t.getFullYear(), t.getMonth(), 1);

      // offset 0 = текущий месяц
      let off = Number.isInteger(st.monthOffset) ? st.monthOffset : 0;

      if (dir === "prev") off -= 1;
      if (dir === "next") off += 1;

      // запрет будущих месяцев (off > 0)
      if (off > 0) off = 0;

      const m = new Date(base);
      m.setMonth(m.getMonth() + off);

      const from = new Date(m.getFullYear(), m.getMonth(), 1);
      const to = new Date(m.getFullYear(), m.getMonth() + 1, 0); // последний день месяца
      const toClamped = clampToToday(to);
      const [f2, t2] = swapIfFromAfterTo(from, toClamped);

      setSt(ctx.from.id, {
        monthOffset: off,
        periodPreset: "month",
        periodFrom: toPgDate(f2),
        periodTo: toPgDate(t2),
        dateUi: { mode: "main" },
      });

      await savePeriodSettings(user.id, "month", toPgDate(f2), toPgDate(t2));
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_month_nav", e);
    }
  });

  // Скрыть/показать таблицу (в режиме анализа)
  bot.action("date_table:toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, {
        hideTable: !st.hideTable,
        dateUi: { mode: "main" },
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_table_toggle", e);
    }
  });

  // Entry
  bot.action("lk_reports", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // Period from DB (default: current month..today)
      const dbPeriod = await loadPeriodSettings(user.id);

      const t = todayLocalDate();
      let preset = "month";
      let from = startOfMonth(t);
      let to = t;

      if (dbPeriod?.date_from && dbPeriod?.date_to) {
        preset = dbPeriod.preset || "month";
        from = new Date(dbPeriod.date_from);
        to = new Date(dbPeriod.date_to);
      }

      to = clampToToday(to);
      [from, to] = swapIfFromAfterTo(from, to);

      setSt(ctx.from.id, {
        page: 0,
        filterOpened: false,
        filters: { workerIds: [], pointIds: [], weekdays: [] },
        elements: defaultElementsFor(user),
        format: defaultFormatFor(user),
        pickerPage: 0,
        pickerSearch: "",
        delSelected: [],
        editShiftId: null,
        await: null,
        periodPreset: preset,
        periodFrom: toPgDate(from),
        periodTo: toPgDate(to),
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports", e);
    }
  });

  bot.action("lk_reports_format_open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return; // только админ/суперадмин
      setSt(ctx.from.id, { formatUi: { mode: "menu" } });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_open", e);
    }
  });

  bot.action("lk_reports_format_close", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, { formatUi: null });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_close", e);
    }
  });

  bot.action("lk_reports_format_set_cash", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, { format: "cash", page: 0, formatUi: null });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_cash", e);
    }
  });

  bot.action("lk_reports_format_set_analysis1", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, { format: "analysis1", page: 0, formatUi: null });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_analysis1", e);
    }
  });

  bot.action("lk_reports_format_set_analysis2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, { format: "analysis2", page: 0, formatUi: null });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_analysis2", e);
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

  bot.action("lk_reports_format_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const cur = st.format || defaultFormatFor(user);
      const next = cur === "analysis" ? "cash" : "analysis";

      setSt(ctx.from.id, { format: next, page: 0 });
      await showSettings(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_toggle", e);
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
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // Входим в "режим выбора даты" НЕ отдельным экраном, а поверх отчёта
      setSt(ctx.from.id, { dateUi: { mode: "main" } });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_filter_date", e);
    }
  });

  bot.action("lk_reports_info", async (ctx) => {
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
