const { registerTextImport } = require("./text");
const { Markup } = require("telegraf");

function registerReportImports(bot, deps) {
  const {
    ensureUser,
    isAdmin,
    toast,
    deliver,
    showReportsSettings,
    setSt,
    getSt,
    logError,
  } = deps;

  bot.action("lk_reports_import_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { importUi: { mode: "menu" } });

      const text =
        `<b>Загрузка отчётов</b>\n\n` +
        `Выберите способ загрузки:\n` +
        `1) Google Sheets (скоро)\n` +
        `2) Текстом (готово)\n` +
        `3) Из кассы (скоро)`;

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📄 Google Sheets (скоро)",
            "lk_reports_import_sheets_stub"
          ),
        ],
        [
          Markup.button.callback(
            "📝 Загрузка текстом",
            "lk_reports_import_text"
          ),
        ],
        [
          Markup.button.callback(
            "🏪 Из кассы (скоро)",
            "lk_reports_import_cash_stub"
          ),
        ],
        [Markup.button.callback("⬅️ Назад", "lk_reports_settings")],
      ]);

      return deliver(
        ctx,
        {
          text,
          extra: { parse_mode: "HTML", ...kb },
        },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_import_menu", e);
    }
  });

  bot.action("lk_reports_import_sheets_stub", async (ctx) => {
    await ctx.answerCbQuery("Скоро 🙂", { show_alert: false }).catch(() => {});
  });

  bot.action("lk_reports_import_cash_stub", async (ctx) => {
    await ctx.answerCbQuery("Скоро 🙂", { show_alert: false }).catch(() => {});
  });

  // экран инструкции для текстовой загрузки
  bot.action("lk_reports_import_text", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, { importUi: { mode: "await_text" } });

      const aiPrompt = `ТЫ — конвертер в строгий формат для Telegram-бота. 
Вход: произвольный текст со сменами (может быть кривой, неполный).
Выход: строгие блоки смен, разделённые строкой "---".
Правила:
- Формат даты строго: Дата: DD.MM.YY
- Точка строкой вида: КП79: (-)  (вместо КП79 может быть БХ2 и т.п.)
- Пустые/неизвестные значения ставь как (-)
- Сотрудник может быть "@username" или числовой telegram_id, иначе (-)
- Числа без ₽, допускай пробелы: 1 000
- Инкассация: ДА/НЕТ, если ДА и есть сумма — Сумма инкассации: 1000, иначе (-)

СТРОГИЙ ШАБЛОН ОДНОЙ СМЕНЫ:
Сотрудник: (-)
Дата: 21.12.25
Время: (-)
КП79: (-)

Продажи: (-)
Наличные: (-)
В кассе: (-)
Чеков: (-)
Инкассация: НЕТ
Сумма инкассации: (-)

Верни ТОЛЬКО итоговый текст в строгом формате.`;

      const text =
        `<b>Загрузка отчётов — текстом</b>\n\n` +
        `Пришлите одним сообщением несколько смен в строгом формате.\n` +
        `Блоки разделяйте строкой:\n<pre>---</pre>\n\n` +
        `<b>Важно</b>\n` +
        `• Обязательна только строка <b>Дата:</b>\n` +
        `• Пустое значение пишите как <b>(-)</b>\n` +
        `• Точка — строкой вида <b>КП79: (-)</b>\n\n` +
        `<b>Промпт для ИИ (скопируй в GPT):</b>\n` +
        `<pre>${escapePre(aiPrompt)}</pre>\n\n` +
        `После этого вставь сюда результат от ИИ (строгий формат), и бот импортирует смены.`;

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "lk_reports_import_menu")],
      ]);

      return deliver(
        ctx,
        { text, extra: { parse_mode: "HTML", ...kb } },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_import_text", e);
    }
  });

  // регистрируем обработчики текстового импорта
  registerTextImport(bot, deps);
}

// маленький helper, чтобы <pre> не ломался
function escapePre(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { registerReportImports };
