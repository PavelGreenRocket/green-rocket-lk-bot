require("dotenv").config();
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("❌ DATABASE_URL не найден в .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("🔥 PG pool error (idle client):", err);
});

(async () => {
  try {
    await pool.query("select 1");
    console.log("📦 PostgreSQL подключён");
  } catch (err) {
    console.error("❌ Ошибка подключения к PostgreSQL:", err);
    process.exit(1);
  }
})();

module.exports = pool;
