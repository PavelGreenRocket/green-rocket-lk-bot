// src/bot/shifts/flow.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");
const { toast, alert } = require("../../utils/toast");
const { showTodayTasks } = require("../tasks/today");
const { showHandoverAfterOpenIfAny } = require("../handover");

const MODE = "shift_open";

function getShiftState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function setShiftState(tgId, patch) {
  const prev = getShiftState(tgId) || { mode: MODE };
  setUserState(tgId, { ...prev, ...patch });
}
function clearShiftState(tgId) {
  const st = getShiftState(tgId);
  if (st) clearUserState(tgId);
}

async function getActiveShift(userId) {
  const res = await pool.query(
    `
      SELECT id, status, trade_point_id
      FROM shifts
      WHERE user_id = $1
        AND opened_at::date = CURRENT_DATE
        AND status IN ('opening_in_progress','opened','closing_in_progress')
      ORDER BY opened_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

async function showPickPoint(ctx) {
  const res = await pool.query(
    `
      SELECT id, title
      FROM trade_points
      WHERE is_active = TRUE
      ORDER BY id
    `
  );

  const rows = [];
  for (const p of res.rows) {
    rows.push([
      Markup.button.callback(`🏬 ${p.title}`, `shift_open_point_${p.id}`),
    ]);
  }
  rows.push([Markup.button.callback("❌ Отмена", "shift_open_cancel")]);
  const total = openingTotal(0);
  await deliver(
    ctx,
    {
      text: `🚀 <b>1/${total}</b>\n\n<b>Выберите торговую точку:</b>`,
      extra: Markup.inlineKeyboard(rows),
    },
    { edit: true }
  );
}

async function showAskCash(ctx, user) {
  const st = getShiftState(ctx.from.id) || {};
  const tpTitle = await getTradePointTitle(st.tradePointId);

  // чтобы шаги считались правильно (если есть вопросы после наличных)
  const previewQueue = await loadShiftQuestionsForUser(
    user,
    st.tradePointId
  ).catch(() => []);
  const total = openingTotal(previewQueue.length);

  const head = openingHeader(tpTitle, null);

  const kb = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "shift_open_back_to_points" }],
    [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
  ]);

  await deliver(
    ctx,
    {
      text: `🚀 <b>2/${total}</b>\n${head}\n\n<b>Введите количество наличных (числом):</b>`,
      extra: kb,
    },
    { edit: true }
  );
}

async function loadShiftQuestionsForUser(user, tradePointId) {
  // staff_status: intern/worker (candidate сюда не попадёт)
  const isIntern = user.staff_status === "intern";

  const commonRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'common' AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `
  );

  const pointRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'point' AND trade_point_id = $1 AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `,
    [tradePointId]
  );

  const filterAudience = (q) => {
    if (q.audience === "interns") return isIntern;
    return true; // all
  };

  const queue = [...commonRes.rows, ...pointRes.rows].filter(filterAudience);
  return queue.map((q) => ({
    questionId: q.id,
    title: q.title,
    answerType: q.answer_type, // text|number|photo|video
  }));
}

async function getTradePointTitle(tpId) {
  if (!tpId) return null;
  const r = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tpId]
  );
  return r.rows[0]?.title || `#${tpId}`;
}

function fmtMoney(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("ru-RU");
}

function openingHeader(tpTitle, cashAmount) {
  const lines = [];
  if (tpTitle) lines.push(`<b>${tpTitle}</b>`);
  lines.push(new Date().toLocaleDateString("ru-RU"));
  if (cashAmount !== undefined && cashAmount !== null) {
    const c = fmtMoney(cashAmount);
    if (c) lines.push(`Наличные в кассе: <b>${c}</b>`);
  }
  return lines.join("\n");
}

function openingTotal(queueLen) {
  return 2 + (queueLen || 0); // 1: точка, 2: наличные, дальше вопросы
}

function formatQuestionText(stepIndex, totalSteps, q, tpTitle, cashAmount) {
  const emoji =
    q.answerType === "photo"
      ? "📷"
      : q.answerType === "video"
      ? "🎥"
      : q.answerType === "number"
      ? "🔢"
      : "📝";

  const hint =
    q.answerType === "photo"
      ? "Пришлите фото."
      : q.answerType === "video"
      ? "Пришлите видео."
      : q.answerType === "number"
      ? "Введите число."
      : "Введите текст.";

  const head = openingHeader(tpTitle, cashAmount);

  return (
    `🚀 <b>${stepIndex}/${totalSteps}</b>\n` +
    `${head}\n\n` +
    `${emoji} <b>${q.title}</b>\n\n${hint}`
  );
}

async function showShiftQuestion(ctx, st) {
  const q = st.queue[st.idx];
  const totalSteps = openingTotal(st.queue.length);
  const stepIndex = 3 + st.idx; // 1:точка, 2:наличные, 3..N: вопросы

  const tpTitle = await getTradePointTitle(st.tradePointId);

  const text = formatQuestionText(
    stepIndex,
    totalSteps,
    q,
    tpTitle,
    st.cashAmount ?? null
  );

  const kb = Markup.inlineKeyboard([
    [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
  ]);

  if (ctx.callbackQuery) {
    await deliver(ctx, { text, extra: kb }, { edit: true });
    return;
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb.reply_markup });
}

function registerShiftFlow(bot, ensureUser, logError) {
  bot.action(/^shift_transfer_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const reqId = Number(ctx.match[1]);

      const r = await pool.query(
        `
        SELECT
          tr.id,
          tr.status,
          tr.to_user_id,
          tr.to_shift_id,
          tr.trade_point_id,
          tp.title AS point_title
        FROM shift_transfer_requests tr
        JOIN trade_points tp ON tp.id = tr.trade_point_id
        WHERE tr.id = $1
        LIMIT 1
        `,
        [reqId]
      );

      const req = r.rows[0];
      if (!req) {
        await ctx.reply("❌ Запрос не найден.");
        return;
      }

      if (Number(req.to_user_id) !== Number(user.id)) {
        await ctx.reply("❌ Это не ваш запрос передачи.");
        return;
      }

      if (req.status !== "completed") {
        await ctx.reply("⏱ Передача ещё не завершена или уже неактуальна.");
        return;
      }

      // выставляем state на ввод кассы по shift_id, который уже создан у B
      setShiftState(ctx.from.id, {
        shiftId: Number(req.to_shift_id),
        step: "cash",
        tradePointId: Number(req.trade_point_id),
      });

      await ctx.reply(
        `✅ Открываем смену на *${req.point_title}*.\nВведите сумму *в кассе*:`,
        {
          parse_mode: "Markdown",
        }
      );

      // запускаем стандартный экран ввода кассы (как при обычном открытии)
      await showAskCash(ctx, user);
    } catch (err) {
      logError("shift_transfer_open", err);
    }
  });

  // Entry point: Open/Close toggle
  bot.action("lk_shift_toggle", async (ctx) => {
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

      const active = await getActiveShift(user.id);

      // Пока закрытие смены сделаем позже: если смена уже есть — просто алерт
      // Пока закрытие смены сделаем позже: если смена уже есть — просто алерт
      if (active) {
        await toast(ctx, "Смена уже открыта сегодня ✅");
        return;
      }

      // Создаём смену СРАЗУ (как ты хотел): opened_at фиксируется в момент нажатия
      const ins = await pool.query(
        `
          INSERT INTO shifts (user_id, status)
          VALUES ($1, 'opening_in_progress')
          RETURNING id
        `,
        [user.id]
      );

      const shiftId = ins.rows[0].id;

      setShiftState(ctx.from.id, {
        step: "pick_point",
        shiftId,
      });

      await ctx.answerCbQuery().catch(() => {});
      await showPickPoint(ctx);
    } catch (err) {
      logError("lk_shift_toggle", err);
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
    }
  });

  // Cancel opening
  bot.action("shift_open_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getShiftState(ctx.from.id);
      if (st?.shiftId) {
        // можно пометить отменённую смену как closed, чтобы не висела
        await pool.query(
          `UPDATE shifts SET status='closed', closed_at=NOW() WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
      }
      clearShiftState(ctx.from.id);

      await deliver(
        ctx,
        {
          text: "Ок, открытие смены отменено.",
          extra: Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ К смене", "lk_profile_shift")],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("shift_open_cancel", err);
    }
  });

  // Back to points
  bot.action("shift_open_back_to_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const st = getShiftState(ctx.from.id);
      if (!st) return;
      st.step = "pick_point";
      setShiftState(ctx.from.id, st);
      await showPickPoint(ctx);
    } catch (err) {
      logError("shift_open_back_to_points", err);
    }
  });

  // ===== Shift transfer: accept/decline =====

  bot.action(/^shift_transfer_accept_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const reqId = Number(ctx.match[1]);
      const r = await pool.query(
        `
        SELECT
          tr.*,
          tp.title AS point_title,
          u_to.telegram_id AS to_telegram_id,
          u_to.full_name AS to_name,
          u_to.username  AS to_username
        FROM shift_transfer_requests tr
        JOIN trade_points tp ON tp.id = tr.trade_point_id
        JOIN users u_to ON u_to.id = tr.to_user_id
        WHERE tr.id = $1
        LIMIT 1
        `,
        [reqId]
      );
      const req = r.rows[0];
      if (!req) {
        await ctx.reply("❌ Запрос не найден.");
        return;
      }

      // проверка: только владелец смены может принять
      if (Number(req.from_user_id) !== Number(user.id)) {
        await ctx.reply("❌ Вы не можете принять этот запрос.");
        return;
      }

      // таймаут
      if (req.status !== "pending" || new Date(req.expires_at) <= new Date()) {
        // если pending, но просрочен — пометим expired
        if (req.status === "pending") {
          await pool.query(
            `UPDATE shift_transfer_requests SET status='expired', responded_at=now() WHERE id=$1`,
            [reqId]
          );
        }
        await ctx.reply("⏱ Запрос уже неактуален (истёк или обработан).");
        return;
      }

      await pool.query(
        `UPDATE shift_transfer_requests
   SET status='accepted',
       responded_at=now(),
       expires_at = now() + interval '30 minutes'
   WHERE id=$1 AND status='pending'`,
        [reqId]
      );

      // уведомим B
      if (req.to_telegram_id) {
        const who =
          req.to_name ||
          (req.to_username ? `@${req.to_username}` : "сотрудник");
        await ctx.telegram
          .sendMessage(
            req.to_telegram_id,
            `✅ Запрос принят.\n\nСотрудник передаст смену на точке *${req.point_title}*.\nОжидайте завершения передачи.`,
            { parse_mode: "Markdown" }
          )
          .catch(() => {});
      }

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "➡️ Перейти к закрытию (передача)",
            "shift_close_continue"
          ),
        ],
      ]);

      await ctx.reply(
        "✅ Принято.\n\nТеперь перейдите к закрытию смены. В конце будет кнопка *«Передать смену»*.",
        { parse_mode: "Markdown", reply_markup: kb.reply_markup }
      );
    } catch (err) {
      logError("shift_transfer_accept", err);
    }
  });

  bot.action(/^shift_transfer_decline_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const reqId = Number(ctx.match[1]);
      const r = await pool.query(
        `
        SELECT
          tr.*,
          tp.title AS point_title,
          u_to.telegram_id AS to_telegram_id
        FROM shift_transfer_requests tr
        JOIN trade_points tp ON tp.id = tr.trade_point_id
        JOIN users u_to ON u_to.id = tr.to_user_id
        WHERE tr.id = $1
        LIMIT 1
        `,
        [reqId]
      );
      const req = r.rows[0];
      if (!req) {
        await ctx.reply("❌ Запрос не найден.");
        return;
      }

      if (Number(req.from_user_id) !== Number(user.id)) {
        await ctx.reply("❌ Вы не можете отклонить этот запрос.");
        return;
      }

      // если уже просрочен/обработан — просто сообщим
      if (req.status !== "pending" || new Date(req.expires_at) <= new Date()) {
        if (req.status === "pending") {
          await pool.query(
            `UPDATE shift_transfer_requests SET status='expired', responded_at=now() WHERE id=$1`,
            [reqId]
          );
        }
        await ctx.reply("⏱ Запрос уже неактуален.");
        return;
      }

      await pool.query(
        `UPDATE shift_transfer_requests
         SET status='declined', responded_at=now()
         WHERE id=$1 AND status='pending'`,
        [reqId]
      );

      // уведомим B
      if (req.to_telegram_id) {
        await ctx.telegram
          .sendMessage(
            req.to_telegram_id,
            `❌ Передача смены отклонена.\n\nВыберите точку заново.`,
            { parse_mode: "Markdown" }
          )
          .catch(() => {});
      }

      await ctx.reply("❌ Отклонено. Запрос закрыт.");
    } catch (err) {
      logError("shift_transfer_decline", err);
    }
  });

  // Pick point
  bot.action(/^shift_open_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getShiftState(ctx.from.id);
      if (!st || st.step !== "pick_point") return;

      const pointId = Number(ctx.match[1]);

      await pool.query(
        `UPDATE shifts SET trade_point_id=$1 WHERE id=$2 AND user_id=$3`,
        [pointId, st.shiftId, user.id]
      );

      // === transfer check: есть ли активная смена другого сотрудника на этой точке
      const active = await pool.query(
        `
        SELECT s.id AS shift_id, s.user_id, u.telegram_id, u.full_name, u.username, tp.title AS point_title
        FROM shifts s
        JOIN users u ON u.id = s.user_id
        JOIN trade_points tp ON tp.id = s.trade_point_id
        WHERE s.trade_point_id = $1
          AND s.status = ANY(ARRAY[
  'opening_in_progress'::shift_status,
  'opened'::shift_status,
  'closing_in_progress'::shift_status
])
          AND s.user_id <> $2
        ORDER BY s.id DESC
        LIMIT 1
        `,
        [pointId, user.id]
      );

      const a = active.rows[0];

      if (a && a.telegram_id) {
        // если уже есть pending-запрос на эту точку — не создаём второй
        const exists = await pool.query(
          `SELECT id FROM shift_transfer_requests WHERE trade_point_id=$1 AND status='pending' LIMIT 1`,
          [pointId]
        );
        if (exists.rows[0]) {
          await ctx.reply(
            "⏱ На эту точку уже отправлен запрос на передачу. Подождите минуту или попробуйте позже."
          );
          // оставляем пользователя на выборе точки
          setShiftState(ctx.from.id, {
            ...st,
            step: "pick_point",
            tradePointId: null,
          });
          await showPickPoint(ctx);
          return;
        }

        const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

        const ins = await pool.query(
          `
          INSERT INTO shift_transfer_requests
            (trade_point_id, from_shift_id, from_user_id, to_shift_id, to_user_id, expires_at)
          VALUES
            ($1,$2,$3,$4,$5,$6)
          RETURNING id
          `,
          [pointId, a.shift_id, a.user_id, st.shiftId, user.id, expiresAt]
        );

        const reqId = ins.rows[0].id;

        const requester =
          user.full_name || (user.username ? `@${user.username}` : "сотрудник");

        const msg =
          `🔁 *Запрос на передачу смены*\n\n` +
          `Точка: *${a.point_title}*\n` +
          `Сотрудник: *${requester}*\n\n` +
          `Передать смену этому сотруднику?\n` +
          `Если вы согласитесь, далее вы заполните стандартное закрытие и завершите передачу.`;

        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ Передать",
              `shift_transfer_accept_${reqId}`
            ),
            Markup.button.callback(
              "❌ Отменить",
              `shift_transfer_decline_${reqId}`
            ),
          ],
        ]);

        await ctx.telegram.sendMessage(a.telegram_id, msg, {
          parse_mode: "Markdown",
          reply_markup: kb.reply_markup,
        });

        await ctx.reply(
          `✅ Запрос отправлен сотруднику на точке *${a.point_title}*.\n⏱ Ожидайте ответ до 1 минуты.`,
          { parse_mode: "Markdown" }
        );

        // возвращаем к выбору точки (как ты просил)
        setShiftState(ctx.from.id, {
          ...st,
          step: "pick_point",
          tradePointId: null,
        });
        await showPickPoint(ctx);
        return;
      }

      setShiftState(ctx.from.id, {
        ...st,
        step: "cash",
        tradePointId: pointId,
      });

      await showAskCash(ctx, user);
    } catch (err) {
      logError("shift_open_point", err);
    }
  });

  // Cash input (text)
  bot.on("text", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "cash") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const raw = (ctx.message.text || "").trim();
      const num = Number(raw.replace(",", "."));

      if (!Number.isFinite(num)) {
        await ctx.reply("❌ Нужно число. Пример: 1200 или 1200.50");
        return;
      }

      // 1) СНАЧАЛА сохраняем сумму открытия смены
      await pool.query(
        `UPDATE shifts SET cash_amount=$1 WHERE id=$2 AND user_id=$3`,
        [num, st.shiftId, user.id]
      );

      // если смена была открыта после передачи — синкнем задачи от предыдущего сотрудника
      try {
        await syncTasksFromTransferIfNeeded(st.shiftId);
      } catch (e) {
        logError("syncTasksFromTransferIfNeeded", e);
      }

      // если смена открыта после передачи — уведомим передающего, что смена реально открыта
      try {
        await notifyTransferOpenedIfNeeded(ctx, st.shiftId, num, user);
      } catch (e) {
        logError("notifyTransferOpenedIfNeeded", e);
      }

      try {
        const mod = await import("../cashDiffAlerts.js");
        const fn =
          mod.checkCashDiffAndNotify || mod.default?.checkCashDiffAndNotify;
        if (typeof fn === "function") {
          const res = await fn({
            shiftId: st.shiftId,
            stage: "open",
            actorUserId: user.id,
          });

          // PUSH всем ответственным
          if (res?.userIds?.length && res?.text) {
            const r = await pool.query(
              `SELECT telegram_id FROM users WHERE id = ANY($1::int[]) AND telegram_id IS NOT NULL`,
              [res.userIds]
            );

            const kb = Markup.inlineKeyboard([
              [Markup.button.callback("➡️ Перейти к отчёту", `lk_reports`)],
            ]);

            await Promise.allSettled(
              (r.rows || []).map((x) =>
                ctx.telegram
                  .sendMessage(x.telegram_id, res.text, {
                    parse_mode: "Markdown",
                    reply_markup: kb.reply_markup,
                  })
                  .catch(() => {})
              )
            );
          }
        }
      } catch (e) {
        logError("cashDiffAlerts_open", e);
      }

      // запускаем регулируемый опрос
      const queue = await loadShiftQuestionsForUser(user, st.tradePointId);

      if (!queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем задачи на сегодня
        const shown = await showHandoverAfterOpenIfAny(
          ctx,
          st.tradePointId,
          st.shiftId
        );
        if (!shown) await showTodayTasks(ctx, user);
        return;
      }

      setShiftState(ctx.from.id, {
        ...st,
        step: "survey",
        queue,
        idx: 0,
        cashAmount: num,
      });

      // покажем первый вопрос
      await showShiftQuestion(ctx, { ...st, step: "survey", queue, idx: 0 });
      return;
    } catch (err) {
      logError("shift_cash_input", err);
      await ctx.reply("❌ Ошибка при сохранении. Попробуйте ещё раз.");
    }
  });

  bot.on("text", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      const raw = (ctx.message.text || "").trim();

      if (q.answerType === "number") {
        const num = Number(raw.replace(",", "."));
        if (!Number.isFinite(num)) {
          await ctx.reply("❌ Нужно число. Пример: 12 или 12.5");
          return;
        }
        await pool.query(
          `
            INSERT INTO shift_answers (shift_id, question_id, answer_number)
            VALUES ($1, $2, $3)
            ON CONFLICT (shift_id, question_id) DO UPDATE SET answer_number = EXCLUDED.answer_number
          `,
          [st.shiftId, q.questionId, num]
        );
      } else if (q.answerType === "text") {
        await pool.query(
          `
            INSERT INTO shift_answers (shift_id, question_id, answer_text)
            VALUES ($1, $2, $3)
            ON CONFLICT (shift_id, question_id) DO UPDATE SET answer_text = EXCLUDED.answer_text
          `,
          [st.shiftId, q.questionId, raw]
        );
      } else {
        // ждали фото/видео, а пришёл текст
        await ctx.reply(
          "❌ Для этой задачи нужно фото/видео. Отправьте нужный формат."
        );
        return;
      }

      // следующий вопрос
      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        // опрос завершён — открываем смену (следующий шаг: чек-лист)
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем экран задач на сегодня
        const shown = await showHandoverAfterOpenIfAny(
          ctx,
          st.tradePointId,
          st.shiftId
        );
        if (!shown) await showTodayTasks(ctx, user);
        return;
      }
      const newSt = { ...st, idx: nextIdx };
      setShiftState(ctx.from.id, newSt);
      await showShiftQuestion(ctx, newSt);
    } catch (err) {
      logError("shift_survey_text", err);
      await ctx.reply("❌ Ошибка при сохранении ответа. Попробуйте ещё раз.");
    }
  });

  bot.on("photo", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      if (q.answerType !== "photo") return next();

      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best?.file_id) return next();

      await pool.query(
        `
          INSERT INTO shift_answers (shift_id, question_id, file_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (shift_id, question_id) DO UPDATE SET file_id = EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, best.file_id]
      );

      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем экран задач на сегодня
        const shown = await showHandoverAfterOpenIfAny(
          ctx,
          st.tradePointId,
          st.shiftId
        );
        if (!shown) await showTodayTasks(ctx, user);
        return;
      }
      const newSt = { ...st, idx: nextIdx };
      setShiftState(ctx.from.id, newSt);
      await showShiftQuestion(ctx, newSt);
    } catch (err) {
      logError("shift_survey_photo", err);
      await ctx.reply("❌ Ошибка при сохранении фото. Попробуйте ещё раз.");
    }
  });

  bot.on("video", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      if (q.answerType !== "video") return next();

      const v = ctx.message.video;
      if (!v?.file_id) return next();

      await pool.query(
        `
          INSERT INTO shift_answers (shift_id, question_id, file_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (shift_id, question_id) DO UPDATE SET file_id = EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, v.file_id]
      );

      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        const shown = await showHandoverAfterOpenIfAny(
          ctx,
          st.tradePointId,
          st.shiftId
        );
        if (!shown) await showTodayTasks(ctx, user);
        return;
      }

      const newSt = { ...st, idx: nextIdx };
      setShiftState(ctx.from.id, newSt);
      await showShiftQuestion(ctx, newSt);
    } catch (err) {
      logError("shift_survey_video", err);
      await ctx.reply("❌ Ошибка при сохранении видео. Попробуйте ещё раз.");
    }
  });
}
async function syncTasksFromTransferIfNeeded(toShiftId) {
  // найдём completed transfer, где эта смена = to_shift_id, и ещё не синкали задачи
  const r = await pool.query(
    `
    SELECT
      tr.id AS req_id,
      tr.from_user_id,
      tr.to_user_id,
      tr.trade_point_id,
      s.opened_at
    FROM shift_transfer_requests tr
    LEFT JOIN shifts s ON s.id = tr.to_shift_id
    WHERE tr.to_shift_id = $1
      AND tr.status = 'completed'
      AND tr.tasks_synced_at IS NULL
    ORDER BY tr.id DESC
    LIMIT 1
    `,
    [Number(toShiftId)]
  );

  const req = r.rows[0];
  if (!req) return;

  const tradePointId = Number(req.trade_point_id);
  const fromUserId = Number(req.from_user_id);
  const toUserId = Number(req.to_user_id);

  // дата задач = дата смены (если opened_at нет — берём сегодня)
  const forDate = req.opened_at
    ? new Date(req.opened_at).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // копируем/апсёртим task_instances от A -> B по этой точке и дате
  await pool.query(
    `
    INSERT INTO task_instances
      (assignment_id, template_id, user_id, trade_point_id, for_date, time_mode, deadline_at, status, done_at)
    SELECT
      ti.assignment_id,
      ti.template_id,
      $3::bigint AS user_id,
      ti.trade_point_id,
      ti.for_date,
      ti.time_mode,
      ti.deadline_at,
      ti.status,
      ti.done_at
    FROM task_instances ti
    WHERE ti.user_id = $1
      AND ti.trade_point_id = $2
      AND ti.for_date = $4::date
    ON CONFLICT (assignment_id, user_id, for_date)
    DO UPDATE SET
      trade_point_id = EXCLUDED.trade_point_id,
      template_id    = EXCLUDED.template_id,
      time_mode      = EXCLUDED.time_mode,
      deadline_at    = EXCLUDED.deadline_at,
      status         = EXCLUDED.status,
      done_at        = EXCLUDED.done_at
    `,
    [fromUserId, tradePointId, toUserId, forDate]
  );

  // помечаем, что синк выполнен (чтобы не гонять повторно)
  await pool.query(
    `UPDATE shift_transfer_requests SET tasks_synced_at = now() WHERE id = $1`,
    [Number(req.req_id)]
  );
}

async function notifyTransferOpenedIfNeeded(
  ctx,
  toShiftId,
  openingCash,
  openerUser
) {
  const r = await pool.query(
    `
    SELECT
      tr.id AS req_id,
      tr.from_user_id,
      u_from.telegram_id AS from_telegram_id,
      tp.title AS point_title,
      s.id AS shift_id
    FROM shift_transfer_requests tr
    JOIN users u_from ON u_from.id = tr.from_user_id
    JOIN trade_points tp ON tp.id = tr.trade_point_id
    JOIN shifts s ON s.id = tr.to_shift_id
    WHERE tr.to_shift_id = $1
      AND tr.status = 'completed'
      AND tr.opened_notified_at IS NULL
    ORDER BY tr.id DESC
    LIMIT 1
    `,
    [Number(toShiftId)]
  );

  const row = r.rows[0];
  if (!row || !row.from_telegram_id) return;

  const openerName =
    openerUser?.full_name ||
    (openerUser?.username ? `@${openerUser.username}` : "сотрудник");

  const cashStr =
    typeof openingCash === "number" && Number.isFinite(openingCash)
      ? openingCash.toLocaleString("ru-RU")
      : "—";

  const text =
    `✅ *Смена принята и открыта*\n\n` +
    `Точка: *${row.point_title}*\n` +
    `Смена: *${row.shift_id}*\n` +
    `Кто открыл: *${openerName}*\n` +
    `В кассе при открытии: *${cashStr} ₽*`;

  await ctx.telegram.sendMessage(row.from_telegram_id, text, {
    parse_mode: "Markdown",
  });

  await pool.query(
    `UPDATE shift_transfer_requests SET opened_notified_at = now() WHERE id = $1`,
    [Number(row.req_id)]
  );
}

module.exports = { registerShiftFlow };
