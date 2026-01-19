/**
 * ModulPOS cron sync runner
 *
 * Запускай из корня проекта:
 *   node src/bot/integrations/modulpos/cronSync.js
 *
 * ENV:
 *   MODULPOS_SYNC_DAYS=1           сколько дней назад синхронизировать (по умолчанию 1)
 *   MODULPOS_SYNC_LOCK_KEY=771001  ключ advisory lock (по умолчанию 771001)
 *
 * Требуется:
 *   MODULPOS_USERNAME/MODULPOS_PASSWORD (или USERNAME/PASSWORD)
 */

require("dotenv").config();

const pool = require("../../../db/pool");
const { importModulposSales } = require("./importer");

async function withAdvisoryLock(pool, lockKey, fn) {
  const client = await pool.connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
      lockKey,
    ]);
    const ok = Boolean(got?.rows?.[0]?.ok);
    if (!ok) {
      console.log(
        `[modulposSync] skipped: advisory lock ${lockKey} is already held (another sync is running)`
      );
      return { skipped: true };
    }

    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {
        /* ignore */
      });
    }
  } finally {
    client.release();
  }
}

async function main() {
  const days = Number(process.env.MODULPOS_SYNC_DAYS || 1);
  const lockKey = Number(process.env.MODULPOS_SYNC_LOCK_KEY || 771001);
  const started = new Date();

  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("MODULPOS_SYNC_DAYS должен быть положительным числом");
  }

  const res = await withAdvisoryLock(pool, lockKey, async () => {
    console.log(
      `[modulposSync] start: days=${days} at ${started.toISOString()}`
    );
    const r = await importModulposSales({ pool, days });
    console.log(
      `[modulposSync] done: points=${r.pointsProcessed}, docs=${r.docsInserted}, items=${r.itemsInserted}`
    );
    if (r.pointsErrors?.length) {
      console.log(`[modulposSync] errors (${r.pointsErrors.length}):`);
      for (const e of r.pointsErrors) {
        console.log(`- ${e.title}: ${e.error}`);
      }
    }
    if (r.pointsNoBinding?.length) {
      console.log(
        `[modulposSync] no binding: ${r.pointsNoBinding
          .map((x) => x.title)
          .join(", ")}`
      );
    }
    return r;
  });

  const ended = new Date();
  console.log(`[modulposSync] finished in ${(ended - started) / 1000}s`);
  if (res?.skipped) process.exit(0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[modulposSync] fatal: ${e?.stack || e}`);
    process.exit(1);
  });
