function buildSystemPromptWithTheory({ theoryTitle, theoryContent }) {
  return `
Ты — ИИ-ассистент для сотрудников компании.
Отвечай строго по рабочим вопросам.

Используй ТОЛЬКО информацию из теории ниже.
Если информации недостаточно — прямо скажи об этом.

ТЕМА:
${theoryTitle}

ТЕОРИЯ:
${theoryContent}
`.trim();
}

module.exports = {
  buildSystemPromptWithTheory,
};
