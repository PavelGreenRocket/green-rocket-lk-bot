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

function renderProductsTable(rows, { limit = 50 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const top = list.slice(0, Math.max(1, limit));

  const nameW = Math.min(
    28,
    Math.max(5, ...top.map((r) => escapePipes(truncateName(r.item_name)).length))
  );
  const qtyW = Math.min(8, Math.max(4, ...top.map((r) => String(r.qty).length)));
  const toW = Math.min(
    10,
    Math.max(2, ...top.map((r) => fmtMoney(r.to_sum).length))
  );

  const lines = [];
  lines.push(
    `${padRight("товар", nameW)} | ${padLeft("кол-во", qtyW)} | ${padLeft(
      "ТО",
      toW
    )} | ВП`
  );

  for (const r of top) {
    const name = escapePipes(truncateName(r.item_name));
    const qty = r.qty;
    const to = fmtMoney(r.to_sum);
    lines.push(
      `${padRight(name, nameW)} | ${padLeft(qty, qtyW)} | ${padLeft(to, toW)} | —`
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
    `
  );
  const s = schemaRes.rows?.[0] || {};
  const useCash = Boolean(s.items_has_cash_doc_id);
  const docsIdCol = s.docs_has_id ? "id" : s.docs_has_doc_id ? "doc_id" : null;
  const useDocId = !useCash && Boolean(s.items_has_doc_id) && Boolean(docsIdCol);

  return { useCash, useDocId, docsIdCol };
}

function buildWhere({ dateFrom, dateTo, pointIds }) {
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

  return { params, where };
}

async function loadProductsPage({ dateFrom, dateTo, pointIds, limit = 30, offset = 0 }) {
  const { useCash, useDocId, docsIdCol } = await detectPosSchema();
  const { params, where } = buildWhere({ dateFrom, dateTo, pointIds });

  const joinSql = useDocId
    ? `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.${docsIdCol} = i.doc_id`
    : `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.cash_doc_id = i.cash_doc_id`;

  const sql = `
    SELECT
      i.item_name AS item_name,
      SUM(i.quantity)::numeric AS qty,
      SUM(i.pos_sum)::numeric AS to_sum
    FROM pos_sales_items i
    ${joinSql}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY i.item_name
    ORDER BY to_sum DESC NULLS LAST, qty DESC NULLS LAST, item_name ASC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  const res = await pool.query(sql, [...params, Math.max(1, limit), Math.max(0, offset)]);
  return res.rows || [];
}

async function countProducts({ dateFrom, dateTo, pointIds }) {
  const { useDocId, docsIdCol } = await detectPosSchema();
  const { params, where } = buildWhere({ dateFrom, dateTo, pointIds });

  const joinSql = useDocId
    ? `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.${docsIdCol} = i.doc_id`
    : `JOIN pos_sales_docs d ON d.trade_point_id = i.trade_point_id AND d.cash_doc_id = i.cash_doc_id`;

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
    [pointIds]
  );
  return res.rows || [];
}

module.exports = {
  loadProductsPage,
  countProducts,
  renderProductsTable,
  getPointsWithNoPosBinding,
};
