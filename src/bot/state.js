// src/bot/state.js

// Простое хранение состояний по tgId
const userStates = new Map(); // { mode: '...', ... }

function setUserState(tgId, state) {
  userStates.set(tgId, state);
}

function getUserState(tgId) {
  return userStates.get(tgId) || null;
}

function clearUserState(tgId) {
  userStates.delete(tgId);
}

module.exports = {
  setUserState,
  getUserState,
  clearUserState,
};
