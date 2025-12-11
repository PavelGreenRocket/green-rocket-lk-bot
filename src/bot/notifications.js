const { deliver } = require("../utils/renderHelpers");

function registerNotifications(bot, ensureUser, logError) {
  bot.action("lk_notifications", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await deliver(
        ctx,
        {
          text:
            "Раздел уведомлений ЛК.\n" +
            "Позже сюда перенесём всю логику из бота «Академия бариста».\n\n" +
            "Пока что это заглушка.",
          extra: {
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ В меню", callback_data: "lk_main_menu" }],
              ],
            },
          },
        },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notifications", err);
    }
  });
}

module.exports = { registerNotifications };
