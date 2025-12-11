// src/utils/messageManagement.js

const { messageHistory } = require("../flow/menuMap");

// Записывает в историю ID только что отправленного сообщения
function recordMessage(ctx, messageId) {
  const userId = ctx.from.id;
  const hist = messageHistory.get(userId) || [];
  hist.push(messageId);
  messageHistory.set(userId, hist);
}

// Удаляет последние `count` сообщений (кроме тех, что в exclude)
async function clearLastMessages(ctx, count, exclude = []) {
  const userId = ctx.from.id;
  const hist = messageHistory.get(userId) || [];

  const toDelete = hist
    .slice(-count)
    .filter((msgId) => !exclude.includes(msgId));

  const newHist = hist.filter((msgId) => !toDelete.includes(msgId));
  messageHistory.set(userId, newHist);

  for (const msgId of toDelete) {
    try {
      await ctx.deleteMessage(msgId);
    } catch (e) {
      // сообщение могло быть уже удалено — игнорируем ошибку
    }
  }
}

// На будущее — "шаг назад"
async function goBack(ctx, count = 1) {
  await clearLastMessages(ctx, count);
}

module.exports = {
  recordMessage,
  clearLastMessages,
  goBack,
};
