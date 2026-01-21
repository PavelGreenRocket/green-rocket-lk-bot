const { fetchAPI } = require("./api");

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s || "").trim()
  );
}

function parseDateMaybe(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isShiftOpen(shift) {
  if (!shift) return false;

  const statusRaw = String(shift.status || shift.shiftStatus || "").toUpperCase();
  if (statusRaw) {
    if (statusRaw.includes("CLOSE")) return false;
    if (statusRaw.includes("OPEN") || statusRaw.includes("ACTIVE")) return true;
  }

  const closedFlags = [
    shift.isClosed,
    shift.closed,
    shift.is_close,
    shift.is_close_shift,
  ];
  if (closedFlags.some((x) => x === true)) return false;

  const closeDt =
    parseDateMaybe(shift.closeDateTime) ||
    parseDateMaybe(shift.closedAt) ||
    parseDateMaybe(shift.closeDatetime) ||
    parseDateMaybe(shift.endDateTime) ||
    parseDateMaybe(shift.endDatetime) ||
    parseDateMaybe(shift.end_date_time);

  // если есть close — считаем закрытой
  if (closeDt) return false;

  // если есть open, а close нет — считаем открытой
  const openDt =
    parseDateMaybe(shift.openDateTime) ||
    parseDateMaybe(shift.openedAt) ||
    parseDateMaybe(shift.openDatetime) ||
    parseDateMaybe(shift.beginDateTime) ||
    parseDateMaybe(shift.startDateTime);

  return Boolean(openDt);
}

function pickCashierNameFromShift(shift) {
  const candidates = [
    shift?.cashier?.name,
    shift?.employee?.name,
    shift?.user?.name,
    shift?.cashierName,
    shift?.employeeName,
    shift?.userName,
  ];
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (s) return s;
  }
  return null;
}

async function getRecentShifts(retailPointUuid, days) {
  return fetchAPI(
    `/retail-point/${retailPointUuid}/get-recent-shifts?days=${encodeURIComponent(
      String(days)
    )}`
  );
}

/**
 * Возвращает Map(trade_point_id => { isOpen: boolean, cashierName: string|null })
 *
 * Для статуса берём последнюю смену (по openDateTime/createdAt), и определяем открыта ли.
 */
async function loadModulposShiftStatusByPoints({ pool, tradePointIds = null, days = 2 }) {
  const res = await pool.query(
    `
      SELECT id, title, pos_retail_point_uuid
      FROM trade_points
      WHERE pos_retail_point_uuid IS NOT NULL
        ${Array.isArray(tradePointIds) && tradePointIds.length ? "AND id = ANY($1::int[])" : ""}
      ORDER BY title NULLS LAST, id
    `,
    Array.isArray(tradePointIds) && tradePointIds.length ? [tradePointIds] : []
  );

  const out = new Map();

  for (const tp of res.rows || []) {
    const uuid = String(tp.pos_retail_point_uuid || "").trim();
    if (!isUuid(uuid)) {
      out.set(Number(tp.id), { isOpen: false, cashierName: null });
      continue;
    }

    try {
      const shifts = (await getRecentShifts(uuid, days)) || [];

      // Сортируем по наиболее “новой” дате
      const sorted = shifts
        .slice()
        .map((s) => {
          const openDt =
            parseDateMaybe(s.openDateTime) ||
            parseDateMaybe(s.openedAt) ||
            parseDateMaybe(s.beginDateTime) ||
            parseDateMaybe(s.createdAt);
          return { s, t: openDt ? openDt.getTime() : 0 };
        })
        .sort((a, b) => (b.t || 0) - (a.t || 0));

      const last = sorted[0]?.s || null;
      const isOpen = isShiftOpen(last);
      const cashierName = isOpen ? pickCashierNameFromShift(last) : null;
      out.set(Number(tp.id), { isOpen, cashierName });
    } catch (_) {
      out.set(Number(tp.id), { isOpen: false, cashierName: null });
    }
  }

  return out;
}

module.exports = {
  loadModulposShiftStatusByPoints,
};
