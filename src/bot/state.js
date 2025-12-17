// src/bot/state.js
// User-flow state (onboarding, ожидание ввода, user-menus)

const userStates = new Map(); // key: telegram_id, value: any object

function getUserState(telegramId) {
  return userStates.get(telegramId) || null;
}

function setUserState(telegramId, state) {
  userStates.set(telegramId, state);
}

function clearUserState(telegramId) {
  userStates.delete(telegramId);
}

module.exports = {
  getUserState,
  setUserState,
  clearUserState,
};
