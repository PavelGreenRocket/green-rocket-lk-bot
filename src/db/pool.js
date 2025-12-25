// src/db/pool.js
require("dotenv").config();
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL не найден в .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: false, // если облачная БД — см. блок ниже
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// Ошибки idle-клиентов (в пуле)
pool.on("error", (err) => {
  console.error("🔥 PG pool error (idle client):", err);
});

// 🔥 ВАЖНО: ошибки “взятых” клиентов (checked-out client) иначе валят Node
const _connect = pool.connect.bind(pool);
pool.connect = async (...args) => {
  const client = await _connect(...args);
  client.on("error", (err) => {
    console.error("🔥 PG client error (checked-out):", err);
  });
  return client;
};

// smoke-test
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
