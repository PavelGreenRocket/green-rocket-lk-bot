const { registerMenu } = require("./menu");
const { registerShifts } = require("./shifts");
const { registerNotifications } = require("./notifications");
const { registerQuestions } = require("./questions");
const { registerMore } = require("./more");
const { registerInterviewUser } = require("./interviewUser");

// админ-панель
const { registerAdminPanel } = require("./admin"); // можно и "./admin/index"

function registerLkBot(bot, ensureUser, logError) {
  registerMenu(bot, ensureUser, logError);
  registerShifts(bot, ensureUser, logError);
  registerNotifications(bot, ensureUser, logError);
  registerQuestions(bot, ensureUser, logError);
  registerInterviewUser(bot, ensureUser, logError);

  // только новая админ-панель
  registerAdminPanel(bot, ensureUser, logError);
  registerMore(bot, ensureUser, logError);
}

module.exports = { registerLkBot };
