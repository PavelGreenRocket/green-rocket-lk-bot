const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

function registerAdminMailings(bot, ensureUser, logError) {
  bot.action("admin_mailings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text = "📢 *Рассылки*\n\nВыберите действие:";
      const keyboard = Markup.inlineKeyboard([
        [{ text: "🆕 Новое уведомление", callback_data: "lk_notif_admin_new" }],
        [
          {
            text: "📊 Статус последнего",
            callback_data: "lk_notif_admin_last_status",
          },
        ],
        [
          {
            text: "📜 История уведомлений",
            callback_data: "lk_notif_admin_history",
          },
        ],
        [{ text: "⬅️ Назад", callback_data: "lk_admin_menu" }],
      ]);

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("admin_mailings", err);
    }
  });
}

module.exports = { registerAdminMailings };
