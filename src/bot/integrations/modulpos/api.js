const { Buffer } = require("buffer");

const BASE_URL = process.env.MODULPOS_BASE_URL || "https://service.modulpos.ru/api/v1";

function getAuthHeader() {
  const username = process.env.MODULPOS_USERNAME || process.env.USERNAME;
  const password = process.env.MODULPOS_PASSWORD || process.env.PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Не заданы MODULPOS_USERNAME/MODULPOS_PASSWORD (или USERNAME/PASSWORD) в .env"
    );
  }

  const credentials = `${username}:${password}`;
  const base64 = Buffer.from(credentials).toString("base64");
  return `Basic ${base64}`;
}

async function fetchAPI(endpoint) {
  const url = `${BASE_URL}${endpoint}`;

  // ModulPOS иногда отдаёт 429 (лимиты) или 5xx. Делаем безопасные ретраи.
  const maxAttempts = Number(process.env.MODULPOS_HTTP_RETRIES || 5);
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: getAuthHeader(),
        },
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        // ignore json parse error
      }

      if (res.ok) return data;

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      const details =
        data?.message || data?.error || (typeof text === "string" ? text : "");

      // если не ретраебл — сразу ошибка
      if (!retryable) {
        throw new Error(`ModulPOS HTTP ${res.status}: ${details || url}`);
      }

      // retry-after (в секундах) — если есть
      const ra = res.headers?.get?.("retry-after");
      const retryAfterSec = ra ? Number(ra) : NaN;
      const baseDelayMs = Number.isFinite(retryAfterSec)
        ? Math.max(250, retryAfterSec * 1000)
        : Math.min(8000, 500 * Math.pow(2, attempt - 1));

      await new Promise((r) => setTimeout(r, baseDelayMs));
      continue;
    } catch (e) {
      lastErr = e;
      // сетевые ошибки — тоже пробуем ретрай
      const delayMs = Math.min(8000, 500 * Math.pow(2, attempt - 1));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }

  throw lastErr || new Error(`ModulPOS request failed: ${url}`);
}

module.exports = {
  fetchAPI,
};
