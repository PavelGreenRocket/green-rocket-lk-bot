// src/ai/classifier.js
const { GIGA_MODEL } = require("./client");

/**
 * Выбрать наиболее подходящую теоретическую тему (id) под вопрос.
 * Возвращает number|null
 */
async function pickTheoryTopicId(giga, question, topics) {
  if (!topics || topics.length === 0) return null;

  const list = topics
    .map((t) => `${t.id}: ${t.title}`)
    .join("\n")
    .slice(0, 6000);

  const sys =
    "Ты классификатор. Выбери наиболее подходящую тему по вопросу.\n" +
    "Отвечай строго числом — id темы из списка. Если ни одна не подходит, ответь 0.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nТЕМЫ:\n${list}\n\nID:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();
  const id = Number(raw.replace(/[^\d]/g, ""));
  if (!Number.isFinite(id) || id <= 0) return null;

  const exists = topics.some((t) => Number(t.id) === id);
  return exists ? id : null;
}

/**
 * Базовый fallback-классификатор: WORK / OFFTOPIC
 */
async function detectOfftopic(giga, question) {
  const sys =
    "Ты классификатор. Определи: вопрос относится к рабочим вопросам Green Rocket или нет.\n" +
    "Рабочие: смены, стандарты, обязанности, регламенты, оборудование, качество, график, зарплата, точки, клиенты.\n" +
    "Нерабочие: развлечения, личная жизнь, политика, игры, мемы, вообще не про работу.\n" +
    "Ответь строго одним словом: WORK или OFFTOPIC.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: question },
    ],
    temperature: 0,
  });

  const text = (resp?.choices?.[0]?.message?.content || "")
    .trim()
    .toUpperCase();
  return text.includes("OFFTOPIC");
}

/**
 * Классификация "подозрение не по работе" с опорой на бан-лист.
 * Возвращает { suspected:boolean, confidence:number|null, matchedBanId:number|null }
 */
async function detectOfftopicFromBans(giga, question, bans) {
  if (!bans || bans.length === 0) {
    const suspected = await detectOfftopic(giga, question);
    return { suspected, confidence: null, matchedBanId: null };
  }

  const list = bans
    .map((b) => `${b.id}: ${b.title} — ${b.description}`)
    .join("\n")
    .slice(0, 9000);

  const sys =
    "Ты классификатор. Определи, относится ли вопрос к НЕрабочим темам из списка запретов.\n" +
    "Ответь строго JSON без текста вокруг:\n" +
    '{"suspected":true|false,"ban_id":number|null,"confidence":number}\n' +
    "confidence от 0 до 1.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nЗАПРЕТЫ:\n${list}\n\nJSON:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();

  try {
    const obj = JSON.parse(raw);

    const suspected = !!obj.suspected;
    const confidence =
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : null;

    const banId = Number(obj.ban_id);
    const matchedBanId =
      Number.isFinite(banId) &&
      banId > 0 &&
      bans.some((b) => Number(b.id) === banId)
        ? banId
        : null;

    return { suspected, confidence, matchedBanId };
  } catch {
    const suspected = await detectOfftopic(giga, question);
    return { suspected, confidence: null, matchedBanId: null };
  }
}

/**
 * Выбрать контактную тему (id) под вопрос. Возвращает number|null.
 */
async function pickContactTopicId(giga, question, topics) {
  if (!topics || topics.length === 0) return null;

  const list = topics
    .map((t) => `${t.id}: ${t.title} — ${t.description}`)
    .join("\n")
    .slice(0, 9000);

  const sys =
    "Ты классификатор. Определи, нужна ли помощь человека по контактным темам.\n" +
    "Если вопрос подходит под одну из тем — верни id темы.\n" +
    "Если не подходит ни под одну — верни 0.\n" +
    "Ответ строго числом.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nТЕМЫ:\n${list}\n\nID:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();
  const id = Number(raw.replace(/[^\d]/g, ""));
  if (!Number.isFinite(id) || id <= 0) return null;

  const exists = topics.some((t) => Number(t.id) === id);
  return exists ? id : null;
}

module.exports = {
  pickTheoryTopicId,
  detectOfftopic,
  detectOfftopicFromBans,
  pickContactTopicId,
};
