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
  ssl: false, // Если локальная база — оставляем false
});

pool
  .connect()
  .then(() => console.log("📦 PostgreSQL подключён"))
  .catch((err) => {
    console.error("❌ Ошибка подключения к PostgreSQL:", err);
    process.exit(1);
  });

module.exports = pool;
