const { Markup } = require("telegraf");
const { importModulposSales } = require("../../integrations/modulpos/importer");
const poolDefault = require("../../../db/pool");
const { deliver: deliverDefault } = require("../../../utils/renderHelpers");

function isAdminLocal(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function registerCashImport(bot, deps) {
  const {
    ensureUser,
    toast,
    logError,
  } = deps;

  const isAdmin = typeof deps?.isAdmin === "function" ? deps.isAdmin : isAdminLocal;
  const deliver = typeof deps?.deliver === "function" ? deps.deliver : deliverDefault;
  const pool = deps?.pool || poolDefault;

  bot.action("lk_reports_import_cash_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const text =
        `<b>Импорт из кассы (ModulPOS)</b>\n\n` +
        `Выберите период импорта.\n` +
        `Импорт идемпотентный: повторный запуск не создаст дублей.`;

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📅 Сегодня",
            "lk_reports_import_cash_run:1"
          ),
          Markup.button.callback(
            "🗓 7 дней",
            "lk_reports_import_cash_run:7"
          ),
        ],
        [
          Markup.button.callback(
            "🗓 31 день",
            "lk_reports_import_cash_run:31"
          ),
        ],
        [Markup.button.callback("⬅️ Назад", "lk_reports_import_menu")],
      ]);

      return deliver(
        ctx,
        { text, extra: { parse_mode: "HTML", ...kb } },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_import_cash_menu", e);
    }
  });

  bot.action(/^lk_reports_import_cash_run:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const days = Number(ctx.match[1]);

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      // быстрый экран, чтобы пользователь видел, что работа пошла
      await deliver(
        ctx,
        {
          text:
            `<b>Импорт из кассы</b>\n\n` +
            `Период: <b>${days}</b> дн.\n` +
            `Загружаю данные…`,
          extra: { parse_mode: "HTML" },
        },
        { edit: true }
      );

      const result = await importModulposSales({
        pool,
        days,
      });

      const lines = [];
      lines.push(`<b>Импорт завершён</b>`);
      lines.push(`Период: <b>${days}</b> дн.`);
      lines.push("");
      lines.push(`Точек обработано: <b>${result.pointsProcessed}</b>`);
      lines.push(`Документов (чеков): <b>${result.docsInserted}</b>`);
      lines.push(`Позиции: <b>${result.itemsInserted}</b>`);

      if (result.pointsNoBinding?.length) {
        lines.push("");
        lines.push(
          `Без привязки кассы: ${result.pointsNoBinding
            .map((x) => x.title)
            .join(", ")}`
        );
      }

      if (result.pointsErrors?.length) {
        lines.push("");
        lines.push(`<b>Ошибки по точкам:</b>`);
        for (const e of result.pointsErrors.slice(0, 8)) {
          lines.push(`• ${e.title}: ${e.error}`);
        }
        if (result.pointsErrors.length > 8) {
          lines.push(`…ещё: ${result.pointsErrors.length - 8}`);
        }
      }

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Повторить", `lk_reports_import_cash_run:${days}`)],
        [Markup.button.callback("📦 К отчётам", "lk_reports_settings")],
        [Markup.button.callback("⬅️ Назад", "lk_reports_import_cash_menu")],
      ]);

      return deliver(
        ctx,
        { text: lines.join("\n"), extra: { parse_mode: "HTML", ...kb } },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_import_cash_run", e);
      return toast(ctx, "Ошибка импорта кассы.");
    }
  });
}

module.exports = { registerCashImport };
