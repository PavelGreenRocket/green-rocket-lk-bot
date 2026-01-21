const { fetchAPI } = require("./api");

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function aggPositions(inventPositions) {
  const map = new Map();

  for (const p of inventPositions || []) {
    const name = String(p?.name || "").trim();
    if (!name) continue;
    const qty = toNumber(p?.quantity);
    const sum = toNumber(p?.posSum);
    const discount = toNumber(p?.discount);

    const cur = map.get(name) || { qty: 0, pos_sum: 0, discount: 0 };
    cur.qty += qty;
    cur.pos_sum += sum;
    cur.discount += discount;
    map.set(name, cur);
  }

  return [...map.entries()].map(([item_name, v]) => ({
    item_name,
    quantity: v.qty,
    pos_sum: v.pos_sum,
    discount: v.discount,
  }));
}

async function ensurePosSchema(pool) {
  // чтобы не падать в рантайме, если SQL ещё не применили
  // (не делаем миграции автоматически, просто проверяем наличие таблиц)
  const res = await pool.query(
    `
      SELECT to_regclass('public.pos_sales_docs') AS docs,
             to_regclass('public.pos_sales_items') AS items
    `
  );
  const r = res.rows?.[0] || {};
  return Boolean(r.docs) && Boolean(r.items);
}

async function detectPosSchema(pool) {
  // Определяем, как устроены таблицы в текущей БД.
  // В ранних версиях pos_sales_items могла содержать doc_id (FK на pos_sales_docs.id)
  // вместо cash_doc_id.
  const res = await pool.query(
    `
      SELECT
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_docs' AND column_name='id'
        ) AS docs_has_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_docs' AND column_name='doc_id'
        ) AS docs_has_doc_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_items' AND column_name='doc_id'
        ) AS items_has_doc_id,
        COALESCE((
          SELECT a.attnotnull
          FROM pg_attribute a
          WHERE a.attrelid = 'public.pos_sales_items'::regclass
            AND a.attname = 'doc_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
          LIMIT 1
        ), false) AS items_doc_id_not_null,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_items' AND column_name='cash_doc_id'
        ) AS items_has_cash_doc_id,
        EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pos_sales_docs' AND column_name='retail_point_uuid'
        ) AS docs_has_retail_point_uuid
    `
  );
  const r = res.rows?.[0] || {};
  const docsIdCol = r.docs_has_id ? "id" : r.docs_has_doc_id ? "doc_id" : null;
  return {
    docs_id_col: docsIdCol,
    items_has_doc_id: Boolean(r.items_has_doc_id),
    items_doc_id_not_null: Boolean(r.items_doc_id_not_null),
    items_has_cash_doc_id: Boolean(r.items_has_cash_doc_id),
    docs_has_retail_point_uuid: Boolean(r.docs_has_retail_point_uuid),
  };
}

async function loadBoundPoints(pool, tradePointIds) {
  const res = await pool.query(
    `
      SELECT id, title, pos_retail_point_uuid
      FROM trade_points
      WHERE 1=1
        ${Array.isArray(tradePointIds) && tradePointIds.length ? "AND id = ANY($1::int[])" : ""}
      ORDER BY title NULLS LAST, id
    `
    ,
    Array.isArray(tradePointIds) && tradePointIds.length ? [tradePointIds] : []
  );
  const all = res.rows || [];
  const bound = all.filter((x) => x.pos_retail_point_uuid);
  const noBinding = all
    .filter((x) => !x.pos_retail_point_uuid)
    .map((x) => ({ id: x.id, title: x.title || `#${x.id}` }));

  return { bound, noBinding };
}

async function getRecentShifts(retailPointUuid, days) {
  return fetchAPI(
    `/retail-point/${retailPointUuid}/get-recent-shifts?days=${encodeURIComponent(
      String(days)
    )}`
  );
}

async function getCashDocs(retailPointUuid, shiftDocId) {
  return fetchAPI(`/retail-point/${retailPointUuid}/shift/${shiftDocId}/cashdoc`);
}

async function getCashDocInfo(retailPointUuid, shiftDocId, cashDocId) {
  return fetchAPI(
    `/retail-point/${retailPointUuid}/shift/${shiftDocId}/cashdoc/${cashDocId}`
  );
}

async function upsertDoc(pool, doc, schema) {
  const cols = [
    "trade_point_id",
    ...(schema?.docs_has_retail_point_uuid ? ["retail_point_uuid"] : []),
    "shift_doc_id",
    "cash_doc_id",
    "begin_datetime",
    "cashier_name",
    "raw",
  ];

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

  const values = [
    doc.trade_point_id,
    ...(schema?.docs_has_retail_point_uuid ? [doc.retail_point_uuid] : []),
    doc.shift_doc_id,
    doc.cash_doc_id,
    doc.begin_datetime,
    doc.cashier_name,
    JSON.stringify(doc.raw || {}),
  ];

  // Если есть колонка id/doc_id, удобно вернуть её для связывания items через doc_id.
  const returning = schema?.docs_id_col ? ` RETURNING ${schema.docs_id_col}` : "";

  const q = `
    INSERT INTO pos_sales_docs (${cols.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT (trade_point_id, cash_doc_id)
    DO UPDATE SET
      begin_datetime = EXCLUDED.begin_datetime,
      cashier_name = EXCLUDED.cashier_name,
      raw = EXCLUDED.raw
    ${returning}
  `;

  const res = await pool.query(q, values);
  let docDbId = schema?.docs_id_col ? res.rows?.[0]?.[schema.docs_id_col] ?? null : null;

  // Фолбэк: если RETURNING не сработал/не вернул строку (напр. из-за особенностей ON CONFLICT в старой схеме),
  // попробуем найти документ по уникальной паре (trade_point_id, cash_doc_id).
  if (schema?.docs_id_col && !docDbId) {
    const sel = await pool.query(
      `SELECT ${schema.docs_id_col} FROM pos_sales_docs WHERE trade_point_id=$1 AND cash_doc_id=$2 LIMIT 1`,
      [doc.trade_point_id, doc.cash_doc_id]
    );
    docDbId = sel.rows?.[0]?.[schema.docs_id_col] ?? null;
  }

  return { rowCount: res.rowCount || 0, docDbId };
}

async function upsertItems(pool, items, schema) {
  if (!items?.length) return 0;
  const mustUseDocId = Boolean(schema?.items_has_doc_id) && Boolean(schema?.items_doc_id_not_null);
  const hasCashDocId = Boolean(schema?.items_has_cash_doc_id);

  // Если doc_id есть и он NOT NULL — обязаны передавать его всегда.
  // В некоторых БД есть и doc_id, и cash_doc_id, но doc_id при этом NOT NULL.
  const useDocId = mustUseDocId;

  // Вариант A: схема с cash_doc_id (+ возможно doc_id)
  // Если doc_id обязателен, добавляем его в INSERT.
  const qCash = useDocId
    ? `
      INSERT INTO pos_sales_items (
        trade_point_id,
        doc_id,
        cash_doc_id,
        item_name,
        quantity,
        pos_sum,
        discount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (trade_point_id, cash_doc_id, item_name)
      DO UPDATE SET
        doc_id = EXCLUDED.doc_id,
        quantity = EXCLUDED.quantity,
        pos_sum = EXCLUDED.pos_sum,
        discount = EXCLUDED.discount
    `
    : `
      INSERT INTO pos_sales_items (
        trade_point_id,
        cash_doc_id,
        item_name,
        quantity,
        pos_sum,
        discount
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (trade_point_id, cash_doc_id, item_name)
      DO UPDATE SET
        quantity = EXCLUDED.quantity,
        pos_sum = EXCLUDED.pos_sum,
        discount = EXCLUDED.discount
    `;

  // Вариант B: старая схема (doc_id)
  // Не предполагаем наличие уникального индекса — делаем DO NOTHING, чтобы не падать.
  const qDoc = `
      INSERT INTO pos_sales_items (
        trade_point_id,
        doc_id,
        item_name,
        quantity,
        pos_sum,
        discount
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
  `;

  let count = 0;
  for (const it of items) {
    let res;
    if (hasCashDocId) {
      // схема с cash_doc_id
      res = await pool.query(qCash, useDocId
        ? [
            it.trade_point_id,
            it.doc_id,
            it.cash_doc_id,
            it.item_name,
            it.quantity,
            it.pos_sum,
            it.discount,
          ]
        : [
            it.trade_point_id,
            it.cash_doc_id,
            it.item_name,
            it.quantity,
            it.pos_sum,
            it.discount,
          ]
      );
    } else {
      // старая схема без cash_doc_id
      res = await pool.query(qDoc, [
        it.trade_point_id,
        it.doc_id,
        it.item_name,
        it.quantity,
        it.pos_sum,
        it.discount,
      ]);
    }
    count += res.rowCount || 0;
  }

  return count;
}

async function importModulposSales({ pool, days = 1, tradePointIds = null }) {
  const schemaOk = await ensurePosSchema(pool);
  if (!schemaOk) {
    return {
      pointsProcessed: 0,
      docsInserted: 0,
      itemsInserted: 0,
      pointsNoBinding: [],
      pointsErrors: [
        {
          title: "DB",
          error:
            "Таблицы pos_sales_docs/pos_sales_items не найдены. Примените SQL-миграцию ModulPOS.",
        },
      ],
    };
  }

  const schema = await detectPosSchema(pool);

  const { bound, noBinding } = await loadBoundPoints(pool, tradePointIds);

  let docsInserted = 0;
  let itemsInserted = 0;
  const pointsErrors = [];

  for (const tp of bound) {
    const title = tp.title || `#${tp.id}`;
    const retailPointUuid = String(tp.pos_retail_point_uuid || "").trim();

    if (!isUuid(retailPointUuid)) {
      pointsErrors.push({
        title,
        error: `Некорректный UUID кассы: ${retailPointUuid}`,
      });
      continue;
    }

    try {
      // Для ускорения (особенно для "сегодня" на каждом заходе):
      // заранее подгружаем уже импортированные cash_doc_id за период,
      // чтобы не тратить время на getCashDocInfo для уже известных чеков.
      let existingCashDocIds = new Set();
      try {
        // begin_datetime должен быть в pos_sales_docs (миграция ModulPOS)
        const backDays = Math.max(0, Number(days) - 1);
        const ex = await pool.query(
          `
            SELECT cash_doc_id
            FROM pos_sales_docs
            WHERE trade_point_id = $1
              AND begin_datetime >= (CURRENT_DATE - $2::int)
          `,
          [tp.id, backDays]
        );
        existingCashDocIds = new Set(
          (ex.rows || []).map((r) => String(r.cash_doc_id || "")).filter(Boolean)
        );
      } catch (_) {
        // если схема ещё не на 100% совпадает — просто не оптимизируем
        existingCashDocIds = new Set();
      }

      const shifts = (await getRecentShifts(retailPointUuid, days)) || [];
      for (const shift of shifts) {
        const shiftDocId = shift?.id;
        if (!shiftDocId) continue;

        const cashDocs = (await getCashDocs(retailPointUuid, shiftDocId)) || [];
        for (const cd of cashDocs) {
          const cashDocId = cd?.id;
          if (!cashDocId) continue;

          // Уже есть в БД за выбранный период — пропускаем API-детализацию
          if (existingCashDocIds.has(String(cashDocId))) continue;

          const info = await getCashDocInfo(retailPointUuid, shiftDocId, cashDocId);

          const docRes = await upsertDoc(
            pool,
            {
            trade_point_id: tp.id,
            retail_point_uuid: retailPointUuid,
            shift_doc_id: String(shiftDocId),
            cash_doc_id: String(cashDocId),
            begin_datetime: info?.beginDateTime || null,
            cashier_name: info?.cashier?.name || null,
            raw: info,
            },
            schema
          );

          docsInserted += docRes.rowCount || 0;

          // помечаем как уже обработанный
          existingCashDocIds.add(String(cashDocId));

          const agg = aggPositions(info?.inventPositions);

          const useDocId = Boolean(schema.items_has_doc_id) && !schema.items_has_cash_doc_id;
          const docIdRequired = Boolean(schema.items_has_doc_id) && Boolean(schema.items_doc_id_not_null);
          if (docIdRequired && !docRes.docDbId) {
            throw new Error(
              "Схема pos_sales_items требует doc_id, но не удалось получить идентификатор документа из pos_sales_docs (id/doc_id)."
            );
          }

          const items = agg.map((x) => ({
            trade_point_id: tp.id,
            cash_doc_id: String(cashDocId),
            doc_id: docRes.docDbId,
            item_name: x.item_name,
            quantity: x.quantity,
            pos_sum: x.pos_sum,
            discount: x.discount,
          }));

          const itemsCnt = (await upsertItems(pool, items, schema)) || 0;
          itemsInserted += itemsCnt;
        }
      }
    } catch (e) {
      pointsErrors.push({ title, error: String(e?.message || e) });
    }
  }

  return {
    pointsProcessed: bound.length,
    docsInserted,
    itemsInserted,
    pointsNoBinding: noBinding,
    pointsErrors,
  };
}

module.exports = {
  importModulposSales,
};
