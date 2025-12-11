const { deliver } = require("../utils/renderHelpers");

function registerQuestions(bot, ensureUser, logError) {
  bot.action("lk_ai_question", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = user.staff_status || "worker";

      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\n" +
              "Задавать вопросы через ИИ можно будет после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
        return;
      }

      // стажёр / работник — пока заглушка
      await deliver(
        ctx,
        {
          text:
            "Раздел «Задать вопрос ИИ» пока в разработке.\n" +
            "Позже здесь можно будет задавать вопросы по работе, стандартам и процедурам.",
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
      logError("lk_ai_question", err);
    }
  });
}

module.exports = { registerQuestions };
