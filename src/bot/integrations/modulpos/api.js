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

  if (!res.ok) {
    const details =
      data?.message || data?.error || (typeof text === "string" ? text : "");
    throw new Error(`ModulPOS HTTP ${res.status}: ${details || url}`);
  }

  return data;
}

module.exports = {
  fetchAPI,
};
