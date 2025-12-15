const GigaChat = require("gigachat").default;
const { Agent } = require("node:https");

const GIGA_MODEL = process.env.GIGACHAT_MODEL || "GigaChat";
const GIGA_SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

const httpsAgent =
  process.env.GIGACHAT_ALLOW_SELF_SIGNED === "1"
    ? new Agent({ rejectUnauthorized: false })
    : undefined;

function initGiga() {
  const credentials = process.env.GIGACHAT_CREDENTIALS;
  if (!credentials) {
    throw new Error("GIGACHAT_CREDENTIALS is not set");
  }

  return new GigaChat({
    timeout: 60,
    model: GIGA_MODEL,
    credentials,
    scope: GIGA_SCOPE,
    ...(httpsAgent ? { httpsAgent } : {}),
  });
}

module.exports = {
  initGiga,
  GIGA_MODEL,
  GIGA_SCOPE,
};
