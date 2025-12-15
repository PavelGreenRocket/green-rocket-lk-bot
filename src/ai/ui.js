const { Markup } = require("telegraf");

function buildAskKeyboard() {
  return Markup.keyboard([["🔮 Задать вопрос ИИ"]])
    .resize()
    .oneTime();
}

function buildAnswerKeyboard({ logId, hasContact }) {
  const buttons = [
    Markup.button.callback("🧠 Объяснить проще", `ai_simplify_${logId}`),
  ];

  if (hasContact) {
    buttons.push(
      Markup.button.callback(
        "📞 Связаться с администратором",
        `ai_contact_${logId}`
      )
    );
  }

  return Markup.inlineKeyboard(buttons);
}

module.exports = {
  buildAskKeyboard,
  buildAnswerKeyboard,
};
