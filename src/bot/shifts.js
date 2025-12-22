function registerShifts(bot, ensureUser, logError) {
  // router: кандидатов блокируем, всех остальных пропускаем в рабочие модули (flow.js / close.js)
  bot.action("lk_shift_toggle", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      const staffStatus = user.staff_status || "worker";
      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\nОткрыть смену можно будет после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
        return;
      }

      // ✅ важно: не глушим! передаём дальше в flow.js / close.js
      return next();
    } catch (err) {
      logError("lk_shift_toggle_router", err);
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
    }
  });
}
