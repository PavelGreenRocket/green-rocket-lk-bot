// src/bot/admin/users/index.js

const { registerCandidateListHandlers } = require("./candidateList");
const registerCandidateCard = require("./candidateCard");
const registerCandidateInterview = require("./candidateInterview");
const registerCandidateInternship = require("./candidateInternship");
const { registerCandidateCreate } = require("./candidateCreate");
const registerCandidatePerformance = require("./performance");

module.exports = function registerAdminUsers(
  bot,
  ensureUser,
  logError,
  deliver
) {
  // Список кандидатов + фильтры + переключатели Кандидаты | Стажёры | Сотрудники
  registerCandidateListHandlers(bot, ensureUser, logError);

  // Карточка кандидата (все статусы + кнопки управления). Тут нужен deliver.
  registerCandidateCard(bot, ensureUser, logError, deliver);

  // Успеваемость (отдельный модуль). Тут нужен deliver.
  registerCandidatePerformance(bot, ensureUser, logError, deliver);

  // Итоги собеседования (при нажатии "✅ Собеседование пройдено")
  registerCandidateInterview(bot, ensureUser, logError);

  // Приглашение на стажировку + привязка к пользователю ЛК
  registerCandidateInternship(bot, ensureUser, logError);

  // Создание нового кандидата (опрос)
  registerCandidateCreate(bot, ensureUser, logError, deliver);
};
