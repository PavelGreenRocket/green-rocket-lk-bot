// src/bot/reports/index.js
const { Markup } = require("telegraf");

const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast, alert } = require("../../utils/toast");
const { registerReportImports } = require("./imports");
const { registerReportEdit } = require("./edit");
const { registerReportDelete } = require("./delete");
const { registerReportMore } = require("./more");
const {
  loadProductsPage,
  countProducts,
  hasAnyProducts,
  loadCashSummary,
  loadCashAnalysisRows,
  loadCashTimeByHour,
  loadCashTimeByHourByPoint,
  loadCashWeekdayAgg,
  renderProductsTable,
  getPointsWithNoPosBinding,
} = require("./products");

const { importModulposSales } = require("../integrations/modulpos/importer");
const {
  startModulposImportJobsWorker,
} = require("../integrations/modulpos/importJobs");
const {
  loadModulposShiftStatusByPoints,
} = require("../integrations/modulpos/shifts");

// Picker pages (users/points) — по 10, как и было
const PAGE_SIZE_PICKER = 10;

// Reports list page sizes
const LIST_LIMIT_CASH = 5;
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

async function maybeToastImportJobNotification(ctx) {
  // тостим результаты фонового импорта при первом удобном взаимодействии
  try {
    const tgId = ctx?.from?.id;
    if (!tgId) return;
    const r = await pool.query(
      `
        SELECT id, status, effective_period_from, effective_period_to, last_error, result
        FROM pos_import_jobs
        WHERE requested_by_tg_id = $1
          AND notified_at IS NULL
          AND status IN ('done','error')
        ORDER BY finished_at ASC NULLS LAST, id ASC
        LIMIT 1
      `,
      [tgId],
    );
    const job = r.rows?.[0];
    if (!job) return;

    await pool.query(
      `UPDATE pos_import_jobs SET notified_at = now() WHERE id=$1`,
      [job.id],
    );

    const from = job.effective_period_from
      ? fmtDateShort(job.effective_period_from)
      : "";
    const to = job.effective_period_to
      ? fmtDateShort(job.effective_period_to)
      : "";
    const period = from && to ? `${from}—${to}` : "выбранный период";

    if (job.status === "error") {
      await toast(
        ctx,
        `Ошибка загрузки: ${String(job.last_error || "")}`.slice(0, 180),
      );
      return;
    }

    const res = (() => {
      try {
        return typeof job.result === "string"
          ? JSON.parse(job.result)
          : job.result;
      } catch (_) {
        return job.result;
      }
    })();
    const errs = Array.isArray(res?.pointsErrors) ? res.pointsErrors.length : 0;
    const suffix = errs ? ` (ошибки: ${errs})` : "";
    await toast(ctx, `Данные за ${period} загружены${suffix}`);
  } catch (_) {
    // ignore
  }
}

async function loadBotShiftOpenersToday({ pointIds = null } = {}) {
  // Кто открыл смену в боте (на сегодня) по точкам
  try {
    const params = [];
    let wherePoint = "";
    if (Array.isArray(pointIds) && pointIds.length) {
      params.push(pointIds);
      wherePoint = "AND s.trade_point_id = ANY($1::int[])";
    }

    const q = `
      SELECT
        s.trade_point_id,
        u.full_name,
        s.opened_at
      FROM shifts s
      LEFT JOIN app_user u ON u.id = s.user_id
      WHERE s.opened_at::date = CURRENT_DATE
        AND s.status IN ('opening_in_progress', 'opened', 'closing_in_progress')
        ${wherePoint}
      ORDER BY s.trade_point_id, s.opened_at DESC
    `;

    const r = await pool.query(q, params);
    const out = new Map();
    for (const row of r.rows || []) {
      const tpId = Number(row.trade_point_id);
      if (out.has(tpId)) continue;
      const name = String(row.full_name || "").trim();
      if (name) out.set(tpId, name);
    }
    return out;
  } catch (_) {
    return new Map();
  }
}

function isAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function isHeavyFormat(st) {
  const f = st?.format || "cash";
  return f === "cash" || f === "products";
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

function fmtDeltaSign(diff) {
  const n = Number(diff);
  if (!Number.isFinite(n)) return "(?)";
  if (Math.abs(n) < 0.000001) return "(=)";
  const abs = Math.abs(n);
  // без ₽, просто число (как ты просил)
  const s =
    abs % 1 === 0 ? String(Math.trunc(abs)) : String(abs).replace(".", ",");
  return n > 0 ? `(+${s})` : `(-${s})`;
}

function calcExpectedEndCash(row) {
  const opening = Number(row.opening_cash_amount);
  const salesCash = Number(row.sales_cash);
  if (!Number.isFinite(opening) || !Number.isFinite(salesCash)) return null;

  const was = row.was_cash_collection === true;
  const inc = was ? Number(row.cash_collection_amount) : 0;
  const incOk = was ? Number.isFinite(inc) : true;
  if (!incOk) return null;

  return opening + salesCash - (was ? inc : 0);
}

function userLabelCash(row, { admin }) {
  const name = row.full_name || "—";

  // username — только для админа
  if (admin && row.username) return `${name} (@${row.username})`;

  // телефон показываем ТОЛЬКО админам
  if (admin && row.work_phone) return `${name} (${row.work_phone})`;

  // обычному сотруднику — только имя
  return name;
}

function renderCashCard(row, { admin, detailed, thresholds, workers }) {
  const lines = [];

  const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (admin && detailed) {
    const shiftType = detailed ? "🔻Смена:" : "Смена:";
    lines.push(`<b>${shiftType}</b> <code>${row.shift_id}</code>`);

    if (row.edited_at) {
      const d = new Date(row.edited_at);
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yy = String(d.getFullYear()).slice(-2);
      const when = `${dd}.${mm}.${yy}`;

      const name = row.edited_by_name ? row.edited_by_name : "";
      const who = row.edited_by_username
        ? `@${row.edited_by_username}`
        : row.edited_by_work_phone
          ? row.edited_by_work_phone
          : "";

      // формат: "изменено: 28.12.25 Павел (@user)" — курсивом
      const tail = [when, name, who].filter(Boolean).join(" ");
      lines.push(`      <i>изменено: ${tail}</i>`);
    }
    lines.push(`      <b>изменить:</b> /edit_${row.shift_id}`);
    lines.push(`      <b>удалить:</b> /delete_${row.shift_id}`);
    lines.push(`      <b>подробнее:</b> /more_${row.shift_id}`);
    lines.push(""); // пустая строка перед "Сотрудник"
  }

  const ws = Array.isArray(workers) ? workers.filter(Boolean) : null;

  const date = fmtDateShort(row.opened_at);
  const dow = fmtDowShort(row.opened_at);
  lines.push(`📅 <b>Дата:</b> ${date} (${dow})`);

  const tp = row.trade_point_title || `Точка #${row.trade_point_id}`;
  if (admin) {
    const from = fmtTime(row.opened_at);
    const to = row.closed_at ? fmtTime(row.closed_at) : "-";
    lines.push(`<b>${tp}:</b> (${from} → ${to})`);
  } else {
    lines.push(`<b>${tp}</b>`);
  }

  lines.push("");

  if (ws && ws.length > 1) {
    lines.push(`👥 <b>Сотрудники:</b>`);
    for (const w of ws) lines.push(fmtWorkerLine(w, { admin }));
  } else {
    lines.push(`👤 <b>Сотрудник:</b>\n ${userLabelCash(row, { admin })}`);
  }

  lines.push("");
  // ─────────────────────────────
  // Детализация + дельты по кассе (единая логика)
  // ─────────────────────────────
  const openingCash = num(row.opening_cash_amount);
  const prevEndCash = num(row.prev_cash_in_drawer);

  // Δ к началу смены: opening - prevEnd (только при detailed)
  let startDelta = "(?)";
  if (openingCash != null && prevEndCash != null) {
    const d = openingCash - prevEndCash;

    // значок ❗/➕ по порогам (как в конце смены)
    let icon = "";
    const shortageTh = thresholds ? num(thresholds.shortage) : null;
    const surplusTh = thresholds ? num(thresholds.surplus) : null;

    if (d < 0 && shortageTh != null && Math.abs(d) > shortageTh) icon = "❗";
    if (d > 0 && surplusTh != null && d > surplusTh) icon = "➕";

    if (Math.abs(d) < 0.000001) startDelta = "(=)";
    else {
      const abs = Math.abs(d);
      const s =
        abs % 1 === 0 ? String(Math.trunc(abs)) : String(abs).replace(".", ",");
      startDelta = d > 0 ? `(+${s}${icon})` : `(-${s}${icon})`;
    }
  }

  // Ожидаемый конец: opening + sales_cash - cash_collection_amount(if was_cash_collection)
  const salesCash = num(row.sales_cash);
  const endCash = num(row.cash_in_drawer);
  const wasCC = row.was_cash_collection === true;
  const ccAmount = wasCC ? num(row.cash_collection_amount) : 0;

  let endSuffix = " (?)";
  if (
    openingCash != null &&
    salesCash != null &&
    endCash != null &&
    (wasCC ? ccAmount != null : true)
  ) {
    const expectedEnd = openingCash + salesCash - (wasCC ? ccAmount : 0);
    const diff = endCash - expectedEnd;

    // значок ❗/➕ по порогам
    let icon = "";
    const shortageTh = thresholds ? num(thresholds.shortage) : null;
    const surplusTh = thresholds ? num(thresholds.surplus) : null;

    if (diff < 0 && shortageTh != null && Math.abs(diff) > shortageTh)
      icon = "❗";
    if (diff > 0 && surplusTh != null && diff > surplusTh) icon = "➕";

    // fmtDeltaSign уже делает (+10)/(-10)/(=)
    // добавляем ❗/➕ внутрь скобок: (-10❗)
    if (Math.abs(diff) < 0.000001) endSuffix = "(=)";
    else {
      const abs = Math.abs(diff);
      const s =
        abs % 1 === 0 ? String(Math.trunc(abs)) : String(abs).replace(".", ",");
      endSuffix = diff > 0 ? `(+${s}${icon})` : `(-${s}${icon})`;
    }
  }

  if (detailed) {
    lines.push(`▶️ <u><b>Начало смены:</b></u>`);
    lines.push(
      `В кассе: ${fmtMoneyRub(row.opening_cash_amount)} ${startDelta}`,
    );
    lines.push("");
  }

  const shiftEnd = detailed
    ? "⏹️ <u><b>Конец смены:</b></u>"
    : "⏹️ <b>Конец смены:</b>";

  lines.push(shiftEnd);

  lines.push(`<b>Продажи:</b> ${fmtMoneyRub(row.sales_total)}`);
  lines.push(`<b>Наличные:</b> ${fmtMoneyRub(row.sales_cash)}`);
  lines.push(`<b>В кассе:</b> ${fmtMoneyRub(row.cash_in_drawer)} ${endSuffix}`);

  lines.push("");

  lines.push(`<b>Чеков:</b> ${row.checks_count ?? "-"}`);

  const ccName = row.cash_collection_by_name ? row.cash_collection_by_name : "";
  const ccUser = row.cash_collection_by_username
    ? `(@${row.cash_collection_by_username})`
    : "";
  const ccTail = [ccName, ccUser].filter(Boolean).join(" ");

  if (row.was_cash_collection === true) {
    lines.push(
      `<b>Инкассация:</b> ${fmtMoneyRub(row.cash_collection_amount)}${
        ccTail ? ` ${ccTail}` : ""
      }`,
    );
  } else if (row.was_cash_collection === false) {
    lines.push(`<b>Инкассация:</b> НЕТ${ccTail ? ` ${ccTail}` : ""}`);
  } else {
    lines.push(`<b>Инкассация:</b> -`);
  }

  lines.push("──────────────");
  return lines.join("\n");
}

async function loadOpeningsMapBestEffort(shiftIds) {
  const ids = (shiftIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return new Map();

  // 1) пробуем shift_openings(shift_id, cash_in_drawer ...)
  try {
    const r = await pool.query(
      `SELECT shift_id, cash_in_drawer AS cash_in_drawer_open
       FROM shift_openings
       WHERE shift_id = ANY($1::int[])`,
      [ids],
    );
    const m = new Map();
    for (const x of r.rows) m.set(Number(x.shift_id), x);
    return m;
  } catch (_) {}

  // 2) пробуем shift_opening_surveys(shift_id, cash_in_drawer ...)
  try {
    const r = await pool.query(
      `SELECT shift_id, cash_in_drawer AS cash_in_drawer_open
       FROM shift_opening_surveys
       WHERE shift_id = ANY($1::int[])`,
      [ids],
    );
    const m = new Map();
    for (const x of r.rows) m.set(Number(x.shift_id), x);
    return m;
  } catch (_) {}

  return new Map();
}

async function loadPrevEndCashMapBestEffort(shiftIds) {
  const ids = (shiftIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return new Map();

  try {
    const r = await pool.query(
      `
      WITH x AS (
        SELECT
          s.id AS shift_id,
          s.trade_point_id,
          sc.cash_in_drawer,
          LAG(sc.cash_in_drawer) OVER (
            PARTITION BY s.trade_point_id
            ORDER BY s.opened_at
          ) AS prev_end_cash
        FROM shifts s
        LEFT JOIN shift_closings sc
          ON sc.shift_id = s.id AND sc.deleted_at IS NULL
      )
      SELECT shift_id, prev_end_cash
      FROM x
      WHERE shift_id = ANY($1::bigint[])
      `,
      [ids],
    );

    const m = new Map();
    for (const row of r.rows || [])
      m.set(Number(row.shift_id), row.prev_end_cash);
    return m;
  } catch (e) {
    return new Map();
  }
}

async function loadCashDiffThresholdsBestEffort() {
  try {
    const r = await pool.query(`
      SELECT
        shortage_threshold::numeric AS shortage_threshold,
        surplus_threshold::numeric  AS surplus_threshold
      FROM cash_diff_settings
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = r.rows[0] || {};
    return {
      shortage: Number(row.shortage_threshold ?? 0),
      surplus: Number(row.surplus_threshold ?? 0),
    };
  } catch (e) {
    return { shortage: 0, surplus: 0 };
  }
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

  if (showTp) cols.push({ key: "tp", title: "точ", w: 4 });

  cols.push(
    { key: "sales_total", title: "Продажи", w: 8 },
    { key: "checks_count", title: "Чек", w: 3 },
    { key: "gp", title: "ВП", w: 3 },
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

function renderAnalysisTable2(
  rows,
  {
    filters,
    page = 0,
    sortKey = "to",
    statusMap,
    openerMap,
    showOpener = false,
    onlyOpened = false,
  },
) {
  const byTp = new Map();

  for (const r of rows) {
    const tpId = Number(r.trade_point_id);
    const tpTitle = r.trade_point_title || `#${tpId}`;
    const cur = byTp.get(tpId) || { tpId, tpTitle, sales: 0, checks: 0 };
    cur.sales += Number(r.sales_total) || 0;
    cur.checks += Number(r.checks_count) || 0;
    byTp.set(tpId, cur);
  }

  let list = [...byTp.values()];

  list = list.map((x) => {
    const st = statusMap instanceof Map ? statusMap.get(x.tpId) : null;
    const isOpen = Boolean(st?.isOpen);
    const cashierName = st?.cashierName ? String(st.cashierName) : null;

    const openerName =
      openerMap instanceof Map ? openerMap.get(x.tpId) || null : null;

    return { ...x, isOpen, cashierName, openerName };
  });

  if (onlyOpened) {
    list = list.filter((x) => x.isOpen);
  }

  const avgVal = (x) => (x.checks ? x.sales / x.checks : 0);

  const sortNum = (a, b) => (b || 0) - (a || 0);

  // ✅ В режиме 👤 сортируем только по ТО (чтобы было предсказуемо и компактно)
  const compactOnlyOpenedMode = Boolean(onlyOpened);

  if (compactOnlyOpenedMode) {
    list.sort((a, b) => sortNum(a.sales, b.sales));
  } else {
    if (sortKey === "to") list.sort((a, b) => sortNum(a.sales, b.sales));
    else if (sortKey === "checks")
      list.sort((a, b) => sortNum(a.checks, b.checks));
    else if (sortKey === "avg")
      list.sort((a, b) => sortNum(avgVal(a), avgVal(b)));
    else if (sortKey === "vp" || sortKey === "np") {
      list.sort((a, b) => sortNum(a.sales, b.sales));
    } else {
      list.sort((a, b) => a.tpTitle.localeCompare(b.tpTitle, "ru"));
    }
  }

  const fmtAvg = (n) => {
    const x = Number(n);
    if (!x || Number.isNaN(x)) return "-";
    return x.toFixed(1).replace(".", ",");
  };

  const cols = compactOnlyOpenedMode
    ? [
        { key: "st", title: "Ст" },
        { key: "tp", title: "Точ" },
        { key: "to", title: "ТО" },
        { key: "cashier", title: "Кассир" },
      ]
    : Number(page) === 1
      ? [
          { key: "st", title: "Ст" },
          { key: "tp", title: "Точ" },
          { key: "avg", title: "ср.чек" },
          { key: "checks", title: "кол-во чек" },
        ]
      : [
          { key: "st", title: "Ст" },
          { key: "tp", title: "Точ" },
          { key: "to", title: "ТО" },
          { key: "gp", title: "ВП" },
          { key: "np", title: "ЧП" },
        ];

  // 👇 ВАЖНО: “видимая” длина (эмодзи -> 1)
  const visLen = (s) => Array.from(String(s ?? "")).length;

  const makeParts = (x) => {
    const avg = avgVal(x);

    const map = {
      st: x.isOpen ? "🟢" : "⚪",
      tp: String(x.tpTitle || ""),
      to: fmtMoney(x.sales),
      gp: "-",
      np: "-",
      avg: fmtAvg(avg),
      checks: x.checks ?? "-",
      cashier: (x.cashierName || "").trim() || "-",
    };

    return cols.map((c) => String(map[c.key] ?? ""));
  };

  const headerParts = cols.map((c) => String(c.title ?? ""));
  const rawParts = [headerParts, ...list.map(makeParts)];

  // ширины считаем по всем колонкам КРОМЕ st (у st фикс 1)
  const widths = [];
  for (const parts of rawParts) {
    parts.forEach((p, i) => {
      if (cols[i].key === "st") {
        widths[i] = 1; // 🟢 / ⚪
        return;
      }
      widths[i] = Math.max(widths[i] || 0, visLen(p));
    });
  }

  const pad = (s, w) => {
    const str = String(s ?? "");
    const need = Math.max(0, w - visLen(str));
    return str + " ".repeat(need);
  };

  const SEP = " | ";

  const joinLine = (parts) => {
    const out = [];

    for (let i = 0; i < parts.length; i++) {
      const key = cols[i].key;

      if (key === "st") {
        out.push(String(parts[i] ?? ""));
        continue;
      }

      out.push(pad(parts[i], widths[i] || 0));
    }

    return out.join(SEP).trimEnd();
  };

  const aligned = rawParts.map(joinLine).join("\n");

  return `<pre>${aligned}</pre>`;
}

function renderDowAnalysisTable(listRows, opts = {}) {
  // ISO DOW: 1..7 (пн..вс)
  const labels = {
    1: "пн",
    2: "вт",
    3: "ср",
    4: "чт",
    5: "пт",
    6: "сб",
    7: "вс",
  };

  const by = new Map();
  for (let iso = 1; iso <= 7; iso++) by.set(iso, { iso, sales: 0, checks: 0 });

  for (const r of listRows) {
    if (!r.opened_at) continue;
    // JS getDay: 0..6 (Sun..Sat) -> ISO: Mon=1..Sun=7
    const d = new Date(r.opened_at);
    const js = d.getDay(); // 0..6
    const iso = js === 0 ? 7 : js; // 1..7
    const cur = by.get(iso);
    cur.sales += Number(r.sales_total) || 0;
    cur.checks += Number(r.checks_count) || 0;
  }

  const rows = [...by.values()];

  // сортировка (по возрастанию) либо стандарт пн..вс
  if (opts.sortActive && opts.sortKey) {
    const key =
      opts.sortKey === "to"
        ? "sales"
        : opts.sortKey === "checks"
          ? "checks"
          : null; // vp пока нет

    if (key) rows.sort((a, b) => (a[key] || 0) - (b[key] || 0));
    // если vp — пока нечего сортировать, оставляем стандарт
  }

  const totalSales = rows.reduce((a, x) => a + x.sales, 0);
  const totalChecks = rows.reduce((a, x) => a + x.checks, 0);

  const pct = (part, total) => {
    if (!total) return "-";
    return `${Math.round((part / total) * 100)}%`;
  };

  // колонки (простое выравнивание по ширинам, как в analysis2)
  const cols = ["ДН", "ТО", "%ТО", "ВП", "%ВП", "чек", "%чек"];

  const makeLine = (x) => [
    labels[x.iso],
    fmtMoney(x.sales),
    pct(x.sales, totalSales),
    "-", // ВП заглушка
    "-", // %ВП заглушка
    fmtMoney(x.checks),
    pct(x.checks, totalChecks),
  ];

  const tableRaw = [cols, ...rows.map(makeLine)];

  // итоговая строка "="
  tableRaw.push([
    "=",
    fmtMoney(totalSales),
    totalSales ? "100%" : "-",
    "-",
    "-",
    fmtMoney(totalChecks),
    totalChecks ? "100%" : "-",
  ]);

  // выравниваем
  const widths = [];
  for (const parts of tableRaw) {
    parts.forEach((p, i) => {
      widths[i] = Math.max(widths[i] || 0, String(p ?? "").length);
    });
  }
  const pad = (s, w) =>
    String(s ?? "") + " ".repeat(Math.max(0, w - String(s ?? "").length));

  const lines = tableRaw.map((parts) =>
    parts.map((p, i) => pad(p, widths[i])).join(" | "),
  );

  const sep = widths.map((w) => "─".repeat(w)).join("──");

  // после заголовка и между строками добавляем разделитель
  const out = [
    lines[0],
    sep,
    ...lines
      .slice(1)
      .flatMap((ln, idx) => (idx === lines.length - 2 ? [ln] : [ln, sep])),
  ].join("\n");

  return `<pre>${out}</pre>`;
}

// ───────────────────────────────────────────────────────────────
// Анализ "по времени" — 3 режима
// 0) Время | ТО | Чеков | Ср. чек (heat)
// 1) Время | ТО по точкам (топ-4)
// 2) Время | ███ (бар)
// ───────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapePipes(s) {
  return String(s ?? "").replace(/\|/g, "/");
}

function hourRangeLabel(h) {
  const hh = Number(h);
  if (!Number.isFinite(hh)) return "--";
  const a = String(hh).padStart(2, "0");
  const b = String((hh + 1) % 24).padStart(2, "0");
  return `${a}–${b}`;
}

function formatCompactMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}

function computePeak2h(hoursSorted) {
  // hoursSorted: [{hour, toAvg}...] отсортированы по hour ASC
  if (!Array.isArray(hoursSorted) || !hoursSorted.length) return null;
  let best = null;
  for (let i = 0; i < hoursSorted.length - 1; i++) {
    const a = hoursSorted[i];
    const b = hoursSorted[i + 1];
    if (Number(a.hour) + 1 !== Number(b.hour)) continue; // только соседние
    const sum = (Number(a.toAvg) || 0) + (Number(b.toAvg) || 0);
    if (!best || sum > best.sum) best = { start: Number(a.hour), sum };
  }
  return best;
}

function heatMarker(v, max) {
  const n = Number(v) || 0;
  const m = Number(max) || 0;
  if (m <= 0) return "⬜ ";
  const r = n / m;
  if (r >= 0.75) return "🟩 ";
  if (r >= 0.4) return "🟨 ";
  return "⬜ ";
}

function renderTimeMode0(rows, { totalDays }) {
  const days = Math.max(1, Number(totalDays) || 1);

  // 1) собираем данные по часу
  const byHour = new Map();
  for (const r of rows || []) {
    const h = Number(r.hour);
    if (!Number.isFinite(h)) continue;
    byHour.set(h, {
      hour: h,
      sales: Number(r.sales_total) || 0,
      checks: Number(r.checks_count) || 0,
    });
  }

  // 2) строим 24 часа (среднее за день)
  const hours = Array.from({ length: 24 }, (_, h) => {
    const x = byHour.get(h) || { sales: 0, checks: 0 };
    const toAvg = x.sales / days;
    const checksAvg = x.checks / days;
    const avgCheck = checksAvg > 0 ? toAvg / checksAvg : 0;
    return { hour: h, toAvg, checksAvg, avgCheck };
  });

  const maxTo = Math.max(0, ...hours.map((x) => x.toAvg || 0));

  const peak = computePeak2h(hours);
  const peakLine = peak
    ? `🔥 Пик: ${hourRangeLabel(peak.start)}–${String((peak.start + 2) % 24).padStart(2, "0")}`
    : null;

  // ─────────────────────────
  // 3) Рендер таблицы
  // ─────────────────────────
  const TIME_COL_WIDTH = 8;
  const visLen = (s) => Array.from(String(s ?? "")).length;

  const HEAT_PREFIX = heatMarker(0, 1); // например "⬜ "
  const CLOCK_PREFIX = "🕒 ";

  // заменяем только эмодзи, пробел оставляем
  const headTime = HEAT_PREFIX.replace(/[^\s]/u, "🕒") + "Время";
  const head = [headTime, "ТО", "Чеков", "Ср. чек"];
  const table = [head];

  for (const x of hours) {
    const mark = heatMarker(x.toAvg, maxTo);
    const rawTime = `${mark}${hourRangeLabel(x.hour)}`;
    const time =
      rawTime + " ".repeat(Math.max(0, TIME_COL_WIDTH - visLen(rawTime)));

    table.push([
      time,
      formatCompactMoney(x.toAvg),
      formatCompactMoney(x.checksAvg),
      x.checksAvg > 0 ? formatCompactMoney(x.avgCheck) : "-",
    ]);
  }

  // widths
  const widths = [];
  for (const row of table) {
    row.forEach((c, i) => {
      if (i === 0) {
        widths[0] = TIME_COL_WIDTH;
        return;
      }
      widths[i] = Math.max(widths[i] || 0, visLen(c));
    });
  }

  const pad = (s, w) => {
    const str = String(s ?? "");
    const need = Math.max(0, w - visLen(str));
    return str + " ".repeat(need);
  };

  const lines = table.map((r) =>
    r.map((c, i) => pad(c, widths[i])).join(" | "),
  );
  const sep = widths.map((w) => "─".repeat(w)).join("──");

  const out = [
    ...(peakLine ? [peakLine] : []),
    ...(days > 1 ? [`(среднее за день; дней: ${days})`] : []),
    "",
    lines[0],
    sep,
    ...lines.slice(1),
  ].join("\n");

  return `<pre>${escapeHtml(out)}</pre>`;
}

function renderTimeMode2(rows, { totalDays }) {
  const days = Math.max(1, Number(totalDays) || 1);
  const byHour = new Map();
  for (const r of rows || []) {
    const h = Number(r.hour);
    if (!Number.isFinite(h)) continue;
    byHour.set(h, Number(r.sales_total) || 0);
  }
  const hours = Array.from({ length: 24 }, (_, h) => {
    const toAvg = (byHour.get(h) || 0) / days;
    return { hour: h, toAvg };
  });
  const maxTo = Math.max(0, ...hours.map((x) => x.toAvg || 0));
  const peak = computePeak2h(hours);
  const peakLine = peak
    ? `🔥 Пик: ${hourRangeLabel(peak.start)}–${String((peak.start + 2) % 24).padStart(2, "0")}`
    : null;

  const barW = 12;
  const lines = [];
  if (peakLine) lines.push(peakLine);
  if (days > 1) lines.push(`(среднее за день; дней: ${days})`);
  lines.push("");
  lines.push("Время | ТО | ");
  for (const x of hours) {
    const ratio = maxTo > 0 ? (x.toAvg || 0) / maxTo : 0;
    const n = Math.round(ratio * barW);
    const bar = "█".repeat(n) + " ".repeat(Math.max(0, barW - n));
    lines.push(
      `${hourRangeLabel(x.hour)} | ${formatCompactMoney(x.toAvg)} | ${bar}`,
    );
  }
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

// универсально: обновить текущее сообщение на фото (если возможно),
// иначе удалить и отправить новое фото с теми же кнопками
async function deliverPhoto(ctx, { url, caption, kb }, { edit = true } = {}) {
  const safeCaption = String(caption || "").slice(0, 1000); // запас под лимит caption
  const replyMarkup = kb?.reply_markup
    ? { reply_markup: kb.reply_markup }
    : undefined;

  // 1) если не edit — просто отправляем фото
  if (!edit) {
    return ctx.replyWithPhoto(
      { url },
      { caption: safeCaption, parse_mode: "HTML", ...(replyMarkup || {}) },
    );
  }

  // 2) edit=true: сначала пробуем превратить текущее сообщение в фото (если оно уже было медиа)
  try {
    await ctx.editMessageMedia(
      {
        type: "photo",
        media: url,
        caption: safeCaption,
        parse_mode: "HTML",
      },
      replyMarkup || undefined,
    );
    return;
  } catch (_) {
    // Telegram часто ругается, если текущее сообщение было текстом
  }

  // 3) fallback: удаляем старое и отправляем новое фото (кнопки сохраняем)
  try {
    await ctx.deleteMessage().catch(() => {});
  } catch (_) {}

  return ctx.replyWithPhoto(
    { url },
    { caption: safeCaption, parse_mode: "HTML", ...(replyMarkup || {}) },
  );
}

function summaryLinesForChart(summaryBlock) {
  if (!summaryBlock) return [];

  const plainLines = String(summaryBlock)
    .split("\n")
    .map((l) => l.replace(/<[^>]+>/g, "").trim()) // убрать HTML-теги <b>, <u> и т.п.
    .filter(Boolean);

  const pick = (startsWith) => plainLines.find((l) => l.startsWith(startsWith));

  // 9 строк — влезает (1-я строка заголовка графика + 9 = 10 макс)
  return [
    pick("📊 "), // период
    pick("Пропущенных дней:"),

    pick("• Продажи (ТО):"),
    pick("• Валовая прибыль (ВП):"),
    pick("• Чистая прибыль (ЧП):"),
    pick("• Средние продажи в день:"),

    pick("• Кол-во чеков за период:"),
    pick("• Средний чек:"),
    pick("• Среднее кол-во чеков в день:"),
  ].filter(Boolean);
}
function summaryLinesForCaption(summaryBlock) {
  if (!summaryBlock) return [];

  const plainLines = String(summaryBlock)
    .split("\n")
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  const pick = (startsWith) => plainLines.find((l) => l.startsWith(startsWith));

  return [pick("📊 "), pick("Пропущенных дней:")].filter(Boolean);
}

function buildTimeBarChartUrl(rows, { totalDays, summaryLines = [] }) {
  const days = Math.max(1, Number(totalDays) || 1);

  const byHour = new Map();
  for (const r of rows || []) {
    const h = Number(r.hour);
    if (!Number.isFinite(h)) continue;
    byHour.set(h, Number(r.sales_total) || 0);
  }

  const labels = Array.from({ length: 24 }, (_, h) => String(h));
  const data = labels.map(
    (_, h) => Math.round(((byHour.get(h) || 0) / days) * 100) / 100,
  );

  const titleLines = ["🕒 По часам", ...(summaryLines || [])].slice(0, 10);

  const chartCfg = {
    type: "bar",
    data: {
      labels,
      datasets: [{ data }],
    },
    options: {
      legend: { display: false },
      title: {
        display: true,
        text: titleLines, // многострочно
        fontSize: 12,
        padding: 10,
      },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
      },
    },
  };

  return (
    "https://quickchart.io/chart?c=" +
    encodeURIComponent(JSON.stringify(chartCfg)) +
    "&w=900&h=380&devicePixelRatio=2"
  );
}

function buildWeekdayBarChartUrl(
  rows,
  { totalDays, metric = "to", summaryLines = [] },
) {
  const days = Math.max(1, Number(totalDays) || 1);

  // ISO DOW: 1..7 (пн..вс)
  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const byDow = new Map();
  for (const r of rows || []) {
    const dow = Number(r.iso_dow);
    if (!Number.isFinite(dow)) continue;
    const v =
      metric === "checks"
        ? Number(r.checks_count) || 0
        : Number(r.sales_total) || 0;
    byDow.set(dow, v);
  }

  // На графике — среднее в день по выбранному периоду (как в "по часам")
  const data = labels.map((_, i) => {
    const iso = i + 1;
    const v = byDow.get(iso) || 0;
    return Math.round((v / days) * 100) / 100;
  });

  const title =
    metric === "checks" ? "📅 По дням недели — чеки" : "📅 По дням недели — ТО";

  const titleLines = [title, ...(summaryLines || [])].slice(0, 10);

  const chartCfg = {
    type: "bar",
    data: {
      labels,
      datasets: [{ data }],
    },
    options: {
      legend: { display: false },
      title: {
        display: true,
        text: titleLines,
        fontSize: 12,
        padding: 10,
      },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
      },
    },
  };

  return (
    "https://quickchart.io/chart?c=" +
    encodeURIComponent(JSON.stringify(chartCfg)) +
    "&w=900&h=380&devicePixelRatio=2"
  );
}

function buildWeekdayTableImageUrl(
  rows,
  { sortKey = "to", sortActive = true } = {},
) {
  // Таблица как renderDowAnalysisTable, но картинкой (PNG) через quickchart table.
  // ISO DOW: 1..7 (пн..вс)
  const order = [1, 2, 3, 4, 5, 6, 7];
  const names = {
    1: "пн",
    2: "вт",
    3: "ср",
    4: "чт",
    5: "пт",
    6: "сб",
    7: "вс",
  };

  const byDow = new Map();
  for (const r of rows || []) {
    const d = Number(r.iso_dow);
    if (!Number.isFinite(d)) continue;
    byDow.set(d, {
      to: Number(r.sales_total) || 0,
      checks: Number(r.checks_count) || 0,
      vp: 0,
    });
  }

  const totalTo = order.reduce((a, d) => a + (byDow.get(d)?.to || 0), 0);
  const totalChecks = order.reduce(
    (a, d) => a + (byDow.get(d)?.checks || 0),
    0,
  );

  let dataRows = order.map((d) => {
    const v = byDow.get(d) || { to: 0, checks: 0, vp: 0 };
    const pTo = totalTo ? Math.round((v.to / totalTo) * 100) : 0;
    const pChecks = totalChecks
      ? Math.round((v.checks / totalChecks) * 100)
      : 0;
    return {
      d,
      dn: names[d] || String(d),
      to: v.to,
      pTo,
      vp: v.vp,
      pVp: 0,
      checks: v.checks,
      pChecks,
    };
  });

  if (sortActive) {
    const key =
      sortKey === "checks" ? "checks" : sortKey === "vp" ? "vp" : "to";
    dataRows = dataRows.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0));
  }

  const fmtNum = (n) =>
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
      Math.round(Number(n) || 0),
    );

  const tableRows = dataRows.map((r) => [
    r.dn,
    fmtNum(r.to),
    `${r.pTo}%`,
    "-",
    "-",
    fmtNum(r.checks),
    `${r.pChecks}%`,
  ]);

  // Итоговая строка "="
  tableRows.push([
    "=",
    fmtNum(totalTo),
    "100%",
    "-",
    "-",
    fmtNum(totalChecks),
    "100%",
  ]);

  const payload = {
    title: "",
    columns: ["ДН", "ТО", "%ТО", "ВП", "%ВП", "чек", "%чек"],
    rows: tableRows,
  };

  return (
    "https://quickchart.io/table?data=" +
    encodeURIComponent(JSON.stringify(payload)) +
    "&format=png&width=900&height=520&padding=10"
  );
}

function renderTimeMode1(pivotRows, { totalDays, topPoints }) {
  const days = Math.max(1, Number(totalDays) || 1);
  const points = Array.isArray(topPoints) ? topPoints : [];
  const pointTitles = points.map((p) => escapePipes(p.title));

  const byKey = new Map();
  for (const r of pivotRows || []) {
    const h = Number(r.hour);
    const tp = Number(r.trade_point_id);
    if (!Number.isFinite(h) || !Number.isFinite(tp)) continue;
    byKey.set(`${h}:${tp}`, Number(r.sales_total) || 0);
  }

  const head = ["Время", ...pointTitles];
  const table = [head];

  for (let h = 0; h < 24; h++) {
    const row = [hourRangeLabel(h)];
    for (const p of points) {
      const v = (byKey.get(`${h}:${p.id}`) || 0) / days;
      row.push(formatCompactMoney(v));
    }
    table.push(row);
  }

  const widths = [];
  for (const row of table) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] || 0, String(c ?? "").length);
    });
  }
  const pad = (s, w) =>
    String(s ?? "") + " ".repeat(Math.max(0, w - String(s ?? "").length));

  const lines = table.map((r) =>
    r.map((c, i) => pad(c, widths[i])).join(" | "),
  );
  const sep = widths.map((w) => "─".repeat(w)).join("──");

  const out = [
    days > 1 ? `(среднее за день; дней: ${days})` : null,
    "",
    lines[0],
    sep,
    ...lines.slice(1),
  ]
    .filter(Boolean)
    .join("\n");

  return `<pre>${escapeHtml(out)}</pre>`;
}

function renderFormatKeyboard(st) {
  const cur = st.format || "cash";
  const detailed = Boolean(st.cashDetailed);

  const isCash = cur === "cash";
  const markStd = isCash && !detailed ? "✅ " : "";
  const markDet = isCash && detailed ? "✅ " : "";

  const mark = (v) => (cur === v ? "✅ " : "");

  const btn = (text, data) => Markup.button.callback(text, data);

  const buttons = [
    [
      btn("кассовый →", "lk_reports_noop"),
      btn(`${markStd}стандарт`, "lk_reports_cash_set_standard"),
      btn(`${markDet}подробно`, "lk_reports_cash_set_detailed"),
    ],
    [
      btn(`${mark("analysis1")}по дням`, "lk_reports_format_set_analysis1"),
      btn(`${mark("analysis2")}по точкам`, "lk_reports_format_set_analysis2"),
    ],
    [
      btn(`${mark("time")}по часам`, "lk_reports_format_set_time"),
      btn(`${mark("weekday")}по дням недели`, "lk_reports_format_set_weekday"),
    ],
    [
      btn("по месяцам", "lk_reports_format_stub_months"),
      btn("по годам", "lk_reports_format_stub_years"),
    ],
    [
      btn(`${mark("products")}по товарам`, "lk_reports_format_set_products"),
      btn("по сотрудникам", "lk_reports_format_stub_staff"),
    ],
    [btn("🔙", "lk_reports_format_close")],
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

function fmtDateDayMonth(d) {
  if (!d) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

const DOW_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
function fmtDowShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return DOW_SHORT[d.getDay()];
}

function parsePgDateToDate(s) {
  // ожидаем YYYY-MM-DD
  if (!s || typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return new Date(y, mo, d);
}

function fmtPgDate(d) {
  if (!d) return "";
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function diffDaysIso(fromIso, toIso) {
  const a = parsePgDateToDate(fromIso);
  const b = parsePgDateToDate(toIso);
  if (!a || !b) return 0;
  const ms = 24 * 60 * 60 * 1000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / ms);
}

function fmtPeriodRangeLabel(st) {
  const from = parsePgDateToDate(st?.periodFrom);
  const to = parsePgDateToDate(st?.periodTo);

  if (from && to) {
    const a = fmtDateDayMonth(from);
    const b = fmtDateDayMonth(to);

    // если один день — показываем только dd.mm
    if (a === b) return a;

    // диапазон — dd.mm-dd.mm (без пробелов, чтобы влезало)
    return `${a}-${b}`;
  }

  if (from && !to) return `${fmtDateDayMonth(from)}-…`;
  if (!from && to) return `…-${fmtDateDayMonth(to)}`;

  return "Период";
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
         AND deleted_at < (NOW() - INTERVAL '30 days')`,
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

async function loadWorkersForShiftIds(shiftIds) {
  const ids = (shiftIds || []).map((x) => Number(x)).filter(Boolean);
  if (!ids.length) return new Map();

  const r = await pool.query(
    `
    SELECT
      str.from_shift_id,
      str.to_shift_id,
      uf.full_name AS from_full_name,
      uf.username  AS from_username,
      ut.full_name AS to_full_name,
      ut.username  AS to_username
    FROM shift_transfer_requests str
    JOIN shifts sf ON sf.id = str.from_shift_id
    JOIN shifts st ON st.id = str.to_shift_id
    JOIN users uf ON uf.id = sf.user_id
    JOIN users ut ON ut.id = st.user_id
    WHERE str.status = 'completed'
      AND (str.from_shift_id = ANY($1::int[]) OR str.to_shift_id = ANY($1::int[]))
    ORDER BY str.id DESC
    `,
    [ids],
  );

  const map = new Map();

  for (const row of r.rows || []) {
    const workers = [
      { full_name: row.from_full_name, username: row.from_username },
      { full_name: row.to_full_name, username: row.to_username },
    ];

    // обе части смены должны показывать одинаковый список сотрудников
    map.set(Number(row.from_shift_id), workers);
    map.set(Number(row.to_shift_id), workers);
  }

  return map;
}

function fmtWorkerLine(u, { admin } = {}) {
  const name = u?.full_name || "—";

  // @username — только админам
  if (admin && u?.username) return `${name} (@${u.username})`;

  // телефон — только админам (если вдруг начнёшь прокидывать work_phone)
  if (admin && u?.work_phone) return `${name} (${u.work_phone})`;

  return name;
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
     s.cash_amount AS opening_cash_amount,
      prev.prev_cash_in_drawer,
    
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

    sc.edited_at,
    sc.edited_by_user_id,
    eu.full_name AS edited_by_name,
    eu.username  AS edited_by_username,
    eu.work_phone AS edited_by_work_phone,

    cu.full_name AS cash_collection_by_name,
    cu.username  AS cash_collection_by_username

  FROM shifts s
  JOIN shift_closings sc ON sc.shift_id = s.id
  JOIN users u ON u.id = s.user_id
  LEFT JOIN users cu ON cu.id = sc.cash_collection_by_user_id
  LEFT JOIN users eu ON eu.id = sc.edited_by_user_id
  LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
      LEFT JOIN LATERAL (
      SELECT sc2.cash_in_drawer AS prev_cash_in_drawer
      FROM shifts s2
      JOIN shift_closings sc2 ON sc2.shift_id = s2.id
      WHERE s2.trade_point_id = s.trade_point_id
        AND sc2.deleted_at IS NULL
        AND s2.closed_at IS NOT NULL
        AND s.opened_at IS NOT NULL
        AND s2.closed_at < s.opened_at
      ORDER BY s2.closed_at DESC, s2.id DESC
      LIMIT 1
    ) prev ON TRUE


  WHERE ${whereSql}
    AND sc.deleted_at IS NULL

  ORDER BY COALESCE(s.opened_at, s.closed_at) DESC NULLS LAST, s.id DESC

  LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
`;

  const sqlNoDelete = `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
       s.cash_amount AS opening_cash_amount,
      prev.prev_cash_in_drawer,
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
    LEFT JOIN LATERAL (
      SELECT sc2.cash_in_drawer AS prev_cash_in_drawer
      FROM shifts s2
      JOIN shift_closings sc2 ON sc2.shift_id = s2.id
      WHERE s2.trade_point_id = s.trade_point_id
        AND s2.closed_at IS NOT NULL
        AND s.opened_at IS NOT NULL
        AND s2.closed_at < s.opened_at
      ORDER BY s2.closed_at DESC, s2.id DESC
      LIMIT 1
    ) prev ON TRUE

    WHERE ${whereSql}

    ORDER BY COALESCE(s.opened_at, s.closed_at) DESC NULLS LAST, s.id DESC

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

async function countReportsTotal(filters) {
  const { whereSql, values } = buildReportsWhere(filters);

  const sqlWithDelete = `
    SELECT COUNT(*)::int AS cnt
    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    WHERE ${whereSql}
      AND sc.deleted_at IS NULL
  `;

  const sqlNoDelete = `
    SELECT COUNT(*)::int AS cnt
    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    WHERE ${whereSql}
  `;

  try {
    const r = await pool.query(sqlWithDelete, values);
    return r.rows?.[0]?.cnt ?? 0;
  } catch (_) {
    const r = await pool.query(sqlNoDelete, values);
    return r.rows?.[0]?.cnt ?? 0;
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
    [limit + 1, offset],
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
    [shiftId],
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
        who ? `Инкассация: ${amount} (${who})` : `Инкассация: ${amount}`,
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

  return lines.join("");
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
  await maybeToastImportJobNotification(ctx);

  const admin = isAdmin(user);
  setSt(ctx.from.id, { view: "list" });

  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = { ...(st.filters || {}) }; // сотрудники видят все смены

  // Тумблер "Мои смены" (для всех ролей)
  if (st.onlyMyShifts) {
    filters.workerIds = [user.id];
  }

  // Подключаем период
  if (st.periodFrom) filters.dateFrom = st.periodFrom;
  if (st.periodTo) filters.dateTo = st.periodTo;

  const elements = st.elements || defaultElementsFor(user);
  const format = st.format || defaultFormatFor(user);
  const isAnalysis = ["analysis", "analysis1", "analysis2", "time"].includes(
    format,
  );

  // Данные экрана зависят от формата:
  // - cash/analysis*: shift_closings
  // - products: POS items (из таблиц pos_sales_*)
  let rows = [];
  let hasMore = false;
  let workersMap = new Map();
  let productsTotalPages = 1;

  if (format === "products") {
    const topActive = st.productsTopActive !== false;
    const perPage = topActive ? 20 : 25;
    const pointIds = Array.isArray(filters.pointIds) ? filters.pointIds : [];

    // ── Автоподгрузка из кассы по правилам:
    // 1) старый период + есть данные -> только БД
    // 2) старый период + нет данных -> импорт (лимит 31 день)
    // 3) период = сегодня -> на каждый заход делаем импорт, но импортёр сам пропускает уже загруженные чеки
    try {
      const df = String(filters.dateFrom || "");
      const dt = String(filters.dateTo || "");
      const todayStr = fmtPgDate(todayLocalDate());
      const isToday = df === todayStr && dt === todayStr;

      const hasLocal = await hasAnyProducts({
        dateFrom: df,
        dateTo: dt,
        pointIds: pointIds.length ? pointIds : null,
      });

      let needImport = false;
      let importDays = 0;

      if (isToday) {
        needImport = true;
        importDays = 1;
      } else if (!hasLocal) {
        needImport = true;

        // лимит 31 день, даже если период больше
        const days = diffDaysIso(df, dt) + 1;
        importDays = Math.min(31, Math.max(1, days || 31));
      }

      if (needImport) {
        const res = await importModulposSales({
          pool,
          days: importDays,
          tradePointIds: pointIds.length ? pointIds : null,
        });
        // тост только если реально что-то подтянули
        if ((res?.docsInserted || 0) > 0 || (res?.itemsInserted || 0) > 0) {
          await toast(ctx, "Прогрузилось");
        }
      }
    } catch (_) {
      // автозагрузка не должна ломать экран
    }

    let safePage = 0;
    let offset = 0;
    if (!topActive) {
      const totalCnt = await countProducts({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds: pointIds.length ? pointIds : null,
      });
      productsTotalPages = Math.max(
        1,
        Math.ceil((Number(totalCnt) || 0) / perPage),
      );

      safePage = Math.min(
        Math.max(0, Number.isInteger(page) ? page : 0),
        productsTotalPages - 1,
      );
      if (safePage !== page) setSt(ctx.from.id, { page: safePage });
      offset = safePage * perPage;
    } else {
      productsTotalPages = 1;
      safePage = 0;
      offset = 0;
    }
    rows = await loadProductsPage({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      pointIds: pointIds.length ? pointIds : null,
      limit: perPage,
      offset,
      sort: st.productsTopMode || "to",
    });

    hasMore = topActive ? false : safePage < productsTotalPages - 1;
    setSt(ctx.from.id, { hasMore });
  } else {
    if (format === "analysis1" || format === "analysis2") {
      // аналитика теперь берётся с кассы (POS)
      rows = await loadCashAnalysisRows({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });
      hasMore = false;
      setSt(ctx.from.id, { hasMore: false });
    } else if (format === "time") {
      // анализ по времени (по часам) — POS
      rows = await loadCashTimeByHour({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });
      hasMore = false;
      setSt(ctx.from.id, { hasMore: false });
    } else if (format === "weekday") {
      // анализ по дням недели — POS
      rows = await loadCashWeekdayAgg({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });
      hasMore = false;
      setSt(ctx.from.id, { hasMore: false });
    } else {
      const limit = isAnalysis ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

      // housekeeping (best-effort)
      await purgeOldDeletedReports();

      const r = await loadReportsPage({ page, filters, limit });
      rows = r.rows;
      hasMore = r.hasMore;
      workersMap = await loadWorkersForShiftIds(rows.map((x) => x.shift_id));
      setSt(ctx.from.id, { hasMore });
    }
  }

  const inDateUi = Boolean(st.dateUi); // открыт выбор периода
  const filterOpened = admin && Boolean(st.filterOpened); // ✅ разрешаем фильтр внутри периода

  const formatLabel = isAnalysis ? "для анализа" : "стандарт";

  // label точек для заголовка аналитики
  let pointsLabel = "Все";
  try {
    const f = filters || {};
    if (Array.isArray(f.pointIds) && f.pointIds.length) {
      const r = await pool.query(
        `SELECT id, title FROM trade_points WHERE id = ANY($1::int[]) ORDER BY title NULLS LAST, id`,
        [f.pointIds],
      );
      const titles = r.rows.map((x) => x.title || `Точка #${x.id}`);
      if (titles.length) pointsLabel = titles.join(", ");
    }
  } catch (_) {
    // молча оставляем "Все"
  }

  // месяц заголовка берём из periodFrom (выбранный месяц в конструкторе)
  const monthIdxForTitle = st.periodFrom
    ? Number(String(st.periodFrom).split("-")[1]) - 1
    : todayLocalDate().getMonth();
  const monthTitleCap = (() => {
    const s = monthNameRu(monthIdxForTitle) || "";
    return s ? s[0].toUpperCase() + s.slice(1) : "";
  })();

  const header = admin
    ? format === "cash"
      ? ` <b>Отчёты (стандарт)</b>`
      : ` <b>(${pointsLabel}) Аналитика за ${monthTitleCap}</b>`
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
          [f.pointIds],
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

  // Для "для анализа (по точкам)" нужны статусы смен по кассе + (опц.) кто открыл смену
  let analysis2StatusMap = null;
  let analysis2OpenerMap = null;
  let analysis2ShowOpener = false;
  let analysis2OnlyOpened = false;
  let analysis2Page = Number.isInteger(st.analysis2Page) ? st.analysis2Page : 0;
  let analysis2SortKey = null;
  try {
    if (format === "analysis2") {
      const todayStr = fmtPgDate(todayLocalDate());
      const isToday =
        String(filters.dateFrom) === todayStr &&
        String(filters.dateTo) === todayStr;
      analysis2OnlyOpened = Boolean(st.analysis2OnlyOpened) && isToday;
      analysis2ShowOpener = analysis2OnlyOpened;
      analysis2SortKey =
        analysis2Page === 1
          ? st.analysis2SortKey1 || "to"
          : st.analysis2SortKey0 || "to";

      const pointIds =
        Array.isArray(filters.pointIds) && filters.pointIds.length
          ? filters.pointIds
          : null;
      analysis2StatusMap = await loadModulposShiftStatusByPoints({
        pool,
        tradePointIds: pointIds,
        days: 2,
      });
      analysis2OpenerMap = analysis2ShowOpener
        ? await loadBotShiftOpenersToday({ pointIds })
        : new Map();
    }
  } catch (_) {
    // не ломаем экран из-за API
  }

  // Для "по времени" нужна длительность периода (в днях)
  let timeTotalDays = 1;
  try {
    const fromIso = String(st.periodFrom || filters.dateFrom || "");
    const toIso = String(st.periodTo || filters.dateTo || "");
    const fromD = parsePgDateToDate(fromIso);
    const toD = parsePgDateToDate(toIso);
    if (fromD && toD) {
      const msPerDay = 24 * 60 * 60 * 1000;
      timeTotalDays = Math.max(1, Math.round((toD - fromD) / msPerDay) + 1);
    }
  } catch (_) {
    timeTotalDays = 1;
  }

  let body =
    format === "products"
      ? "Пока нет продаж по кассе за период."
      : "Пока нет закрытых смен.";

  const weekdayMode = Number.isInteger(st.weekdayMode) ? st.weekdayMode : 0;
  const wantsWeekdayPhoto = format === "weekday";

  if (format === "time") {
    const mode = Number.isInteger(st.timeMode) ? st.timeMode : 0;

    if (mode === 1) {
      // Пивот по точкам (топ-4 по ТО)
      const pivotRows = await loadCashTimeByHourByPoint({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });

      // топ-4 точек по ТО
      const totals = new Map();
      const titles = new Map();
      for (const r of pivotRows || []) {
        const tp = Number(r.trade_point_id);
        if (!Number.isFinite(tp)) continue;
        totals.set(tp, (totals.get(tp) || 0) + (Number(r.sales_total) || 0));
        if (!titles.has(tp)) {
          titles.set(tp, String(r.trade_point_title || `Точка #${tp}`));
        }
      }

      const topPoints = Array.from(totals.entries())
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .slice(0, 4)
        .map(([id]) => ({ id, title: titles.get(id) || `Точка #${id}` }));

      body = topPoints.length
        ? renderTimeMode1(pivotRows, { totalDays: timeTotalDays, topPoints })
        : renderTimeMode0(rows, { totalDays: timeTotalDays });
    } else if (mode === 2) {
      body = renderTimeMode2(rows, { totalDays: timeTotalDays });
    } else {
      body = renderTimeMode0(rows, { totalDays: timeTotalDays });
    }
  } else if (format === "weekday") {
    // формат "по дням недели" всегда рендерим картинкой ниже
    body = "";
  } else if (format === "products") {
    if (rows.length) {
      body = renderProductsTable(rows, { limit: 25 });
    }
  } else if (rows.length) {
    const isAnalysisFmt = format === "analysis1" || format === "analysis2";

    const rowsForUi = isAnalysisFmt ? rows : rows.slice().reverse();

    const detailed = admin && Boolean(st.cashDetailed);
    const thresholds = await loadCashDiffThresholdsBestEffort();
    const workersMap = await loadWorkersForShiftIds(
      rows.map((r) => r.shift_id),
    );

    // ✅ скрытие таблицы работает и для analysis1 и для analysis2
    if (hideTable && isAnalysisFmt) {
      body = ""; // оставляем только header + summaryBlock (и фильтры если раскрыты)
    } else {
      body = isAnalysisFmt
        ? format === "analysis2"
          ? renderAnalysisTable2(rowsForUi, {
              filters,
              page: analysis2Page,
              sortKey: analysis2SortKey || "to",
              statusMap: analysis2StatusMap,
              openerMap: analysis2OpenerMap,
              showOpener: analysis2ShowOpener,
              onlyOpened: analysis2OnlyOpened,
            })
          : renderAnalysisTable(rowsForUi, { elements, filters })
        : rowsForUi
            .map((r) =>
              renderCashCard(r, {
                admin,
                detailed,
                thresholds,
                workers: workersMap.get(Number(r.shift_id)) || null,
              }),
            )
            .join("\n\n");
    }
  }

  // Сводка показывается ТОЛЬКО когда фильтр закрыт
  // И теперь источник истины — касса (POS) для аналитики и товаров.
  let summaryBlock = null;

  if (!filterOpened && (isAnalysis || format === "products")) {
    const fromIso = String(st.periodFrom || filters.dateFrom || "");
    const toIso = String(st.periodTo || filters.dateTo || "");

    const fromD = parsePgDateToDate(fromIso);
    const toD = parsePgDateToDate(toIso);

    if (fromD && toD) {
      const msPerDay = 24 * 60 * 60 * 1000;
      const totalDays = Math.max(1, Math.round((toD - fromD) / msPerDay) + 1);

      // суммы за полный выбранный период
      const cash = await loadCashSummary({
        dateFrom: fromIso,
        dateTo: toIso,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });

      const sumSales = Number(cash.sales_total) || 0;
      const sumChecks = Number(cash.checks_count) || 0;

      // для пропущенных дней: если период включает сегодня — считаем только до сегодня
      const today = todayLocalDate();
      const elapsedEnd = toD > today ? today : toD;
      const elapsedDays = Math.max(
        1,
        Math.round((elapsedEnd - fromD) / msPerDay) + 1,
      );

      const active = await loadCashSummary({
        dateFrom: fromIso,
        dateTo: fmtPgDate(elapsedEnd),
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });
      const activeDays = Number(active.active_days) || 0;
      const missed = Math.max(0, elapsedDays - activeDays);

      const fmtRub0 = (n) =>
        `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
          Math.round(Number(n) || 0),
        )} ₽`;

      const fmtRub1 = (n) =>
        `${new Intl.NumberFormat("ru-RU", {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(n)} ₽`;

      const avgCheck = sumChecks ? sumSales / sumChecks : 0;
      const avgSalesPerDay = sumSales ? sumSales / totalDays : 0;
      const avgChecksPerDay = sumChecks ? sumChecks / totalDays : 0;

      summaryBlock = [
        `📊 ${fmtDateShort(fromD)} — ${fmtDateShort(toD)} (${totalDays} дн.)`,
        `<b>Пропущенных дней:</b> ${missed}\n`,
        "",
        `<u><b>Финансы</b></u>`,
        `• <b>Продажи (ТО):</b> ${fmtRub0(sumSales)}`,
        `• <b>Валовая прибыль (ВП):</b> —`,
        `• <b>Чистая прибыль (ЧП):</b> —`,
        `• <b>Средние продажи в день:</b> ${fmtRub0(avgSalesPerDay)}`,
        "",
        `\n<u><b>Поведение гостей</b></u>`,
        `• <b>Кол-во чеков за период:</b> ${fmtMoney(sumChecks)}`,
        `• <b>Средний чек:</b> ${avgCheck ? fmtRub1(avgCheck) : "—"}`,
        `• <b>Среднее кол-во чеков в день:</b> ${
          avgChecksPerDay ? avgChecksPerDay.toFixed(0) : "—"
        }`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  const formatTitle = (() => {
    if (format === "cash") {
      return admin && Boolean(st.cashDetailed)
        ? "кассовый подробно"
        : "кассовый";
    }
    if (format === "analysis1") return "для анализа (по дням)";
    if (format === "analysis2") return "для анализа (по точкам)";
    if (format === "time") return "по времени";
    if (format === "weekday") return "по дням недели";
    if (format === "products") return "по товарам";
    return format;
  })();

  let pageHint = null;
  if (isHeavyFormat({ format })) {
    let totalPages = 1;
    if (format === "products") {
      totalPages = productsTotalPages || 1;
    } else if (format === "cash") {
      const totalCnt = await countReportsTotal(filters);
      totalPages = Math.max(
        1,
        Math.ceil((Number(totalCnt) || 0) / LIST_LIMIT_CASH),
      );
    }
    if (totalPages > 1) {
      const curPage = Number.isInteger(st.page) ? st.page : 0;
      pageHint = `страница ${curPage + 1}/${totalPages} ( листать: &lt; / &gt;)`;
    }
  }

  const text = [
    header,
    filterBlock,
    summaryBlock,
    "",
    body,
    "",
    `формат: ${formatTitle}`,
    pageHint,
  ]
    .filter(Boolean)
    .join("\n");

  const st2 = getSt(ctx.from.id) || {};

  // Если открыт выбор даты — показываем его клавиатуру (main или pick)

  let kb = null;

  // helper: клавиатура админ-фильтра внутри периода
  const renderAdminFilterKeyboard = () => {
    const onlyMy = Boolean(st2.onlyMyShifts);

    const rows = [
      [
        Markup.button.callback(
          "👥 По сотрудникам",
          "lk_reports_filter_workers",
        ),
        Markup.button.callback(
          onlyMy ? "👤 Все смены" : "👤 Мои смены",
          "lk_reports_only_my_toggle",
        ),
      ],
      [
        Markup.button.callback(
          "📆 По дням недели",
          "lk_reports_filter_weekdays",
        ),
        Markup.button.callback("🧩 По элементам", "lk_reports_filter_elements"),
      ],
      [Markup.button.callback("🧹 Сбросить фильтр", "lk_reports_filter_clear")],
      [Markup.button.callback("🔙", "lk_reports_back")],
    ];

    return Markup.inlineKeyboard(rows);
  };

  if (st2.dateUi?.mode === "monthGrid") {
    kb = renderMonthGridKeyboard(st2);
  } else if (st2.dateUi?.mode === "points") {
    const r = await pool.query(
      `SELECT id, title FROM trade_points ORDER BY title NULLS LAST, id`,
    );
    kb = renderDatePointsKeyboard(r.rows || [], st2);
  } else if (st2.dateUi?.mode === "pick") {
    kb = renderPickKeyboard(st2.dateUi);
  } else if (st2.formatUi?.mode === "menu") {
    kb = renderFormatKeyboard(st2);
  } else {
    // Основной экран отчётов: всегда показываем конструктор периода + панель действий
    kb = filterOpened
      ? renderAdminFilterKeyboard()
      : renderDateMainKeyboard({ ...st2, __admin: admin });
  }

  const mode = Number.isInteger(st.timeMode) ? st.timeMode : 0;
  const wantsTimeChart = format === "time" && mode === 2;

  if (wantsWeekdayPhoto) {
    const topSummary = summaryLinesForCaption(summaryBlock);

    let chartUrl = null;
    if (weekdayMode === 2) {
      chartUrl = buildWeekdayTableImageUrl(rows, {
        sortKey: st.weekdaySortKey || "to",
        sortActive: st.weekdaySortActive !== false,
      });
    } else {
      chartUrl = buildWeekdayBarChartUrl(rows, {
        totalDays: timeTotalDays,
        metric: weekdayMode === 1 ? "checks" : "to",
        summaryLines: [],
      });
    }

    const caption = [
      header,
      ...topSummary,
      filterBlock,
      "",
      `формат: ${formatTitle}`,
      pageHint,
    ]
      .filter(Boolean)
      .join("\n");

    // В режиме 3/3 (таблица-картинка) QuickChart/table иногда отдаёт ошибку/не-изображение,
    // и Telegram отвечает IMAGE_PROCESS_FAILED. В этом случае деградируем до текстовой таблицы,
    // чтобы экран не исчезал.
    if (weekdayMode === 2) {
      try {
        return await deliverPhoto(
          ctx,
          {
            url: chartUrl,
            caption,
            kb: kb || null,
          },
          { edit },
        );
      } catch (e) {
        const desc = String(e?.description || e?.response?.description || "");
        if (desc.includes("IMAGE_PROCESS_FAILED")) {
          const tableHtml = renderDowAnalysisTable(rows, {
            sortKey: st.weekdaySortKey || "to",
            sortActive: st.weekdaySortActive !== false,
          });
          const html = [
            header,
            ...topSummary,
            filterBlock,
            "",
            `формат: ${formatTitle}`,
            pageHint,
            "",
            tableHtml,
          ]
            .filter(Boolean)
            .join("\n");

          return deliver(
            ctx,
            {
              text: html,
              extra: { ...(kb || {}), parse_mode: "HTML" },
            },
            { edit },
          );
        }
        throw e;
      }
    }

    return deliverPhoto(
      ctx,
      {
        url: chartUrl,
        caption,
        kb: kb || null,
      },
      { edit },
    );
  }

  if (wantsTimeChart) {
    // 1) Картинка: только график (без показателей)
    const chartUrl = buildTimeBarChartUrl(rows, {
      totalDays: timeTotalDays,
      summaryLines: [], // ❌ ничего не печатаем на картинке
    });

    // 2) Текст под картинкой: только верхушка (без "Финансы" и "Поведение гостей")
    const topSummary = summaryLinesForCaption(summaryBlock);

    const caption = [
      header, // "(Все) Аналитика за Январь" и т.п.
      ...topSummary, // "📊 ..." + "Пропущенных дней: ..."
      filterBlock, // если у тебя тут фильтры — оставляем
      "",
      `формат: ${formatTitle}`,
      pageHint,
    ]
      .filter(Boolean)
      .join("\n");

    // В режиме 3/3 (таблица-картинка) QuickChart/table иногда отдаёт ошибку/не-изображение,
    // и Telegram отвечает IMAGE_PROCESS_FAILED. В этом случае деградируем до текстовой таблицы,
    // чтобы экран не исчезал.
    if (weekdayMode === 2) {
      try {
        return await deliverPhoto(
          ctx,
          {
            url: chartUrl,
            caption,
            kb: kb || null,
          },
          { edit },
        );
      } catch (e) {
        const desc = String(e?.description || e?.response?.description || "");
        if (desc.includes("IMAGE_PROCESS_FAILED")) {
          const tableHtml = renderDowAnalysisTable(rows, {
            sortKey: st.weekdaySortKey || "to",
            sortActive: st.weekdaySortActive !== false,
          });
          const html = [
            header,
            ...topSummary,
            filterBlock,
            "",
            `формат: ${formatTitle}`,
            pageHint,
            "",
            tableHtml,
          ]
            .filter(Boolean)
            .join("\n");

          return deliver(
            ctx,
            {
              text: html,
              extra: { ...(kb || {}), parse_mode: "HTML" },
            },
            { edit },
          );
        }
        throw e;
      }
    }

    return deliverPhoto(
      ctx,
      {
        url: chartUrl,
        caption,
        kb: kb || null,
      },
      { edit },
    );
  }

  return deliver(
    ctx,
    {
      text,
      extra: { ...(kb || {}), parse_mode: "HTML" },
    },
    { edit },
  );
}

async function loadPeriodSettings(userId) {
  const r = await pool.query(
    `SELECT preset, date_from, date_to
     FROM report_period_settings
     WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] || null;
}

async function loadFormatSetting(userId) {
  try {
    const r = await pool.query(
      `SELECT report_format FROM report_period_settings WHERE user_id = $1`,
      [userId],
    );
    return r.rows[0]?.report_format || null;
  } catch (_) {
    // если колонки нет — миграция не применена
    return null;
  }
}

async function saveFormatSetting(userId, format) {
  try {
    await pool.query(
      `INSERT INTO report_period_settings(user_id, preset, date_from, date_to, report_format)
       VALUES ($1, 'month', NULL, NULL, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET report_format = EXCLUDED.report_format,
           updated_at = now()`,
      [userId, format],
    );
  } catch (_) {
    // если колонки нет — миграция не применена
  }
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
    [userId, preset, dateFrom, dateTo],
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
    Array.isArray(filters.workerIds) ? filters.workerIds : [],
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
        `lk_reports_fw_toggle_${u.id}`,
      ),
    ]);
  }

  // nav row
  buttons.push([
    Markup.button.callback(
      "←",
      page > 0 ? "lk_reports_fw_prev" : "lk_reports_nav_no_prev",
    ),
    Markup.button.callback(
      "→",
      hasMore ? "lk_reports_fw_next" : "lk_reports_nav_no_next",
    ),
  ]);

  buttons.push([Markup.button.callback("🔎 Поиск", "lk_reports_fw_search")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit },
  );
}

async function showFiltersPoints(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "tp" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.pickerPage) ? st.pickerPage : 0;
  const filters = st.filters || {};
  const selected = new Set(
    Array.isArray(filters.pointIds) ? filters.pointIds : [],
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
  const isAnalysis2 = format2 === "analysis1" || format2 === "analysis2";
  const limit2 = isAnalysis2 ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: pageList,
    filters: filters2,
    limit: limit2,
  });

  // формируем summaryBlock (копия логики showReportsList)
  let summaryBlock2 = null;
  if (isAnalysis2 && listRows.length) {
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
      0,
    );
    const sumChecks = listRows.reduce(
      (acc, r) => acc + (Number(r.checks_count) || 0),
      0,
    );

    const fmtRub0 = (n) =>
      `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
        Math.round(Number(n) || 0),
      )} ₽`;

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
    const rowsForUi = listRows;

    body2 = isAnalysis2
      ? format2 === "analysis2"
        ? renderAnalysisTable2(rowsForUi, { filters: filters2 })
        : renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
      : rowsForUi.map((r) => renderCashCard(r, { admin: admin2 })).join("\n\n");
  }

  const text = [summaryBlock2, "", body2].filter(Boolean).join("\n");

  const buttons = [];

  buttons.push([
    Markup.button.callback(
      "✅ Выбрать всё (на странице)",
      "lk_reports_tp_toggle_page",
    ),
  ]);

  for (const tp of rows) {
    const mark = selected.has(tp.id) ? "✅" : "☑️";
    buttons.push([
      Markup.button.callback(
        `${mark} ${tp.title || `Точка #${tp.id}`}`,
        `lk_reports_tp_toggle_${tp.id}`,
      ),
    ]);
  }
  buttons.push([
    Markup.button.callback(
      "←",
      page > 0 ? "lk_reports_tp_prev" : "lk_reports_nav_no_prev",
    ),
    Markup.button.callback(
      "→",
      hasMore ? "lk_reports_tp_next" : "lk_reports_nav_no_next",
    ),
  ]);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit },
  );
}

async function showFiltersWeekdays(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "dow" });
  const st = getSt(ctx.from.id) || {};
  const filters = st.filters || {};
  const selected = new Set(
    Array.isArray(filters.weekdays) ? filters.weekdays : [],
  );

  const dowAnalysisMode = Boolean(st.dowAnalysisMode);

  // показываем АНАЛИЗ (как на экране отчёта), а не отдельный экран "фильтр"
  const st2 = getSt(ctx.from.id) || {};
  const admin2 = isAdmin(user);
  const filters2 = admin2 ? st2.filters || {} : { workerIds: [user.id] };
  const format2 = st2.format || defaultFormatFor(user);
  const elements2 = st2.elements || defaultElementsFor(user);
  const isAnalysis2 = format2 === "analysis1" || format2 === "analysis2";
  const limit2 = isAnalysis2 ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: 0,
    filters: filters2,
    limit: limit2,
  });

  // Период (как сейчас у тебя в showFiltersWeekdays): min/max по данным
  const dates = listRows
    .map((r) => (r.opened_at ? new Date(r.opened_at) : null))
    .filter(Boolean);

  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;

  const minD = dates.length
    ? new Date(Math.min(...dates.map((d) => dayStart(d).getTime())))
    : dayStart(todayLocalDate());

  const maxD = dates.length
    ? new Date(Math.max(...dates.map((d) => dayStart(d).getTime())))
    : dayStart(todayLocalDate());

  const days = Math.max(1, Math.round((maxD - minD) / msPerDay) + 1);

  const periodFrom = fmtDateShort(minD);
  const periodTo = fmtDateShort(maxD);

  // название выбранных точек для короткой шапки
  let pointsLabel = "Все";
  try {
    const f = filters2 || {};
    if (Array.isArray(f.pointIds) && f.pointIds.length) {
      const r = await pool.query(
        `SELECT id, title FROM trade_points WHERE id = ANY($1::int[]) ORDER BY title NULLS LAST, id`,
        [f.pointIds],
      );
      const titles = r.rows.map((x) => x.title || `Точка #${x.id}`);
      if (titles.length) pointsLabel = titles.join(", ");
    }
  } catch (_) {}

  // ─────────────────────────────────────────────
  // MODE: Анализ ДН (только короткая шапка + таблица)
  // ─────────────────────────────────────────────
  if (dowAnalysisMode) {
    const headerLine = `(${pointsLabel}) 📊 ${periodFrom} — ${periodTo} (${days} дн)`;

    const stNow = getSt(ctx.from.id) || {};
    const sortKey = stNow.dowSortKey || null;
    const sortActive = Boolean(stNow.dowSortActive);

    // В этом режиме: таблица "ДН | ТО | %ТО | ... | чек | %чек"
    const table = renderDowAnalysisTable(listRows, { sortKey, sortActive });

    const text = [headerLine, "", table].filter(Boolean).join("\n");

    const m = (k) => (sortActive && sortKey === k ? "✅" : "↕️");

    const buttons = [
      [
        Markup.button.callback(`${m("to")} ТО`, "lk_reports_dow_sort_to"),
        Markup.button.callback(`${m("vp")} ВП`, "lk_reports_dow_sort_vp"),
        Markup.button.callback(
          `${m("checks")} Чек`,
          "lk_reports_dow_sort_checks",
        ),
      ],
      [
        Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list"),
        Markup.button.callback("Анализ ДН", "lk_reports_dow_analysis_toggle"),
      ],
    ];

    return deliver(
      ctx,
      {
        text,
        extra: {
          ...(Markup.inlineKeyboard(buttons) || {}),
          parse_mode: "HTML",
        },
      },
      { edit },
    );
  }

  // ─────────────────────────────────────────────
  // MODE: обычный выбор дней недели (как было), но:
  // + будние/выходные
  // + кнопка "Анализ ДН"
  // ─────────────────────────────────────────────

  // старый summaryBlock2 (оставляем как есть у тебя)
  let summaryBlock2 = null;
  if (isAnalysis2 && listRows.length) {
    const sumSales = listRows.reduce(
      (acc, r) => acc + (Number(r.sales_total) || 0),
      0,
    );
    const sumChecks = listRows.reduce(
      (acc, r) => acc + (Number(r.checks_count) || 0),
      0,
    );

    const fmtRub0 = (n) =>
      `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
        Math.round(Number(n) || 0),
      )} ₽`;

    const fmtRub1 = (n) =>
      `${new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(n)} ₽`;

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
    const rowsForUi = listRows;

    body2 = isAnalysis2
      ? format2 === "analysis2"
        ? renderAnalysisTable2(rowsForUi, { filters: filters2 })
        : renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
      : rowsForUi.map((r) => renderCashCard(r, { admin: admin2 })).join("\n\n");
  }

  const text = [summaryBlock2, "", body2].filter(Boolean).join("\n");

  const btn = (isoDow, label) => {
    const mark = selected.has(isoDow) ? "✅" : "☑️";
    return Markup.button.callback(
      `${mark} ${label}`,
      `lk_reports_dow_${isoDow}`,
    );
  };

  const buttons = [
    [btn(1, "пн"), btn(2, "вт"), btn(3, "ср")],
    [btn(4, "чт"), btn(5, "пт"), btn(6, "сб")],
    [
      btn(7, "вс"),
      Markup.button.callback("будние", "lk_reports_dow_set_weekdays"),
      Markup.button.callback("выходные", "lk_reports_dow_set_weekends"),
    ],
    [
      Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list"),
      Markup.button.callback("Анализ ДН", "lk_reports_dow_analysis_toggle"),
    ],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit },
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
  const isAnalysis2 = format2 === "analysis1" || format2 === "analysis2";
  const limit2 = isAnalysis2 ? LIST_LIMIT_ANALYTICS : LIST_LIMIT_CASH;

  const { rows: listRows } = await loadReportsPage({
    page: 0,
    filters: filters2,
    limit: limit2,
  });

  let summaryBlock2 = null;
  let body2 = "Пока нет закрытых смен.";
  if (listRows.length) {
    const rowsForUi = listRows;

    body2 = isAnalysis2
      ? format2 === "analysis2"
        ? renderAnalysisTable2(rowsForUi, { filters: filters2 })
        : renderAnalysisTable(rowsForUi, {
            elements: elements2,
            filters: filters2,
          })
      : rowsForUi.map((r) => renderCashCard(r, { admin: admin2 })).join("\n\n");
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
    { edit },
  );
}

async function showSettings(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "settings" });

  const st = getSt(ctx.from.id) || {};

  const text = "⚙️ <b>Настройки отчётов</b>\n\nВыберите действие:";

  const buttons = [];

  buttons.push([
    Markup.button.callback("ℹ️ Доп. информация", "lk_reports_info"),
  ]);

  // Только админские действия
  if (isAdmin(user)) {
    buttons.push([
      Markup.button.callback("🗑 Удалить отчёты", "lk_reports_delete_mode"),
    ]);
    buttons.push([
      Markup.button.callback("✏️ Изменить отчёт", "lk_reports_edit_last"),
    ]);
    buttons.push([
      Markup.button.callback("📥 Загрузка отчётов", "lk_reports_import_menu"),
    ]);
  }

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_back_to_list")]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit },
  );
}

async function showDeleteMode(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "delete" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = st.filters || {};
  const selected = new Set(Array.isArray(st.delSelected) ? st.delSelected : []);

  const { rows, hasMore } = await loadReportsPage({ page, filters });
  setSt(ctx.from.id, { hasMore });

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
        `lk_reports_del_${r.shift_id}`,
      ),
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
    { edit },
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
    { edit },
  );
}

async function showEditPick(ctx, user, { edit = true } = {}) {
  setSt(ctx.from.id, { view: "edit_pick" });
  const st = getSt(ctx.from.id) || {};
  const page = Number.isInteger(st.page) ? st.page : 0;
  const filters = st.filters || {};

  const { rows, hasMore } = await loadReportsPage({ page, filters });
  setSt(ctx.from.id, { hasMore });

  const header = "✏️ <b>Выберите отчёт для изменения</b>";
  const body = rows.length
    ? rows
        .map((r, i) =>
          formatReportCard(r, i + 1 + page * LIST_LIMIT_CASH, {
            admin: true,
            elements: defaultElementsFor(user),
          }),
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
      Markup.button.callback(`${n}`, `lk_reports_edit_open_${r.shift_id}`),
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
    { edit },
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
      { edit },
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
      ORDER BY COALESCE(s.opened_at, s.closed_at) DESC NULLS LAST, s.id DESC

      LIMIT 1
      `,
      [user.id],
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
        "lk_reports_edit_field_sales_total",
      ),
    ],
    [Markup.button.callback("Наличными", "lk_reports_edit_field_sales_cash")],
    [Markup.button.callback("В кассе", "lk_reports_edit_field_cash_in_drawer")],
    [
      Markup.button.callback(
        "Инкассация",
        "lk_reports_edit_field_cash_collection_amount",
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
      admin ? "lk_reports_edit_pick" : "lk_reports_back_to_list",
    ),
  ]);

  return deliver(
    ctx,
    {
      text,
      extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
    },
    { edit },
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
    { edit },
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
    { edit },
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
    { edit },
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

function monthNameRuShort(m) {
  const names = [
    "янв.",
    "фев.",
    "мар.",
    "апр.",
    "май",
    "июн.",
    "июл.",
    "авг.",
    "сен.",
    "окт.",
    "ноя.",
    "дек.",
  ];
  return names[m] || "—";
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
  const monthTitle = monthNameRuShort(curMonthIdx);
  const yearShort = String(f[0]).slice(-2);

  const btn = (text, data) => Markup.button.callback(text, data);

  // 1) Месяц: (опционально) <  ←  янв. 26  →  >
  const heavy = isHeavyFormat(st);
  const isPointsAnalysis = st?.format === "analysis2";
  const page = Number.isInteger(st.page) ? st.page : 0;
  const hasMore = Boolean(st.hasMore);
  const a2Page = Number.isInteger(st.analysis2Page) ? st.analysis2Page : 0;

  const rowMonth = heavy
    ? [
        btn(
          page > 0 ? "<" : "<",
          page > 0 ? "lk_reports_less" : "lk_reports_nav_no_prev",
        ),
        btn("←", "date_month:prev"),
        btn(`${monthTitle} ${yearShort}`, "date_month:menu"),
        btn("→", "date_month:next"),
        btn(
          hasMore ? ">" : ">",
          hasMore ? "lk_reports_more" : "lk_reports_nav_no_next",
        ),
      ]
    : isPointsAnalysis
      ? [
          btn(
            a2Page > 0 ? "<" : "<",
            a2Page > 0 ? "analysis2:page_prev" : "analysis2:page_prev",
          ),
          btn("←", "date_month:prev"),
          btn(`${monthTitle} ${yearShort}`, "date_month:menu"),
          btn("→", "date_month:next"),
          btn(
            a2Page < 1 ? ">" : ">",
            a2Page < 1 ? "analysis2:page_next" : "analysis2:page_next",
          ),
        ]
      : [
          btn("←", "date_month:prev"),
          btn(`${monthTitle} ${yearShort}`, "date_month:menu"),
          btn("→", "date_month:next"),
        ];

  // 2) Конструктор дат (точки на дд. и мм.)
  const rowDates = [
    btn(`${fd}.`, "date_part:from:d"),
    btn(`${fm}.`, "date_part:from:m"),
    btn(`${fy}`, "date_part:from:y"),
    btn("—", "date_table:toggle"),
    btn(`${td}.`, "date_part:to:d"),
    btn(`${tm}.`, "date_part:to:m"),
    btn(`${ty}`, "date_part:to:y"),
  ];

  // 3) неделя/месяц/год
  const rowWeekMonth = [
    btn(preset === "week" ? "✅ эта неделя" : "эта неделя", "date_preset:week"),
    btn(preset === "month" ? "✅ месяц" : "месяц", "date_preset:month"),
    btn(preset === "year" ? "✅ год" : "Год", "date_preset:year"),
  ];

  // 4) вчера/сегодня
  const rowYesterdayToday = [
    btn(preset === "yesterday" ? "✅ вчера" : "вчера", "date_preset:yesterday"),
    btn(preset === "today" ? "✅ сегодня" : "сегодня", "date_preset:today"),
  ];

  // 4.5) Топ по (только для формата товаров)
  const isProducts = st?.format === "products";
  const topActive = st?.productsTopActive !== false; // по умолчанию ВКЛ
  const topMode = topActive ? st?.productsTopMode || "to" : null;
  const rowTopBy = isProducts
    ? [
        btn("Топ по:", "noop"),
        btn(topMode === "to" ? "✅ ТО" : "ТО", "lk_products_top_to"),
        btn(topMode === "vp" ? "✅ ВП" : "ВП", "lk_products_top_vp"),
        btn(topMode === "qty" ? "✅ кол-ву" : "кол-ву", "lk_products_top_qty"),
        btn("⟲", "lk_products_top_reset"),
      ]
    : null;

  // 5) нижний ряд: 🔙 | 🔍 | 📍 | 🎛️ | ⚙
  const admin = Boolean(st.__admin); // проставим перед рендером клавы
  const filterOpened = Boolean(st.filterOpened);
  const rowBottom = [
    btn("🔙", "lk_reports_back"),
    admin
      ? btn("🔍", filterOpened ? "date_filter:close" : "date_filter:open")
      : btn(" ", "noop"),
    btn("📍", "date_points:open"),
    admin ? btn("🎛️", "lk_reports_format_open") : btn(" ", "noop"),
    admin ? btn("⚙", "lk_reports_settings") : btn(" ", "noop"),
  ];

  // 4.8) Сортировки для "для анализа (по точкам)" + фильтр 👤
  const todayStr = fmtPgDate(todayLocalDate());
  const isToday = String(from) === todayStr && String(to) === todayStr;
  const a2SortKey0 = st?.analysis2SortKey0 || "to";
  const a2SortKey1 = st?.analysis2SortKey1 || "to";
  const a2SortKey = a2Page === 1 ? a2SortKey1 : a2SortKey0;
  const a2UserOn = Boolean(st?.analysis2OnlyOpened);
  const markA2 = (key, label) =>
    a2SortKey === key ? `✅↕️ ${label}` : `↕️ ${label}`;
  const rowA2Sort = isPointsAnalysis
    ? a2Page === 0
      ? [
          btn(markA2("to", "ТО"), "analysis2:sort:to"),
          btn(markA2("vp", "ВП"), "analysis2:sort:vp"),
          btn(markA2("np", "ЧП"), "analysis2:sort:np"),
          ...(isToday
            ? [btn(a2UserOn ? "✅👤" : "👤", "analysis2:toggle_user")]
            : [btn(" ", "noop")]),
        ]
      : [
          btn(markA2("to", "ТО"), "analysis2:sort:to"),
          btn(markA2("avg", "ср.чек"), "analysis2:sort:avg"),
          btn(markA2("checks", "чек"), "analysis2:sort:checks"),
          ...(isToday
            ? [btn(a2UserOn ? "✅👤" : "👤", "analysis2:toggle_user")]
            : [btn(" ", "noop")]),
        ]
    : null;

  // 4.9) Переключатель режима для "По времени" + график
  const isTime = st?.format === "time";
  const timeMode = Number.isInteger(st?.timeMode) ? st.timeMode : 0;
  const timeModeLabel =
    timeMode === 1 ? "по точкам" : timeMode === 2 ? "бар" : "ТО/чеки";

  const rowTimeMode = isTime
    ? [btn(`🔁 ${timeModeLabel} (${(timeMode % 3) + 1}/3)`, "time:mode_toggle")]
    : null;

  // 4.10) Переключатель режима для "По дням недели" + (в режиме таблицы) сортировки
  const isWeekday = st?.format === "weekday";
  const weekdayMode = Number.isInteger(st?.weekdayMode) ? st.weekdayMode : 0;
  const weekdayModeLabel =
    weekdayMode === 1 ? "бар чек" : weekdayMode === 2 ? "таблица" : "бар ТО";

  const rowWeekdayMode = isWeekday
    ? [
        btn(
          `🔁 ${weekdayModeLabel} (${(weekdayMode % 3) + 1}/3)`,
          "weekday:mode_toggle",
        ),
      ]
    : null;

  const wSortKey = st?.weekdaySortKey || "to";
  const wSortActive = st?.weekdaySortActive !== false; // по умолчанию ВКЛ
  const markW = (k, label) =>
    wSortActive && wSortKey === k ? `✅⬆️ ${label}` : `⬆️ ${label}`;

  const rowWeekdaySort =
    isWeekday && weekdayMode === 2
      ? [
          btn(markW("to", "ТО"), "weekday:sort:to"),
          btn(markW("vp", "ВП"), "weekday:sort:vp"),
          btn(markW("checks", "Чек"), "weekday:sort:checks"),
        ]
      : null;

  return Markup.inlineKeyboard([
    rowMonth,
    rowDates,
    rowWeekMonth,
    rowYesterdayToday,
    ...(rowTopBy ? [rowTopBy] : []),
    ...(rowA2Sort ? [rowA2Sort] : []),
    ...(rowTimeMode ? [rowTimeMode] : []),
    ...(rowWeekdayMode ? [rowWeekdayMode] : []),
    ...(rowWeekdaySort ? [rowWeekdaySort] : []),

    rowBottom,
  ]);
}

function renderDatePointsKeyboard(tradePoints, st) {
  const btn = (text, data) => Markup.button.callback(text, data);

  const filters = st.filters || {};
  const curId =
    Array.isArray(filters.pointIds) && filters.pointIds.length
      ? Number(filters.pointIds[0])
      : null;

  const rows = [];

  // первая строка: "Все"
  rows.push([btn(curId == null ? "✅ Все" : "☑️ Все", "date_points:set_all")]);

  // по 3 в ряд
  let cur = [];
  for (const tp of tradePoints) {
    const mark = Number(tp.id) === curId ? "✅ " : "☑️ ";
    cur.push(
      btn(`${mark}${tp.title || `#${tp.id}`}`, `date_points:set:${tp.id}`),
    );
    if (cur.length === 3) {
      rows.push(cur);
      cur = [];
    }
  }
  if (cur.length) rows.push(cur);

  rows.push([btn("🔙", "date_points:back")]);
  return Markup.inlineKeyboard(rows);
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
    { edit },
  );
}

const MONTHS_GRID_RU = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

function renderMonthGridKeyboard(st) {
  const btn = (text, data) => Markup.button.callback(text, data);

  const now = todayLocalDate();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth(); // 0..11

  const from = st.periodFrom || toPgDate(now);
  const f = String(from).split("-");
  const selectedYear = Number(f[0]);
  const selectedMonthIdx = Number(f[1]) - 1;

  const year =
    Number(st.dateUi?.year) ||
    (Number.isFinite(selectedYear) ? selectedYear : currentYear);

  const rows = [];

  // верхняя строка: год + стрелки
  rows.push([
    btn("←", "date_month_year:prev"),
    btn(String(year), "noop"),
    btn(
      year >= currentYear ? "→" : "→",
      year >= currentYear ? "noop" : "date_month_year:next",
    ),
  ]);

  // 12 месяцев сеткой 4х3
  let cur = [];
  for (let m = 0; m < 12; m++) {
    const isFuture =
      year > currentYear || (year === currentYear && m > currentMonthIdx);

    const isSelected = year === selectedYear && m === selectedMonthIdx;
    const label = isSelected ? `✅ ${MONTHS_GRID_RU[m]}` : MONTHS_GRID_RU[m];

    cur.push(
      btn(label, isFuture ? "noop" : `date_month_pick:${year}:${m + 1}`),
    );

    if (cur.length === 4) {
      rows.push(cur);
      cur = [];
    }
  }
  if (cur.length) rows.push(cur);

  rows.push([btn("⬅️ Назад", "date_open")]);
  return Markup.inlineKeyboard(rows);
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
      years.map((yy) => btn(String(yy).slice(-2), `date_pick:${side}:y:${yy}`)),
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
    { edit },
  );
}

// ───────────────────────────────────────────────────────────────
// Register
// ───────────────────────────────────────────────────────────────
function registerReports(bot, ensureUser, logError) {
  // воркер очереди импорта ModulPOS (фоновые jobs)
  // запуск 1 раз на процесс
  startModulposImportJobsWorker({ intervalMs: 2500 });

  bot.action("lk_reports_cash_detail_toggle", async (ctx) => {
    const st = getSt(ctx.from.id) || {};
    if ((st.format || "cash") !== "cash") {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const st = getSt(ctx.from.id) || {};
      const next = !Boolean(st.cashDetailed);

      setSt(ctx.from.id, { cashDetailed: next, formatUi: { mode: "menu" } });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_cash_detail_toggle", e);
    }
  });

  bot.action("date_filter:open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return;

      // открываем admin-фильтр, оставаясь в dateUi (экран не меняется)
      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, {
        filterOpened: !st.filterOpened,
        view: "list",
        dateUi: { mode: "main" },
      });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_filter_open", e);
    }
  });

  bot.action("lk_reports_dow_analysis_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};

      // если сейчас режим ВКЛЮЧЕН и мы его выключаем — сбросить сортировку
      if (st.dowAnalysisMode) {
        setSt(ctx.from.id, { dowSortKey: null, dowSortActive: false });
      }

      setSt(ctx.from.id, { dowAnalysisMode: !st.dowAnalysisMode });

      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_analysis_toggle", e);
    }
  });

  function toggleDowSort(ctx, key) {
    const st = getSt(ctx.from.id) || {};
    const curKey = st.dowSortKey || null;
    const curActive = Boolean(st.dowSortActive);

    // повторное нажатие по тому же ключу -> выключаем сортировку
    if (curActive && curKey === key) {
      setSt(ctx.from.id, { dowSortKey: null, dowSortActive: false });
    } else {
      setSt(ctx.from.id, { dowSortKey: key, dowSortActive: true });
    }
  }

  bot.action("lk_reports_dow_sort_to", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      toggleDowSort(ctx, "to");
      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_sort_to", e);
    }
  });

  bot.action("lk_reports_dow_sort_vp", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      toggleDowSort(ctx, "vp");
      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_sort_vp", e);
    }
  });

  bot.action("lk_reports_dow_sort_checks", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      toggleDowSort(ctx, "checks");
      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_sort_checks", e);
    }
  });

  bot.action("lk_reports_dow_set_weekdays", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};
      setSt(ctx.from.id, {
        filters: { ...filters, weekdays: [1, 2, 3, 4, 5] },
      });

      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_set_weekdays", e);
    }
  });

  bot.action("lk_reports_dow_set_weekends", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};
      setSt(ctx.from.id, { filters: { ...filters, weekdays: [6, 7] } });

      await showFiltersWeekdays(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_dow_set_weekends", e);
    }
  });

  bot.action("date_filter:close", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { filterOpened: false, dateUi: { mode: "main" } });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_filter_close", e);
    }
  });

  bot.action("noop", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.action("lk_reports_period_open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setSt(ctx.from.id, {
        dateUi: { mode: "main" },
        view: "list",
        dateUiEntry: "reports", // 👈 откуда открыли период
      });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_period_open", e);
    }
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
    setSt(ctx.from.id, {
      dateUi: null,
      dateUiEntry: null,
      filterOpened: false,
    });
    await showReportsList(ctx, user, { edit: true });
  });

  bot.action("date_points:open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setSt(ctx.from.id, { dateUi: { mode: "points" } });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_points_open", e);
    }
  });

  bot.action("date_points:back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, {
        dateUi: null,
        dateUiEntry: null,
        filterOpened: false,
      });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_points_back", e);
    }
  });

  bot.action(/^date_points:set:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const id = Number(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};

      setSt(ctx.from.id, {
        filters: { ...filters, pointIds: [id] }, // ✅ одиночный выбор
        page: 0,
        dateUi: { mode: "points" },
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_points_set", e);
    }
  });

  bot.action("date_points:set_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const filters = st.filters || {};

      setSt(ctx.from.id, {
        filters: { ...filters, pointIds: [] }, // ✅ "Все"
        page: 0,
        dateUi: { mode: "points" },
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_points_set_all", e);
    }
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

  bot.action(/^date_preset:(yesterday|today|week|month|year)$/, async (ctx) => {
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
    } else if (p === "year") {
      from = new Date(t.getFullYear(), 0, 1);
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

  // открыть сетку месяцев
  bot.action("date_month:menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const year = st.periodFrom
        ? Number(String(st.periodFrom).split("-")[0])
        : todayLocalDate().getFullYear();

      setSt(ctx.from.id, {
        dateUi: { mode: "monthGrid", year },
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_month_menu", e);
    }
  });

  // листание лет в сетке месяцев
  bot.action(/^date_month_year:(prev|next)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const [, dir] = ctx.match;
      const st = getSt(ctx.from.id) || {};
      const now = todayLocalDate();
      const currentYear = now.getFullYear();

      let year = Number(st.dateUi?.year);
      if (!Number.isFinite(year)) {
        year = st.periodFrom
          ? Number(String(st.periodFrom).split("-")[0])
          : currentYear;
      }

      if (dir === "prev") year -= 1;
      if (dir === "next") year += 1;

      if (year > currentYear) year = currentYear;

      setSt(ctx.from.id, { dateUi: { mode: "monthGrid", year } });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("date_month_year_nav", e);
    }
  });

  // выбор месяца из сетки
  bot.action(/^date_month_pick:(\d{4}):(\d{1,2})$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const [, yStr, mStr] = ctx.match;
      const year = Number(yStr);
      const month = Number(mStr); // 1..12

      const now = todayLocalDate();
      const base = new Date(now.getFullYear(), now.getMonth(), 1);

      const sel = new Date(year, month - 1, 1);
      let off =
        (sel.getFullYear() - base.getFullYear()) * 12 +
        (sel.getMonth() - base.getMonth());

      // запрет будущего
      if (off > 0) off = 0;

      const from = new Date(year, month - 1, 1);
      const to = new Date(year, month, 0); // последний день месяца
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
      logError("date_month_pick", e);
    }
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
      const st0 = getSt(ctx.from.id) || {};
      const fmt = st0.format || defaultFormatFor(user);
      if (fmt === "cash") return; // в кассовом — бездействует

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
        format: (await loadFormatSetting(user.id)) || defaultFormatFor(user),
        pickerPage: 0,
        pickerSearch: "",
        delSelected: [],
        editShiftId: null,
        await: null,
        periodPreset: preset,
        periodFrom: toPgDate(from),
        periodTo: toPgDate(to),
        dateUi: { mode: "main" },
        formatUi: null,
      });

      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports", e);
    }
  });

  // Единая кнопка "🔙":
  // - если мы в подменю (фильтр/точки/формат/настройки/пикер) — возвращаемся на основной экран отчётов
  // - если уже на основном экране — возвращаемся в "Аналитика и отчёты" (скрин 3)
  bot.action("lk_reports_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};

      const isSubView =
        Boolean(st.filterOpened) ||
        Boolean(st.formatUi) ||
        Boolean(st.dateUi && st.dateUi.mode && st.dateUi.mode !== "main") ||
        st.view === "settings" ||
        st.view === "delete" ||
        st.view === "edit_pick";

      if (isSubView) {
        setSt(ctx.from.id, {
          filterOpened: false,
          formatUi: null,
          dateUi: { mode: "main" },
          view: "list",
          await: null,
          pickerPage: 0,
          pickerSearch: "",
        });
        return showReportsList(ctx, user, { edit: true });
      }

      // Назад в меню "Аналитика и отчёты" (скрин 3)
      const rows = [
        [Markup.button.callback("📊 Отчёты", "lk_reports")],
        [Markup.button.callback("⬅️ Назад", "lk_profile_shift")],
      ];

      return deliver(
        ctx,
        {
          text: "📊 Аналитика и отчёты\n\nВыберите раздел:",
          extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
        },
        { edit: true },
      );
    } catch (e) {
      logError("lk_reports_back", e);
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

  // noop-кнопки (для "кассовый →" и т.п.)
  bot.action("lk_reports_noop", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
    } catch (_) {}
  });

  // Быстрый выбор "кассовый: стандарт/подробно"
  bot.action("lk_reports_cash_set_standard", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, {
        format: "cash",
        cashDetailed: false,
        page: 0,
        formatUi: null,
      });
      await saveFormatSetting(user.id, "cash");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_cash_set_standard", e);
    }
  });

  bot.action("lk_reports_cash_set_detailed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, {
        format: "cash",
        cashDetailed: true,
        page: 0,
        formatUi: null,
      });
      await saveFormatSetting(user.id, "cash");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_cash_set_detailed", e);
    }
  });

  // Заглушки форматов
  bot.action("lk_reports_format_stub_months", async (ctx) => {
    await toast(ctx, "Скоро: по месяцам").catch(() => {});
  });
  bot.action("lk_reports_format_stub_years", async (ctx) => {
    await toast(ctx, "Скоро: по годам").catch(() => {});
  });
  bot.action("lk_reports_format_stub_staff", async (ctx) => {
    await toast(ctx, "Скоро: по сотрудникам").catch(() => {});
  });

  bot.action("lk_reports_format_set_cash", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, { format: "cash", page: 0, formatUi: null });
      await saveFormatSetting(user.id, "cash");
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
      setSt(ctx.from.id, {
        format: "analysis1",
        cashDetailed: false,
        page: 0,
        formatUi: null,
      });

      await saveFormatSetting(user.id, "analysis1");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_analysis1", e);
    }
  });

  bot.action("lk_reports_format_set_products", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      setSt(ctx.from.id, {
        format: "products",
        cashDetailed: false,
        page: 0,
        formatUi: null,
        productsTopMode: "to",
        productsTopActive: true,
      });

      await saveFormatSetting(user.id, "products");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_products", e);
    }
  });

  // ───────────────────────────────────────────────────────────────
  // Products: top mode (ТО / ВП / кол-ву) + reset
  // ───────────────────────────────────────────────────────────────
  bot.action("lk_products_top_to", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, {
        productsTopMode: "to",
        productsTopActive: true,
        page: 0,
      });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_products_top_to", e);
    }
  });

  bot.action("lk_products_top_vp", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, {
        productsTopMode: "vp",
        productsTopActive: true,
        page: 0,
      });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_products_top_vp", e);
    }
  });

  bot.action("lk_products_top_qty", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, {
        productsTopMode: "qty",
        productsTopActive: true,
        page: 0,
      });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_products_top_qty", e);
    }
  });

  bot.action("lk_products_top_reset", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setSt(ctx.from.id, { productsTopActive: false, page: 0 });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_products_top_reset", e);
    }
  });

  bot.action("lk_reports_format_set_analysis2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;
      setSt(ctx.from.id, { format: "analysis2", page: 0, formatUi: null });

      await saveFormatSetting(user.id, "analysis2");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_analysis2", e);
    }
  });

  bot.action("lk_reports_format_set_time", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      // по умолчанию: режим 1/3 (ТО/чеки)
      setSt(ctx.from.id, {
        format: "time",
        timeMode: 0,
        page: 0,
        formatUi: null,
      });
      await saveFormatSetting(user.id, "time");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_time", e);
    }
  });

  bot.action("lk_reports_format_set_weekday", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      // по умолчанию: режим 1/3 (бар ТО)
      setSt(ctx.from.id, {
        format: "weekday",
        weekdayMode: 0,
        page: 0,
        formatUi: null,
      });
      await saveFormatSetting(user.id, "weekday");
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_format_set_weekday", e);
    }
  });

  bot.action("weekday:mode_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const st = getSt(ctx.from.id) || {};
      const cur = Number.isInteger(st.weekdayMode) ? st.weekdayMode : 0;
      const next = (cur + 1) % 3;
      setSt(ctx.from.id, { weekdayMode: next });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("weekday:mode_toggle", e);
    }
  });

  bot.action(/^weekday:sort:(to|vp|checks)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const [, key] = ctx.match;
      setSt(ctx.from.id, { weekdaySortKey: key, weekdaySortActive: true });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("weekday:sort", e);
    }
  });

  bot.action("time:mode_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const st = getSt(ctx.from.id) || {};
      const cur = Number.isInteger(st.timeMode) ? st.timeMode : 0;
      const next = (cur + 1) % 3;
      setSt(ctx.from.id, { timeMode: next });
      await showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("time:mode_toggle", e);
    }
  });

  bot.action("time:chart", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const st = getSt(ctx.from.id) || {};

      // собираем filters так же, как в showReportsList
      const filters = { ...(st.filters || {}) };
      if (st.onlyMyShifts) filters.workerIds = [user.id];
      if (st.periodFrom) filters.dateFrom = st.periodFrom;
      if (st.periodTo) filters.dateTo = st.periodTo;

      // длительность периода (в днях) — как у тебя для timeTotalDays
      let days = 1;
      try {
        const fromIso = String(st.periodFrom || filters.dateFrom || "");
        const toIso = String(st.periodTo || filters.dateTo || "");
        const fromD = parsePgDateToDate(fromIso);
        const toD = parsePgDateToDate(toIso);
        if (fromD && toD) {
          const ms = toD.getTime() - fromD.getTime();
          days = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)) + 1);
        }
      } catch (_) {}

      // грузим данные по часам (как в формате "time")
      const rows = await loadCashTimeByHour({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        pointIds:
          Array.isArray(filters.pointIds) && filters.pointIds.length
            ? filters.pointIds
            : null,
        weekdays:
          Array.isArray(filters.weekdays) && filters.weekdays.length
            ? filters.weekdays
            : null,
      });

      // строим массив 0..23 -> средний ТО за день
      const byHour = new Map();
      for (const r of rows || []) {
        const h = Number(r.hour);
        if (!Number.isFinite(h)) continue;
        byHour.set(h, Number(r.sales_total) || 0);
      }
      const labels = Array.from({ length: 24 }, (_, h) => String(h));
      const data = Array.from(
        { length: 24 },
        (_, h) => Math.round(((byHour.get(h) || 0) / days) * 100) / 100,
      );

      // QuickChart (картинка)
      const chartCfg = {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "ТО (ср./день)",
              data,
            },
          ],
        },
        options: {
          legend: { display: false },
          title: { display: true, text: "По часам и дням недели" },
          scales: {
            yAxes: [{ ticks: { beginAtZero: true } }],
          },
        },
      };

      const chartUrl =
        "https://quickchart.io/chart" +
        "?c=" +
        encodeURIComponent(JSON.stringify(chartCfg)) +
        "&w=900&h=320&devicePixelRatio=2";

      await ctx.replyWithPhoto(
        { url: chartUrl },
        { caption: "📊 ТО по часам (среднее за день)" },
      );
    } catch (e) {
      logError("time:chart", e);
    }
  });

  bot.action("lk_reports_nav_no_prev", async (ctx) => {
    try {
      await toast(ctx, "Предыдущей страницы нет");
    } catch (e) {
      logError("lk_reports_nav_no_prev", e);
    }
  });

  bot.action("lk_reports_nav_no_next", async (ctx) => {
    try {
      await toast(ctx, "Следующей страницы нет");
    } catch (e) {
      logError("lk_reports_nav_no_next", e);
    }
  });

  // Pagination (used in list/delete/edit pick). Just increments page and re-render current view.
  bot.action("lk_reports_more", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      if (!st.hasMore) return toast(ctx, "Следующей страницы нет.");

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

  // ───────────────────────────────────────────────────────────
  // Analysis2: 2 страницы таблицы + сортировки + фильтр 👤
  // ───────────────────────────────────────────────────────────
  bot.action("analysis2:page_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      if ((st.format || defaultFormatFor(user)) !== "analysis2") return;

      const cur = Number.isInteger(st.analysis2Page) ? st.analysis2Page : 0;
      setSt(ctx.from.id, { analysis2Page: Math.max(0, cur - 1) });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("analysis2_page_prev", e);
    }
  });

  bot.action("analysis2:page_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      if ((st.format || defaultFormatFor(user)) !== "analysis2") return;

      const cur = Number.isInteger(st.analysis2Page) ? st.analysis2Page : 0;
      setSt(ctx.from.id, { analysis2Page: Math.min(1, cur + 1) });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("analysis2_page_next", e);
    }
  });

  bot.action(/^analysis2:sort:(to|vp|np|avg|checks)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const key = String(ctx.match[1]);
      const st = getSt(ctx.from.id) || {};
      if ((st.format || defaultFormatFor(user)) !== "analysis2") return;

      const page = Number.isInteger(st.analysis2Page) ? st.analysis2Page : 0;
      if (page === 1) setSt(ctx.from.id, { analysis2SortKey1: key });
      else setSt(ctx.from.id, { analysis2SortKey0: key });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("analysis2_sort", e);
    }
  });

  bot.action("analysis2:toggle_user", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      if ((st.format || defaultFormatFor(user)) !== "analysis2") return;

      const todayStr = fmtPgDate(todayLocalDate());
      const isToday =
        String(st.periodFrom) === todayStr && String(st.periodTo) === todayStr;
      if (!isToday) {
        await toast(ctx, "👤 доступно только на 'сегодня'");
        return;
      }

      setSt(ctx.from.id, {
        analysis2OnlyOpened: !Boolean(st.analysis2OnlyOpened),
      });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("analysis2_toggle_user", e);
    }
  });

  bot.action("lk_reports_only_my_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // Только для обычного пользователя

      const st = getSt(ctx.from.id) || {};
      const next = !Boolean(st.onlyMyShifts);
      setSt(ctx.from.id, { onlyMyShifts: next, page: 0 });

      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_only_my_toggle", e);
    }
  });

  bot.action("lk_reports_less", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id) || {};
      const cur = Number.isInteger(st.page) ? st.page : 0;
      if (cur <= 0) return toast(ctx, "Предыдущей страницы нет.");

      const prevPage = cur - 1;
      setSt(ctx.from.id, { page: prevPage });

      // Decide by last view (аналогично как в lk_reports_more, если хочешь)
      if (st.view === "delete")
        return showDeleteMode(ctx, user, { edit: true });
      if (st.view === "edit_pick")
        return showEditPick(ctx, user, { edit: true });
      return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_less", e);
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

  // ───── STUBS (temporarily) ─────
  bot.action("lk_reports_filter_workers", async (ctx) => {
    await ctx
      .answerCbQuery("В разработке.", { show_alert: true })
      .catch(() => {});
  });

  bot.action("lk_reports_filter_elements", async (ctx) => {
    await ctx
      .answerCbQuery("В разработке.", { show_alert: true })
      .catch(() => {});
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
        { edit: true },
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
        Array.isArray(filters.pointIds) ? filters.pointIds : [],
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
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      setSt(ctx.from.id, { view: "settings", page: 0, await: null });
      await showSettings(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_settings", e);
    }
  });

  bot.action("lk_reports_delete_mode", async (ctx) => {
    await ctx
      .answerCbQuery("В разработке.", { show_alert: true })
      .catch(() => {});
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
          [user.id, selected],
        );
      } catch (e) {
        // если миграции нет — не ломаемся, но сообщаем
        await toast(
          ctx,
          "Нет полей deleted_at/deleted_by_user_id (нужна миграция).",
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

  registerReportEdit(bot, {
    ensureUser,
    logError,
    showReportsList,
  });

  registerReportDelete(bot, {
    ensureUser,
    logError,
    showReportsList,
  });

  registerReportMore(bot, { ensureUser, logError, showReportsList });

  registerReportImports(bot, {
    ensureUser,
    toast,
    alert,
    setSt,
    getSt,
    logError,
    showReportsList,
  });
}

module.exports = { registerReports };
