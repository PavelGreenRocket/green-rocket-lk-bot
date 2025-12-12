// src/utils/renderHelpers.js

/**
 * Универсальная функция отправки/обновления сообщений.
 *
 * Использование:
 *   await deliver(ctx, { text, extra }, { edit: true });
 *   await deliver(ctx, { text, extra }, { edit: false });
 *
 * extra — это обычный объект с reply_markup, parse_mode и т.п.
 */
async function deliver(ctx, payload, options = {}) {
  const { text, extra } = payload || {};
  const { edit = false } = options;

  if (!ctx) {
    throw new Error("deliver: ctx is required");
  }

  // Если нужно отредактировать существующее сообщение (обычно с callback_query)
  if (edit && (ctx.callbackQuery || ctx.updateType === "callback_query")) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (err) {
      const desc =
        err?.response?.description || err?.description || String(err || "");

      // ✅ Нормальная ситуация: пытаемся "перерисовать" то же самое
      if (desc.includes("message is not modified")) {
        return; // ничего не делаем и НЕ шлём новое сообщение
      }

      // Частые ошибки: "message can't be edited"
      console.error("deliver: edit failed, fallback to reply", err);
      try {
        return await ctx.reply(text, extra);
      } catch (err2) {
        console.error("deliver: reply after failed edit also failed", err2);
      }
    }
    return;
  }

  // Обычный режим — просто отправляем новое сообщение
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    console.error("deliver: reply failed", err);
  }
}

module.exports = {
  deliver,
};
