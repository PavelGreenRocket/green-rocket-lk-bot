// src/ai/answerer.js
const { GIGA_MODEL } = require("./client");

function buildSystemPromptWithTheory(theoryTitle, theoryContent) {
  const base =
    "Ты — помощник сотрудника Green Rocket.\n" +
    "Отвечай по-деловому, структурно, коротко и понятно.\n" +
    "Используй ТОЛЬКО информацию из блока ТЕОРИЯ, если она релевантна.\n" +
    "Если информации недостаточно — честно скажи и задай 1 уточняющий вопрос.\n" +
    "Не выдумывай фактов.\n";

  if (!theoryContent) return base;

  return (
    base +
    "\n=== ТЕОРИЯ ===\n" +
    `Тема: ${theoryTitle || "без названия"}\n` +
    `${theoryContent}\n` +
    "=== КОНЕЦ ТЕОРИИ ==="
  );
}

async function generateAnswer(giga, question, systemPrompt) {
  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.2,
  });

  return (resp?.choices?.[0]?.message?.content || "").trim();
}

async function simplifyAnswer(giga, question, currentAnswer) {
  const sys =
    "Ты помощник. Переформулируй ответ проще:\n" +
    "— Используй короткие фразы.\n" +
    "— Добавь простую ассоциацию/пример.\n" +
    "— Не добавляй фактов, которых не было в исходном ответе.\n" +
    "— Не пиши лишних вступлений.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          "ВОПРОС:\n" +
          question +
          "\n\nТЕКУЩИЙ ОТВЕТ:\n" +
          currentAnswer +
          "\n\nСДЕЛАЙ ПРОЩЕ:",
      },
    ],
    temperature: 0.3,
  });

  return (resp?.choices?.[0]?.message?.content || "").trim();
}

module.exports = {
  buildSystemPromptWithTheory,
  generateAnswer,
  simplifyAnswer,
};
