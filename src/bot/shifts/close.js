// src/bot/shifts/close.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast } = require("../../utils/toast");

async function closeTodayShift(userId) {
  const res = await pool.query(
    `
      UPDATE shifts
      SET status = 'closed',
          closed_at = NOW()
      WHERE id = (
        SELECT id
        FROM shifts
        WHERE user_id = $1
          AND opened_at::date = CURRENT_DATE
          AND status IN ('opening_in_progress','opened')
        ORDER BY opened_at DESC
        LIMIT 1
      )
      RETURNING id
    `,
    [userId]
  );
  return res.rows[0] || null;
}

function registerShiftClose(bot, ensureUser, logError) {
  // Временный "закрыть смену" на ту же кнопку lk_shift_toggle:
  // если смена активна — закрываем, иначе ничего не делаем (открытие обработает flow.js)
  bot.action("lk_shift_toggle", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      // Пытаемся закрыть активную смену
      const closed = await closeTodayShift(user.id);

      if (closed) {
        await toast(ctx, "Смена закрыта ✅");
        // вернём в меню (обновится клавиатура)
        await deliver(
          ctx,
          {
            text: "Смена закрыта ✅\n\nВозвращаю в меню.",
            extra: Markup.inlineKeyboard([
              [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
            ]),
          },
          { edit: true }
        );
        return;
      }

      // Если нечего закрывать — передаём управление дальше (в flow.js откроет смену)
      return next();
    } catch (err) {
      logError("lk_shift_toggle_close_temp", err);
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
      return;
    }
  });
}

module.exports = { registerShiftClose };
