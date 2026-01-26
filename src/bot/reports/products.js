// src/bot/reports/products.js
const pool = require("../../db/pool");

function fmtMoney(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  // без ₽, как в остальной аналитике
  return new Intl.NumberFormat("ru-RU").format(n);
}

function padRight(s, w) {
  const str = String(s ?? "");
  if (str.length >= w) return str;
  return str + " ".repeat(w - str.length);
}

function padLeft(s, w) {
  const str = String(s ?? "");
  if (str.length >= w) return str;
  return " ".repeat(w - str.length) + str;
}

function escapePipes(s) {
  // чтобы таблица не ломалась, если в названии товара есть "|"
  return String(s ?? "").replace(/\|/g, "/");
}

function truncateName(name, max = 20) {
  const s = String(name ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toIntQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function renderProductsTable(rows, { limit = 50 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const top = list.slice(0, Math.max(1, limit));

  const nameW = Math.min(
    28,
    Math.max(
      5,
      ...top.map((r) => escapePipes(truncateName(r.item_name)).length),
    ),
  );
  const qtyW = Math.min(
    8,
    Math.max(4, ...top.map((r) => String(toIntQty(r.qty)).length)),
  );
  const toW = Math.min(
    10,
    Math.max(2, ...top.map((r) => fmtMoney(r.to_sum).length)),
  );

  const lines = [];
  lines.push(
    `${padRight("товар", nameW)} | ${padLeft("кол-во", qtyW)} | ${padLeft(
      "ТО",
      toW,
    )} | ВП`,
  );

  for (const r of top) {
    const name = escapePipes(truncateName(r.item_name));
    const qty = toIntQty(r.qty);
    const to = fmtMoney(r.to_sum);
    lines.push(
      `${padRight(name, nameW)} | ${padLeft(qty, qtyW)} | ${padLeft(
        to,
        toW,
      )} | —`,
    );
  }

  if (list.length > top.length) {
    lines.push("");
    lines.push(`…и ещё позиций: ${list.length - top.length}`);
  }

  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

async function detectPosSchema() {
  // Схема может быть двух типов:
  // A) pos_sales_items.cash_doc_id -> pos_sales_docs.cash_doc_id
  // B) pos_sales_items.doc_id -> pos_sales_docs.id/doc_id
  const schemaRes = await pool.query(
    `
      SELECT
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_items' AND column_name='cash_doc_id'
        ) AS items_has_cash_doc_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_items' AND column_name='doc_id'
        ) AS items_has_doc_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_docs' AND column_name='id'
        ) AS docs_has_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_docs' AND column_name='doc_id'
        ) AS docs_has_doc_id
    `,
  );
  const s = schemaRes.rows?.[0] || {};
  const useCash = Boolean(s.items_has_cash_doc_id);
  const docsIdCol = s.docs_has_id ? "id" : s.docs_has_doc_id ? "doc_id" : null;
  const useDocId =
    !useCash && Boolean(s.items_has_doc_id) && Boolean(docsIdCol);

  return { useCash, useDocId, docsIdCol };
}

function buildWhere({ dateFrom, dateTo, pointIds, weekdays }) {
  const params = [];
  const where = [];

  if (dateFrom) {
    params.push(dateFrom);
    where.push(`d.begin_datetime::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`d.begin_datetime::date <= $${params.length}::date`);
  }
  if (Array.isArray(pointIds) && pointIds.length) {
    params.push(pointIds);
    where.push(`d.trade_point_id = ANY($${params.length}::int[])`);
  }
  if (Array.isArray(weekdays) && weekdays.length) {
    // weekdays: 1..7 (пн..вс)
    params.push(weekdays);
    where.push(
      `EXTRACT(ISODOW FROM d.begin_datetime)::int = ANY($${params.length}::int[])`,
    );
  }

  return { params, where };
}

function buildWhereLocalNsk({ dateFrom, dateTo, pointIds, weekdays }) {
  const params = [];
  const where = [];

  const ts = `(d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk')`;

  if (dateFrom) {
    params.push(dateFrom);
    where.push(`${ts}::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`${ts}::date <= $${params.length}::date`);
  }
  if (Array.isArray(pointIds) && pointIds.length) {
    params.push(pointIds);
    where.push(`d.trade_point_id = ANY($${params.length}::int[])`);
  }
  if (Array.isArray(weekdays) && weekdays.length) {
    // weekdays: 1..7 (пн..вс)
    params.push(weekdays);
    where.push(
      `EXTRACT(ISODOW FROM ${ts})::int = ANY($${params.length}::int[])`,
    );
  }

  return { params, where };
}

function buildJoinSql(schema) {
  return schema.useDocId
    ? `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.${schema.docsIdCol} = i.doc_id`
    : `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.cash_doc_id = i.cash_doc_id`;
}

function buildDocKeyExpr(schema) {
  // выражение для COUNT DISTINCT
  if (schema.useDocId) return `i.doc_id`;
  return `i.cash_doc_id`;
}

async function loadProductsPage({
  dateFrom,
  dateTo,
  pointIds,
  weekdays,
  limit = 30,
  offset = 0,
  sort = "to", // to | qty | vp
}) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhere({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });

  const joinSql = buildJoinSql(schema);

  const orderSql =
    sort === "qty"
      ? `ORDER BY qty DESC NULLS LAST, to_sum DESC NULLS LAST, item_name ASC`
      : sort === "vp"
        ? `ORDER BY 1` // ВП пока нет, но оставляем каркас; сортируем по ТО как дефолт
        : `ORDER BY to_sum DESC NULLS LAST, qty DESC NULLS LAST, item_name ASC`;

  const sql = `
    SELECT
      i.item_name AS item_name,
      SUM(i.quantity)::numeric AS qty,
      SUM(i.pos_sum)::numeric AS to_sum
    FROM pos_sales_items i
    ${joinSql}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY i.item_name
    ${orderSql}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  const res = await pool.query(sql, [
    ...params,
    Math.max(1, limit),
    Math.max(0, offset),
  ]);
  return res.rows || [];
}

async function countProducts({ dateFrom, dateTo, pointIds, weekdays }) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhere({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);

  const sql = `
    SELECT COUNT(*)::int AS cnt
    FROM (
      SELECT i.item_name
      FROM pos_sales_items i
      ${joinSql}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY i.item_name
    ) t
  `;

  const res = await pool.query(sql, params);
  return res.rows?.[0]?.cnt ?? 0;
}

async function hasAnyProducts({ dateFrom, dateTo, pointIds, weekdays }) {
  const cnt = await countProducts({ dateFrom, dateTo, pointIds, weekdays });
  return (Number(cnt) || 0) > 0;
}

async function loadCashSummary({ dateFrom, dateTo, pointIds, weekdays }) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhere({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);
  const docKey = buildDocKeyExpr(schema);

  const sql = `
    SELECT
      COALESCE(SUM(i.pos_sum), 0)::numeric AS sales_total,
      COUNT(DISTINCT ${docKey})::int AS checks_count,
      COUNT(DISTINCT d.begin_datetime::date)::int AS active_days
    FROM pos_sales_items i
    ${joinSql}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
  `;

  const res = await pool.query(sql, params);
  const r = res.rows?.[0] || {};
  return {
    sales_total: Number(r.sales_total) || 0,
    checks_count: Number(r.checks_count) || 0,
    active_days: Number(r.active_days) || 0,
  };
}

async function loadCashAnalysisRows({ dateFrom, dateTo, pointIds, weekdays }) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhere({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);
  const docKey = buildDocKeyExpr(schema);

  const sql = `
    SELECT
      d.begin_datetime::date AS day,
      d.trade_point_id,
      tp.title AS trade_point_title,
      COALESCE(SUM(i.pos_sum), 0)::numeric AS sales_total,
      COUNT(DISTINCT ${docKey})::int AS checks_count
    FROM pos_sales_items i
    ${joinSql}
    LEFT JOIN trade_points tp ON tp.id = d.trade_point_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY d.begin_datetime::date, d.trade_point_id, tp.title
    ORDER BY d.begin_datetime::date DESC, tp.title NULLS LAST, d.trade_point_id
  `;

  const res = await pool.query(sql, params);
  // Приводим к форме, которую ожидают renderAnalysisTable/renderAnalysisTable2
  return (res.rows || []).map((r) => ({
    opened_at: r.day,
    trade_point_id: r.trade_point_id,
    trade_point_title: r.trade_point_title,
    sales_total: r.sales_total,
    checks_count: r.checks_count,
  }));
}

// ───────────────────────────────────────────────────────────────
// Анализ "по времени" (по часам) — источник истины: POS
// Возвращаем суммы/счётчики за период. На UI при необходимости
// делим на totalDays выбранного периода.
// ───────────────────────────────────────────────────────────────

async function loadCashTimeByHour({ dateFrom, dateTo, pointIds, weekdays }) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhere({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);
  const docKey = buildDocKeyExpr(schema);

  const sql = `
    SELECT
      EXTRACT(HOUR FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int AS hour,
      COALESCE(SUM(i.pos_sum), 0)::numeric AS sales_total,
      COUNT(DISTINCT ${docKey})::int AS checks_count
    FROM pos_sales_items i
    ${joinSql}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY EXTRACT(HOUR FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int

    ORDER BY hour ASC
  `;

  const res = await pool.query(sql, params);
  return res.rows || [];
}

async function loadCashTimeByHourByPoint({
  dateFrom,
  dateTo,
  pointIds,
  weekdays,
}) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhereLocalNsk({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);
  const docKey = buildDocKeyExpr(schema);

  const sql = `
    SELECT
      EXTRACT(HOUR FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int AS hour,
      d.trade_point_id,
      tp.title AS trade_point_title,
      COALESCE(SUM(i.pos_sum), 0)::numeric AS sales_total,
      COUNT(DISTINCT ${docKey})::int AS checks_count
    FROM pos_sales_items i
    ${joinSql}
    LEFT JOIN trade_points tp ON tp.id = d.trade_point_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY EXTRACT(HOUR FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int, d.trade_point_id, tp.title
    ORDER BY hour ASC, tp.title NULLS LAST, d.trade_point_id
  `;

  const res = await pool.query(sql, params);
  return res.rows || [];
}


// ───────────────────────────────────────────────────────────────
// Анализ "по дням недели" — источник истины: POS (Novosibirsk TZ)
// Возвращаем суммы/счётчики за период. На UI при необходимости
// делим на totalDays выбранного периода.
// ───────────────────────────────────────────────────────────────
async function loadCashWeekdayAgg({ dateFrom, dateTo, pointIds, weekdays }) {
  const schema = await detectPosSchema();
  const { params, where } = buildWhereLocalNsk({
    dateFrom,
    dateTo,
    pointIds,
    weekdays,
  });
  const joinSql = buildJoinSql(schema);
  const docKey = buildDocKeyExpr(schema);

  const sql = `
    SELECT
      EXTRACT(ISODOW FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int AS iso_dow,
      COALESCE(SUM(i.pos_sum), 0)::numeric AS sales_total,
      COUNT(DISTINCT ${docKey})::int AS checks_count
    FROM pos_sales_items i
    ${joinSql}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY EXTRACT(ISODOW FROM (d.begin_datetime AT TIME ZONE 'Asia/Novosibirsk'))::int
    ORDER BY iso_dow ASC
  `;

  const res = await pool.query(sql, params);
  return res.rows || [];
}

async function getPointsWithNoPosBinding(pointIds) {
  if (!Array.isArray(pointIds) || !pointIds.length) return [];
  const res = await pool.query(
    `
      SELECT id, title
      FROM trade_points
      WHERE id = ANY($1::int[])
        AND (pos_retail_point_uuid IS NULL)
      ORDER BY title NULLS LAST, id
    `,
    [pointIds],
  );
  return res.rows || [];
}

module.exports = {
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
};
