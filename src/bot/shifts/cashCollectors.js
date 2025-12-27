// src/bot/shifts/cashCollectors.js

/**
 * Единая логика "кто может инкассировать" для конкретной точки.
 * Источник прав: trade_point_responsibles (event_type='cash_collection_access', is_active=true)
 */

async function loadCashCollectorsPage(
  pool,
  tradePointId,
  page = 0,
  pageSize = 10
) {
  const p = Number.isFinite(Number(page)) ? Number(page) : 0;
  const limit = Number.isFinite(Number(pageSize)) ? Number(pageSize) : 10;
  const offset = Math.max(0, p) * limit;

  const r = await pool.query(
    `
      SELECT u.id, u.full_name, u.username, u.work_phone
      FROM trade_point_responsibles tpr
      JOIN users u ON u.id = tpr.user_id
      WHERE tpr.trade_point_id = $1
        AND tpr.event_type = 'cash_collection_access'
        AND tpr.is_active = true
      ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
      LIMIT $2 OFFSET $3
    `,
    [Number(tradePointId), limit + 1, offset]
  );

  return { rows: r.rows.slice(0, limit), hasMore: r.rows.length > limit };
}

async function isCashCollectorForPoint(pool, tradePointId, userId) {
  const r = await pool.query(
    `
      SELECT 1
      FROM trade_point_responsibles
      WHERE trade_point_id = $1
        AND event_type = 'cash_collection_access'
        AND user_id = $2
        AND is_active = true
      LIMIT 1
    `,
    [Number(tradePointId), Number(userId)]
  );
  return r.rows.length > 0;
}

async function hasAnyCashCollectors(pool, tradePointId) {
  const r = await pool.query(
    `
      SELECT 1
      FROM trade_point_responsibles
      WHERE trade_point_id = $1
        AND event_type = 'cash_collection_access'
        AND is_active = true
      LIMIT 1
    `,
    [Number(tradePointId)]
  );
  return r.rows.length > 0;
}

module.exports = {
  loadCashCollectorsPage,
  isCashCollectorForPoint,
  hasAnyCashCollectors,
};
