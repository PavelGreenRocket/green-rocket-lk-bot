// src/bot/admin/users/candidateEdit.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

/**
 * Локальный state для ввода текста:
 * key = tgId, value = { candidateId, field, back }
 */
const editState = new Map();
let isRestoreModeFor = () => false;

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

async function getTradePoints() {
  // Минимальный набор: id + title (+ address если есть)
  // Если у вас другое имя колонок — скажи, поправлю под схему trade_points
  const res = await pool.query(
    `
    SELECT id,
           COALESCE(title, 'Точка #' || id::text) AS title,
           COALESCE(address, '') AS address
      FROM trade_points
     ORDER BY id ASC
    `
  );
  return res.rows;
}

function backToCandidateCard(ctx, candidateId, showCandidateCardLk) {
  const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);
  return showCandidateCardLk(ctx, candidateId, { edit: true, restoreMode });
}

async function showEditInternshipMenu(ctx, candidateId, showCandidateCardLk) {
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "Дата (изменить)",
        `lk_cand_edit_internship_date_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Время (с) - изменить",
        `lk_cand_edit_internship_from_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Время (до)- изменить",
        `lk_cand_edit_internship_to_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Место (точка) - изменить",
        `lk_cand_edit_internship_point_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Ответственный (изменить)",
        `lk_cand_edit_internship_responsible_${candidateId}`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", `lk_cand_edit_back_${candidateId}`)],
  ]);

  const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);
  await showCandidateCardLk(ctx, candidateId, {
    edit: true,
    restoreMode,
    keyboardOverride: kb,
  });
}

async function showEditInterviewMenu(ctx, candidateId, showCandidateCardLk) {
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        " Дата (изменить)",
        `lk_cand_edit_interview_date_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Время (изменить)",
        `lk_cand_edit_interview_time_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Место (точка) - изменить",
        `lk_cand_edit_interview_point_${candidateId}`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", `lk_cand_edit_back_${candidateId}`)],
  ]);
  const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);

  // ✅ текст карточки НЕ меняем, меняем только клавиатуру
  await showCandidateCardLk(ctx, candidateId, {
    edit: true,
    restoreMode,
    keyboardOverride: kb,
  });
}

async function showEditCommonMenu(ctx, candidateId, showCandidateCardLk) {
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "Имя (изменить)",
        `lk_cand_edit_common_name_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Возраст (изменить)",
        `lk_cand_edit_common_age_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Телефон (изменить)",
        `lk_cand_edit_common_phone_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Пользователь (изменить)",
        `lk_cand_edit_user_${candidateId}`
      ),
    ],

    [
      Markup.button.callback(
        "Желаемая точка (изменить)",
        `lk_cand_edit_common_point_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Желаемая ЗП (изменить)",
        `lk_cand_edit_common_salary_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Желаемый график (изменить)",
        `lk_cand_edit_common_schedule_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Опыт/анкета (изменить)",
        `lk_cand_edit_common_questionnaire_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "Комментарий (изменить)",
        `lk_cand_edit_common_comment_${candidateId}`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", `lk_cand_edit_back_${candidateId}`)],
  ]);
  const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);

  await showCandidateCardLk(ctx, candidateId, {
    edit: true,
    restoreMode,
    keyboardOverride: kb,
  });
}

function askText(
  ctx,
  candidateId,
  title,
  backCallback,
  field,
  placeholder = ""
) {
  const msg = ctx.callbackQuery?.message;
  editState.set(ctx.from.id, {
    candidateId,
    field,
    backCallback,
    chatId: msg?.chat?.id,
    messageId: msg?.message_id,
  });

  const text =
    `✍️ <b>${title}</b>\n\n` +
    (placeholder ? `Пример: <code>${placeholder}</code>\n\n` : "") +
    "Отправьте значение текстом одним сообщением.\n" +
    "Чтобы отменить — нажмите кнопку ниже.";

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("❌ Отмена", backCallback)],
  ]);

  return ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb.reply_markup,
  });
}

async function setCandidateField(candidateId, field, value) {
  // Белый список полей (чтобы никто не обновил что угодно)
  const allowed = new Set([
    "name",
    "age",
    "phone",
    "desired_point_id",
    "salary",
    "schedule",
    "questionnaire",
    "comment",
    "interview_date",
    "interview_time",
    "point_id",
    "internship_date",
    "internship_time_from",
    "internship_time_to",
    "internship_point_id",
    "lk_user_tg_id",
    "internship_admin_id",
  ]);

  if (!allowed.has(field)) {
    throw new Error(`Field not allowed: ${field}`);
  }

  await pool.query(`UPDATE candidates SET ${field} = $2 WHERE id = $1`, [
    candidateId,
    value,
  ]);
}

function parseMaybeInt(s) {
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function parseDateISOorRu(input) {
  // ✅ Принимаем:
  // 1) YYYY-MM-DD
  // 2) DD.MM.YYYY
  // 3) DD.MM  (год подставляем текущий)
  const s = String(input).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split(".");
    return `${yyyy}-${mm}-${dd}`;
  }

  if (/^\d{2}\.\d{2}$/.test(s)) {
    const [dd, mm] = s.split(".");
    const yyyy = String(new Date().getFullYear());
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function parseTimeHHMM(input) {
  const s = String(input).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s;
  return null;
}

function registerCandidateEditHandlers(
  bot,
  ensureUser,
  logError,
  showCandidateCardLk,
  isRestoreModeForGetter
) {
  // ✅ запоминаем геттер (если не передали — будет false)
  if (typeof isRestoreModeForGetter === "function") {
    isRestoreModeFor = isRestoreModeForGetter;
  }

  // ==== Назад в карточку (с учётом restoreMode) ====
  bot.action(/^lk_cand_edit_back_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      editState.delete(ctx.from.id);
      await backToCandidateCard(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_back", err);
    }
  });

  // ==== Входы в меню редактирования ====
  bot.action(/^lk_cand_edit_common_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      await showEditCommonMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_common", err);
    }
  });

  bot.action(/^lk_cand_edit_interview_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      await showEditInterviewMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_interview", err);
    }
  });

  bot.action(/^lk_cand_edit_internship_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      await showEditInternshipMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_internship", err);
    }
  });

  // ==== Общая инфа: запрос текстом ====
  bot.action(/^lk_cand_edit_common_name_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить имя",
        `lk_cand_edit_common_${id}`,
        "name",
        "Иван"
      );
    } catch (err) {
      logError("lk_cand_edit_common_name", err);
    }
  });

  bot.action(/^lk_cand_edit_common_age_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить возраст",
        `lk_cand_edit_common_${id}`,
        "age",
        "22"
      );
    } catch (err) {
      logError("lk_cand_edit_common_age", err);
    }
  });

  bot.action(/^lk_cand_edit_common_phone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить телефон",
        `lk_cand_edit_common_${id}`,
        "phone",
        "+7XXXXXXXXXX"
      );
    } catch (err) {
      logError("lk_cand_edit_common_phone", err);
    }
  });

  bot.action(/^lk_cand_edit_common_salary_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить желаемую ЗП",
        `lk_cand_edit_common_${id}`,
        "salary",
        "40000"
      );
    } catch (err) {
      logError("lk_cand_edit_common_salary", err);
    }
  });

  bot.action(/^lk_cand_edit_common_schedule_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить желаемый график",
        `lk_cand_edit_common_${id}`,
        "schedule",
        "3/3"
      );
    } catch (err) {
      logError("lk_cand_edit_common_schedule", err);
    }
  });

  bot.action(/^lk_cand_edit_common_questionnaire_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить опыт/анкету",
        `lk_cand_edit_common_${id}`,
        "questionnaire"
      );
    } catch (err) {
      logError("lk_cand_edit_common_questionnaire", err);
    }
  });

  bot.action(/^lk_cand_edit_common_comment_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить комментарий",
        `lk_cand_edit_common_${id}`,
        "comment"
      );
    } catch (err) {
      logError("lk_cand_edit_common_comment", err);
    }
  });

  bot.action(/^lk_cand_edit_user_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✍️ Ввести ID / @username",
            `lk_cand_edit_user_manual_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "👥 Выбрать из ожидающих",
            `lk_cand_edit_user_waiting_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Назад",
            `lk_cand_edit_common_${candidateId}`
          ),
        ],
      ]);

      await ctx.editMessageText(
        "👤 <b>Привязать/изменить пользователя</b>\n\nВыберите способ:",
        {
          parse_mode: "HTML",
          reply_markup: kb.reply_markup,
        }
      );
    } catch (err) {
      logError("lk_cand_edit_user_menu", err);
    }
  });

  bot.action(/^lk_cand_edit_user_manual_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);

      await askText(
        ctx,
        id,
        "Привязать/изменить пользователя",
        `lk_cand_edit_common_${id}`,
        "lk_user_tg_id",
        "Например: 8192106284"
      );
    } catch (err) {
      logError("lk_cand_edit_user_manual", err);
    }
  });

  bot.action(/^lk_cand_edit_user_waiting_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const res = await pool.query(
        `
        SELECT id, telegram_id, full_name, age, phone, created_at
          FROM lk_waiting_users
         WHERE linked_user_id IS NULL
         ORDER BY created_at DESC
         LIMIT 20
      `
      );

      const rows = res.rows;

      if (!rows.length) {
        return ctx.editMessageText(
          "Пока нет новых непривязанных пользователей (ожидающих).",
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "⬅️ Назад",
                  `lk_cand_edit_user_${candidateId}`
                ),
              ],
            ]).reply_markup,
          }
        );
      }

      const buttons = rows.map((u) => {
        const agePart = u.age ? ` (${u.age})` : "";
        const phonePart = u.phone ? ` ${u.phone}` : "";
        const label = `${u.full_name || "Без имени"}${agePart}${phonePart}`;

        return [
          Markup.button.callback(
            label,
            `lk_cand_edit_user_waiting_select_${candidateId}_${u.id}`
          ),
        ];
      });

      buttons.push([
        Markup.button.callback("⬅️ Назад", `lk_cand_edit_user_${candidateId}`),
      ]);

      await ctx.editMessageText(
        "👥 <b>Выберите пользователя из ожидающих</b>:",
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }
      );
    } catch (err) {
      logError("lk_cand_edit_user_waiting", err);
    }
  });

  bot.action(/^lk_cand_edit_user_waiting_select_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("✅ Привязано").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      const waitingId = Number(ctx.match[2]);

      const wRes = await pool.query(
        `
        SELECT id, telegram_id, full_name
          FROM lk_waiting_users
         WHERE id = $1
         LIMIT 1
      `,
        [waitingId]
      );
      if (!wRes.rows.length) return;

      const w = wRes.rows[0];

      // 1) создаём/обновляем пользователя users по telegram_id и привязываем к candidate_id
      const uRes = await pool.query(
        `
        INSERT INTO users (telegram_id, full_name, role, staff_status, position, candidate_id)
        VALUES ($1, $2, 'user', 'candidate', NULL, $3)
        ON CONFLICT (telegram_id) DO UPDATE
          SET full_name = EXCLUDED.full_name,
              staff_status = 'candidate',
              candidate_id = $3
        RETURNING id
      `,
        [w.telegram_id, w.full_name, candidateId]
      );
      const userId = uRes.rows[0]?.id;

      // 2) записываем tg_id в кандидата (ваша текущая модель карточки это использует)
      await pool.query(
        `UPDATE candidates SET lk_user_tg_id = $1 WHERE id = $2`,
        [w.telegram_id, candidateId]
      );

      // 3) помечаем запись ожидания как linked
      if (userId) {
        await pool.query(
          `
          UPDATE lk_waiting_users
             SET status = 'linked',
                 linked_user_id = $2,
                 linked_at = NOW()
           WHERE id = $1
        `,
          [w.id, userId]
        );
      }

      // возвращаем в меню общей информации
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_edit_user_waiting_select", err);
    }
  });

  // ==== Выбор точки (общая: desired_point_id) ====
  bot.action(/^lk_cand_edit_common_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const points = await getTradePoints();
      const rows = points
        .slice(0, 20)
        .map((p) => [
          Markup.button.callback(
            p.address ? `${p.title} — ${p.address}` : p.title,
            `lk_cand_edit_set_desired_point_${candidateId}_${p.id}`
          ),
        ]);

      rows.push([
        Markup.button.callback(
          "⬅️ Назад",
          `lk_cand_edit_common_${candidateId}`
        ),
      ]);

      const kb = Markup.inlineKeyboard(rows);

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
        keyboardOverride: kb,
      });
    } catch (err) {
      logError("lk_cand_edit_common_point", err);
    }
  });

  bot.action(/^lk_cand_edit_set_desired_point_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("✅ Сохранено").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      const pointId = Number(ctx.match[2]);

      await setCandidateField(candidateId, "desired_point_id", pointId);

      // Возвращаемся в меню редактирования общей инфы
      await showEditCommonMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_set_desired_point", err);
    }
  });

  // ==== Интервью ====
  bot.action(/^lk_cand_edit_interview_date_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить дату собеседования",
        `lk_cand_edit_interview_${id}`,
        "interview_date",
        "13.12.2025"
      );
    } catch (err) {
      logError("lk_cand_edit_interview_date", err);
    }
  });

  bot.action(/^lk_cand_edit_interview_time_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить время собеседования",
        `lk_cand_edit_interview_${id}`,
        "interview_time",
        "14:00"
      );
    } catch (err) {
      logError("lk_cand_edit_interview_time", err);
    }
  });

  bot.action(/^lk_cand_edit_interview_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const points = await getTradePoints();
      const rows = points
        .slice(0, 20)
        .map((p) => [
          Markup.button.callback(
            p.address ? `${p.title} — ${p.address}` : p.title,
            `lk_cand_edit_set_point_${candidateId}_${p.id}`
          ),
        ]);

      rows.push([
        Markup.button.callback(
          "⬅️ Назад",
          `lk_cand_edit_interview_${candidateId}`
        ),
      ]);

      const kb = Markup.inlineKeyboard(rows);

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
        keyboardOverride: kb,
      });
    } catch (err) {
      logError("lk_cand_edit_interview_point", err);
    }
  });

  bot.action(/^lk_cand_edit_set_point_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("✅ Сохранено").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      const pointId = Number(ctx.match[2]);

      await setCandidateField(candidateId, "point_id", pointId);
      await showEditInterviewMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_set_point", err);
    }
  });

  // ==== Стажировка ====
  bot.action(/^lk_cand_edit_internship_date_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить дату стажировки",
        `lk_cand_edit_internship_${id}`,
        "internship_date",
        "15.12.2025"
      );
    } catch (err) {
      logError("lk_cand_edit_internship_date", err);
    }
  });

  async function getAdmins() {
    const res = await pool.query(`
    SELECT id, COALESCE(full_name, 'Админ #' || id::text) AS full_name
      FROM users
     WHERE role IN ('admin','super_admin')
     ORDER BY full_name ASC
  `);
    return res.rows;
  }

  bot.action(/^lk_cand_edit_internship_responsible_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const admins = await getAdmins();
      const rows = admins
        .slice(0, 30)
        .map((a) => [
          Markup.button.callback(
            a.full_name,
            `lk_cand_edit_set_internship_responsible_${candidateId}_${a.id}`
          ),
        ]);

      rows.push([
        Markup.button.callback(
          "⬅️ Назад",
          `lk_cand_edit_internship_${candidateId}`
        ),
      ]);

      await ctx.editMessageText(
        "👤 <b>Выберите ответственного по стажировке</b>",
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard(rows).reply_markup,
        }
      );
    } catch (err) {
      logError("lk_cand_edit_internship_responsible", err);
    }
  });

  bot.action(
    /^lk_cand_edit_set_internship_responsible_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery("✅ Сохранено").catch(() => {});
        const admin = await ensureUser(ctx);
        if (!isAdmin(admin)) return;

        const candidateId = Number(ctx.match[1]);
        const adminId = Number(ctx.match[2]);

        await setCandidateField(candidateId, "internship_admin_id", adminId);
        await showEditInternshipMenu(ctx, candidateId, showCandidateCardLk);
      } catch (err) {
        logError("lk_cand_edit_set_internship_responsible", err);
      }
    }
  );

  bot.action(/^lk_cand_edit_internship_from_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить время стажировки (с)",
        `lk_cand_edit_internship_${id}`,
        "internship_time_from",
        "10:00"
      );
    } catch (err) {
      logError("lk_cand_edit_internship_from", err);
    }
  });

  bot.action(/^lk_cand_edit_internship_to_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      await askText(
        ctx,
        id,
        "Изменить время стажировки (до)",
        `lk_cand_edit_internship_${id}`,
        "internship_time_to",
        "14:00"
      );
    } catch (err) {
      logError("lk_cand_edit_internship_to", err);
    }
  });

  bot.action(/^lk_cand_edit_internship_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);

      const points = await getTradePoints();
      const rows = points
        .slice(0, 20)
        .map((p) => [
          Markup.button.callback(
            p.address ? `${p.title} — ${p.address}` : p.title,
            `lk_cand_edit_set_internship_point_${candidateId}_${p.id}`
          ),
        ]);

      rows.push([
        Markup.button.callback(
          "⬅️ Назад",
          `lk_cand_edit_internship_${candidateId}`
        ),
      ]);

      await ctx.editMessageText("🏪 <b>Выберите место стажировки (точку)</b>", {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(rows).reply_markup,
      });
    } catch (err) {
      logError("lk_cand_edit_internship_point", err);
    }
  });

  bot.action(/^lk_cand_edit_set_internship_point_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("✅ Сохранено").catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const candidateId = Number(ctx.match[1]);
      const pointId = Number(ctx.match[2]);

      await setCandidateField(candidateId, "internship_point_id", pointId);
      await showEditInternshipMenu(ctx, candidateId, showCandidateCardLk);
    } catch (err) {
      logError("lk_cand_edit_set_internship_point", err);
    }
  });

  // ==== Перехват текста (ввод значения) ====
  bot.on("text", async (ctx, next) => {
    try {
      const st = editState.get(ctx.from.id);
      if (!st) return next();

      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) {
        editState.delete(ctx.from.id);
        return next();
      }

      const raw = (ctx.message?.text || "").trim();
      if (!raw) return;

      const { candidateId, field, backCallback } = st;

      // Парсинг по полям
      let value = raw;

      if (field === "lk_user_tg_id") {
        // допускаем: @username или число
        if (raw.startsWith("@")) {
          // пока просто сохраняем как текст в отдельное поле нельзя,
          // поэтому просим именно TG ID
          return ctx.reply(
            "Введите числовой Telegram ID (например 8192106284)."
          );
        }
        const n = parseMaybeInt(raw);
        if (n === null || n <= 0) {
          return ctx.reply("Введите корректный числовой Telegram ID.");
        }
        value = n;
      }

      if (field === "age") {
        value = parseMaybeInt(raw);
        if (value === null || value < 14 || value > 99) {
          return ctx.reply("Введите корректный возраст (число).");
        }
      }

      if (field === "interview_date" || field === "internship_date") {
        const d = parseDateISOorRu(raw);
        if (!d)
          return ctx.reply("Введите дату в формате DD.MM (например 13.12).");
        value = d;
      }

      if (
        field === "interview_time" ||
        field === "internship_time_from" ||
        field === "internship_time_to"
      ) {
        const t = parseTimeHHMM(raw);
        if (!t)
          return ctx.reply("Введите время в формате HH:MM (например 14:00).");
        value = t;
      }

      // Сохраняем
      await setCandidateField(candidateId, field, value);

      editState.delete(ctx.from.id);

      const forceMessage =
        st.chatId && st.messageId
          ? { chatId: st.chatId, messageId: st.messageId }
          : null;

      if (backCallback.startsWith("lk_cand_edit_common_")) {
        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "Имя (изменить)",
              `lk_cand_edit_common_name_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Возраст (изменить)",
              `lk_cand_edit_common_age_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Телефон (изменить)",
              `lk_cand_edit_common_phone_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Пользователь (изменить)",
              `lk_cand_edit_user_${candidateId}`
            ),
          ],

          [
            Markup.button.callback(
              "Желаемая точка (изменить)",
              `lk_cand_edit_common_point_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Желаемая ЗП (изменить)",
              `lk_cand_edit_common_salary_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Желаемый график (изменить)",
              `lk_cand_edit_common_schedule_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Опыт/анкета (изменить)",
              `lk_cand_edit_common_questionnaire_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Комментарий (изменить)",
              `lk_cand_edit_common_comment_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "⬅️ Назад",
              `lk_cand_edit_back_${candidateId}`
            ),
          ],
        ]);

        const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);
        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
          keyboardOverride: kb,
          ...(forceMessage ? { forceMessage } : {}),
        });
      } else if (backCallback.startsWith("lk_cand_edit_interview_")) {
        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              " Дата (изменить)",
              `lk_cand_edit_interview_date_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Время (изменить)",
              `lk_cand_edit_interview_time_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Место (точка) - изменить",
              `lk_cand_edit_interview_point_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Ответственный (изменить)",
              `lk_cand_edit_internship_responsible_${candidateId}`
            ),
          ],

          [
            Markup.button.callback(
              "⬅️ Назад",
              `lk_cand_edit_back_${candidateId}`
            ),
          ],
        ]);
        const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);

        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
          keyboardOverride: kb,
          ...(forceMessage ? { forceMessage } : {}),
        });
      } else if (backCallback.startsWith("lk_cand_edit_internship_")) {
        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "Дата - изменить",
              `lk_cand_edit_internship_date_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Время (с) - изменить",
              `lk_cand_edit_internship_from_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Время (до) - изменить",
              `lk_cand_edit_internship_to_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "Место (точка) - изменить",
              `lk_cand_edit_internship_point_${candidateId}`
            ),
          ],
          [
            Markup.button.callback(
              "⬅️ Назад",
              `lk_cand_edit_back_${candidateId}`
            ),
          ],
        ]);
        const restoreMode = isRestoreModeFor(ctx.from.id, candidateId);

        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
          keyboardOverride: kb,
          ...(forceMessage ? { forceMessage } : {}),
        });
      } else {
        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          restoreMode: isRestoreModeFor(ctx.from.id, candidateId),
          ...(forceMessage ? { forceMessage } : {}),
        });
      }
    } catch (err) {
      logError("candidate_edit_text", err);
      return next();
    }
  });
}

module.exports = {
  registerCandidateEditHandlers,
};
