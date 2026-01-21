const pool = require("../../../db/pool");
const { importModulposSales } = require("./importer");

let __workerStarted = false;

async function ensureJobsTableExists() {
  // best-effort: не мигрируем полностью, но если таблицы нет — создадим.
  // В проде лучше применять schema.sql, но это спасёт от падения.
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS pos_import_jobs (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'queued',
        requested_by_tg_id BIGINT,
        requested_period_from DATE,
        requested_period_to DATE,
        effective_period_from DATE,
        effective_period_to DATE,
        trade_point_ids INT[],
        result JSONB,
        last_error TEXT,
        notified_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS pos_import_jobs_status_created_idx
        ON pos_import_jobs (status, created_at);
      CREATE INDEX IF NOT EXISTS pos_import_jobs_notify_idx
        ON pos_import_jobs (requested_by_tg_id, status, notified_at);
    `
  );
}

function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampRangeToLast31(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return { fromIso, toIso, truncated: false, days: 1 };
  }
  // diff in days inclusive
  const ms = 24 * 60 * 60 * 1000;
  const diff = Math.floor((to - from) / ms) + 1;
  if (diff <= 31) return { fromIso, toIso, truncated: false, days: Math.max(1, diff) };

  const newFrom = new Date(to.getTime() - ms * 30);
  return { fromIso: isoDate(newFrom), toIso, truncated: true, days: 31 };
}

async function enqueuePosImportJob({
  requestedByTgId,
  periodFrom,
  periodTo,
  tradePointIds,
}) {
  await ensureJobsTableExists();

  const { fromIso, toIso, truncated, days } = clampRangeToLast31(periodFrom, periodTo);

  const res = await pool.query(
    `
      INSERT INTO pos_import_jobs (
        requested_by_tg_id,
        requested_period_from,
        requested_period_to,
        effective_period_from,
        effective_period_to,
        trade_point_ids
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      requestedByTgId || null,
      periodFrom || null,
      periodTo || null,
      fromIso || null,
      toIso || null,
      Array.isArray(tradePointIds) && tradePointIds.length ? tradePointIds : null,
    ]
  );

  return {
    id: res.rows?.[0]?.id,
    truncated,
    effectiveFrom: fromIso,
    effectiveTo: toIso,
    days,
  };
}

async function takeNextJob(client) {
  const jobRes = await client.query(
    `
      SELECT id, requested_by_tg_id, effective_period_from, effective_period_to, trade_point_ids
      FROM pos_import_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `
  );
  return jobRes.rows?.[0] || null;
}

async function processOneJob() {
  await ensureJobsTableExists();
  const client = await pool.connect();
  let jobId = null;
  try {
    await client.query("BEGIN");
    const job = await takeNextJob(client);
    if (!job) {
      await client.query("ROLLBACK");
      return false;
    }

    jobId = job.id;

    await client.query(
      `
        UPDATE pos_import_jobs
        SET status='running', started_at=now(), last_error=NULL
        WHERE id=$1
      `,
      [job.id]
    );

    await client.query("COMMIT");

    const fromIso = String(job.effective_period_from);
    const toIso = String(job.effective_period_to);
    // importer работает по days, и сам пропускает уже имеющиеся чеки.
    // days считаем как (to-from)+1, но подстраховываем.
    const ms = 24 * 60 * 60 * 1000;
    const days = Math.max(
      1,
      Math.min(
        31,
        Math.floor((new Date(toIso) - new Date(fromIso)) / ms) + 1 || 31
      )
    );

    const tradePointIds = Array.isArray(job.trade_point_ids) && job.trade_point_ids.length ? job.trade_point_ids : null;

    const result = await importModulposSales({ pool, days, tradePointIds });

    await pool.query(
      `
        UPDATE pos_import_jobs
        SET status='done', finished_at=now(), result=$2
        WHERE id=$1
      `,
      [job.id, JSON.stringify(result || {})]
    );

    return true;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    // если job был уже помечен running, фиксируем ошибку отдельным запросом
    if (jobId) {
      try {
        await pool.query(
          `
            UPDATE pos_import_jobs
            SET status='error', finished_at=now(), last_error=$2
            WHERE id=$1
          `,
          [jobId, String(e?.message || e)]
        );
      } catch (_) {
        // ignore
      }
    }
    return true; // чтобы цикл не стопорился
  } finally {
    client.release();
  }
}

function startModulposImportJobsWorker({ intervalMs = 2500 } = {}) {
  if (__workerStarted) return;
  __workerStarted = true;

  // цикл без await (чтобы не блокировать запуск), но внутри — последовательная обработка
  setInterval(async () => {
    try {
      // обработаем максимум 1 job за тик, чтобы не перегружать
      await processOneJob();
    } catch (_) {
      // ignore
    }
  }, intervalMs);
}

module.exports = {
  enqueuePosImportJob,
  startModulposImportJobsWorker,
  clampRangeToLast31,
};
