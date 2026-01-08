// src/bot/shifts/shiftOpeningControlWatcher.js
const pool = require("../../db/pool");
const { insertNotificationAndFanout } = require("../notifications");

/**
 * Парсим "HH:MM-HH:MM"
 */
function parseRange(range) {
  const s = String(range || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);

  if ([sh, sm, eh, em].some((x) => Number.isNaN(x))) return null;
  if (sh < 0 || sh > 23 || eh < 0 || eh > 23) return null;
  if (sm < 0 || sm > 59 || em < 0 || em > 59) return null;

  return { sh, sm, eh, em };
}

/**
 * Строим текущий рабочий интервал (start/end) с учётом пересечения полуночи.
 * Если end <= start -> интервал через полночь.
 *
 * Пример 08:00-02:00:
 *  - в 00:12: start=вчера 08:00, end=сегодня 02:00
 *  - в 10:00: start=сегодня 08:00, end=завтра 02:00
 */
function buildWorkInterval(now, parsed) {
  const { sh, sm, eh, em } = parsed;

  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setHours(sh, sm, 0, 0);

  const end = new Date(now);
  end.setSeconds(0, 0);
  end.setHours(eh, em, 0, 0);

  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const crossesMidnight = endMinutes <= startMinutes;

  if (!crossesMidnight) {
    // внутри одного календарного дня
    return { start, end, crossesMidnight: false };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (nowMinutes < endMinutes) {
    // после полуночи и до end -> start был вчера
    start.setDate(start.getDate() - 1);
  } else {
    // до полуночи после start -> end будет завтра
    end.setDate(end.getDate() + 1);
  }

  return { start, end, crossesMidnight: true };
}

/**
 * Выбираем строку времени работы (будни/выходные) по дню intervalStart.
 * 0=Sun, 6=Sat => выходные
 */
function pickRangeByDate(tp, dateObj) {
  const day = dateObj.getDay(); // 0..6
  const isWeekend = day === 0 || day === 6;

  const w = String(tp.work_hours_weekdays || "").trim();
  const e = String(tp.work_hours_weekends || "").trim();

  if (w || e) return isWeekend ? e : w;

  return String(tp.work_hours || "").trim();
}

function fmtWorkHoursForText(range) {
  const s = String(range || "").trim();
  if (!s) return "—";
  // "08:00-20:00" -> "с 08:00 до 20:00"
  const m = s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!m) return s;
  return `с ${m[1]} до ${m[2]}`;
}

function shouldNotifyByRepeat(lastNotifiedAt, repeatMinutes) {
  if (!lastNotifiedAt) return true;

  const last = new Date(lastNotifiedAt).getTime();
  if (Number.isNaN(last)) return true;

  const rm = Math.max(1, Number(repeatMinutes || 10));
  const deltaMs = Date.now() - last;
  return deltaMs >= rm * 60 * 1000;
}

/**
 * Глобальная настройка (trade_point_id IS NULL).
 * Если её нет — дефолт: enabled=true, threshold=1, repeat=10
 */
async function loadGlobalControl() {
  const r = await pool.query(
    `SELECT * FROM shift_opening_control
     WHERE trade_point_id IS NULL
     ORDER BY id DESC
     LIMIT 1`
  );
  return (
    r.rows[0] || {
      enabled: true,
      threshold_minutes: 1,
      repeat_minutes: 10,
      last_notified_at: null,
      muted_until: null,
      muted_by_user_id: null,
      muted_at: null,
    }
  );
}

async function loadPointControlsMap() {
  const r = await pool.query(
    `SELECT * FROM shift_opening_control
     WHERE trade_point_id IS NOT NULL`
  );
  const map = new Map();
  for (const row of r.rows) map.set(Number(row.trade_point_id), row);
  return map;
}

async function loadTradePoints() {
  const r = await pool.query(
    `SELECT id, title, is_active, work_hours_weekdays, work_hours_weekends, work_hours
     FROM trade_points
     WHERE is_active = true
     ORDER BY id`
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    title: x.title || `#${x.id}`,
    work_hours_weekdays: x.work_hours_weekdays || null,
    work_hours_weekends: x.work_hours_weekends || null,
    work_hours: x.work_hours || null,
  }));
}

/**
 * Первая смена, открытая внутри интервала.
 */
async function firstShiftOpenedInInterval(tpId, fromTs, toTs) {
  const r = await pool.query(
    `
    SELECT MIN(opened_at) AS opened_at
    FROM shifts
    WHERE trade_point_id = $1
      AND opened_at >= $2
      AND opened_at <  $3
    `,
    [tpId, fromTs, toTs]
  );
  return r.rows[0]?.opened_at || null;
}

/**
 * Ответственные для SOC: точечные + глобальные
 */
async function loadRecipients(tpId) {
  const r = await pool.query(
    `
    SELECT DISTINCT user_id
    FROM responsible_assignments
    WHERE kind = 'shift_opening_control'
      AND is_active = true
      AND (trade_point_id = $1 OR trade_point_id IS NULL)
    `,
    [tpId]
  );
  return r.rows.map((x) => Number(x.user_id)).filter(Boolean);
}

/**
 * Чтобы можно было хранить last_notified_at / muted_until по конкретной точке,
 * мы обновляем строку этой точки. Если её нет — создаём.
 *
 * ВНИМАНИЕ:
 * Это фактически создаёт override-строку для точки.
 * Если у тебя важно, чтобы глобальные изменения автоматически применялись ко всем точкам,
 * то правильнее вынести состояние (last_notified_at/muted_*) в отдельную таблицу state.
 */
async function ensurePointRowExists(tpId, base) {
  const r = await pool.query(
    `SELECT id FROM shift_opening_control WHERE trade_point_id=$1 LIMIT 1`,
    [tpId]
  );
  if (r.rows[0]?.id) return;

  await pool.query(
    `INSERT INTO shift_opening_control (trade_point_id, enabled, threshold_minutes, repeat_minutes, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (trade_point_id) DO NOTHING`,
    [
      tpId,
      base?.enabled ?? true,
      Number(base?.threshold_minutes ?? 1),
      Number(base?.repeat_minutes ?? 10),
    ]
  );
}

async function markNotified(tpId) {
  await pool.query(
    `UPDATE shift_opening_control
     SET last_notified_at = NOW()
     WHERE trade_point_id = $1`,
    [tpId]
  );
}

async function checkShiftOpeningControlOnce(log = console.error) {
  const now = new Date();

  const global = await loadGlobalControl();
  const overrides = await loadPointControlsMap();
  const points = await loadTradePoints();

  for (const tp of points) {
    const cfg = overrides.get(tp.id) ||
      global || { enabled: true, threshold_minutes: 1, repeat_minutes: 10 };

    if (!cfg.enabled) continue;

    // 1) берем range по "дню начала интервала"
    // сначала пробуем "как будто сегодня" => строим интервал, потом уже уточняем day по start
    // но range зависит от day, поэтому делаем в 2 шага:
    const roughRange = pickRangeByDate(tp, now);
    const parsed0 = parseRange(roughRange);
    // если roughRange пустой/невалидный — пробуем старое поле и т.п. (already handled in pickRangeByDate)
    if (!parsed0) continue;

    // строим интервал "черновой", чтобы понять, пересекает ли полночь и где start
    const roughInterval = buildWorkInterval(now, parsed0);

    // теперь окончательно выбираем расписание по дню intervalStart
    const finalRange = pickRangeByDate(tp, roughInterval.start);
    const parsed = parseRange(finalRange);
    if (!parsed) continue;

    const { start: intervalStart, end: intervalEnd } = buildWorkInterval(
      now,
      parsed
    );

    // 2) дедлайн открытия: intervalStart + threshold
    const threshold = Number(cfg.threshold_minutes ?? 1);
    const deadline = new Date(intervalStart);
    deadline.setMinutes(deadline.getMinutes() + threshold);

    if (now < deadline) continue;

    // 3) если кто-то нажал "решаю проблему" — молчим до muted_until
    if (cfg.muted_until) {
      const mu = new Date(cfg.muted_until);
      if (!Number.isNaN(mu.getTime()) && now < mu) continue;
    }

    // 4) повторяем по repeat_minutes
    const repeatMinutes = Number(cfg.repeat_minutes ?? 10);
    if (!shouldNotifyByRepeat(cfg.last_notified_at, repeatMinutes)) continue;

    // 5) есть ли смена, открытая в интервале
    const openedAt = await firstShiftOpenedInInterval(
      tp.id,
      intervalStart,
      intervalEnd
    );

    // если открыли вовремя — не шлем
    if (openedAt) {
      const opened = new Date(openedAt);
      if (opened <= deadline) continue;
    }

    // 6) получатели
    const recipients = await loadRecipients(tp.id);

    // если получателей нет — всё равно фиксируем last_notified_at, чтобы не крутить по кругу
    // (но только если есть/создаём point row)
    await ensurePointRowExists(tp.id, cfg);
    await markNotified(tp.id);

    if (!recipients.length) continue;

    const whText = fmtWorkHoursForText(finalRange);

    const text =
      `🚀 Контроль открытия смены\n\n` +
      `📍 Точка: ${tp.title}\n` +
      `🕒 Время работы: ${whText}\n` +
      `❗️Смена не была открыта вовремя.\n\n` +
      `[[soc:tp=${tp.id}]]`;

    try {
      await insertNotificationAndFanout({
        createdBy: null, // системное
        text,
        recipientUserIds: recipients,
      });
    } catch (e) {
      log("[shift_opening_control] notify error", e);
    }
  }
}

function startShiftOpeningControlWatcher({
  intervalMs = 60_000,
  logError = console.error,
} = {}) {
  setTimeout(() => {
    checkShiftOpeningControlOnce(logError).catch((e) =>
      logError("soc_once", e)
    );
  }, 5_000);

  return setInterval(() => {
    checkShiftOpeningControlOnce(logError).catch((e) =>
      logError("soc_once", e)
    );
  }, intervalMs);
}

module.exports = {
  startShiftOpeningControlWatcher,
  checkShiftOpeningControlOnce,
};
