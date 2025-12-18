//src\bot\index.js
const { registerMenu } = require("./menu");
const { registerShifts } = require("./shifts/index.js");
const { registerTasks } = require("./tasks");
const { registerNotifications } = require("./notifications");
const { registerQuestions } = require("./questions");
const { registerMore } = require("./more");
const { registerInterviewUser } = require("./interviewUser");
const { registerAiLogs } = require("./admin/aiLogs");

// админ-панель
const { registerAdminPanel } = require("./admin");

function registerLkBot(bot, ensureUser, logError) {
  registerMenu(bot, ensureUser, logError);
  registerShifts(bot, ensureUser, logError);
  registerTasks(bot, ensureUser, logError);
  registerNotifications(bot, ensureUser, logError);
  registerAiLogs(bot, ensureUser, logError);
  registerQuestions(bot, ensureUser, logError);
  registerInterviewUser(bot, ensureUser, logError);

  // только новая админ-панель
  registerAdminPanel(bot, ensureUser, logError);
  registerMore(bot, ensureUser, logError);
}

module.exports = { registerLkBot };
