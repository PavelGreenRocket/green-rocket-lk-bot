// src/bot/shifts/close.js
const pool = require("../../db/pool");
const { toast } = require("../../utils/toast");
const { startOrContinueClosing } = require("./closingFlow");

async function getActiveShift(userId) {
  const res = await pool.query(
    `
    SELECT id, status, trade_point_id
    FROM shifts
    WHERE user_id=$1
      AND opened_at::date = CURRENT_DATE
      AND status IN ('opening_in_progress','opened','closing_in_progress')
    ORDER BY opened_at DESC
    LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

function registerShiftClose(bot, ensureUser, logError) {
  // Временный роутер на lk_shift_toggle:
  // если смена есть -> запускаем закрытие
  // если смены нет -> next() (открытие обработает flow.js)
  bot.action("lk_shift_toggle", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      const active = await getActiveShift(user.id);

      if (active) {
        await ctx.answerCbQuery().catch(() => {});
        await startOrContinueClosing(ctx, user); // ✅ запуск/продолжение закрытия
        return;
      }

      return next();
    } catch (err) {
      logError("lk_shift_toggle_close_router", err);
      await toast(ctx, "Ошибка").catch(() => {});
    }
  });
}

module.exports = { registerShiftClose };
