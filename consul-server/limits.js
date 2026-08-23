'use strict';
/* ============================================================================
 * Лимиты и защита от злоупотреблений.
 *
 * Ключ Groq один на весь сервис и платит за него владелец сервера, поэтому
 * расход надо ограничивать: и по кабинетам, и в целом. Плюс защита от клиента,
 * который шлёт боту сообщение раз в секунду.
 *
 * Счётчики суточных квот живут в сторе (переживают перезапуск), скользящие
 * окна на минуту — в памяти (после рестарта обнулить не страшно).
 * ========================================================================== */

const cfg = require('./config');

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------- суточные квоты */

const globalDay = { date: today(), used: 0 };

/** Сколько ответов AI кабинет уже израсходовал сегодня. */
function usedToday(w) {
  if (!w.quota || w.quota.date !== today()) return 0;
  return w.quota.used || 0;
}

/**
 * Можно ли потратить ещё один вызов модели.
 * @returns {{ok:true}|{ok:false, scope:'workspace'|'service', used:number, limit:number}}
 */
function checkAiQuota(w) {
  const d = today();
  if (globalDay.date !== d) { globalDay.date = d; globalDay.used = 0; }

  const perWs = cfg.limits.dailyPerWorkspace;
  const used = usedToday(w);
  if (perWs && used >= perWs) return { ok: false, scope: 'workspace', used, limit: perWs };

  const glob = cfg.limits.dailyGlobal;
  if (glob && globalDay.used >= glob) return { ok: false, scope: 'service', used: globalDay.used, limit: glob };

  return { ok: true };
}

/** Отмечает израсходованный вызов модели. */
function spendAi(w) {
  const d = today();
  if (!w.quota || w.quota.date !== d) w.quota = { date: d, used: 0 };
  w.quota.used++;
  if (globalDay.date !== d) { globalDay.date = d; globalDay.used = 0; }
  globalDay.used++;
  return w.quota.used;
}

const quotaLeft = w => {
  const per = cfg.limits.dailyPerWorkspace;
  return per ? Math.max(0, per - usedToday(w)) : Infinity;
};

/* ------------------------------------------------- скользящие окна */

const windows = new Map();   // ключ -> массив меток времени

/**
 * Разрешает не больше `max` событий за `windowMs` по данному ключу.
 * @returns {boolean} true — можно, false — превышено
 */
function allow(key, max, windowMs) {
  if (!max) return true;
  const now = Date.now();
  const from = now - windowMs;
  let arr = windows.get(key);
  if (!arr) { arr = []; windows.set(key, arr); }
  while (arr.length && arr[0] < from) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}

const allowChat = (ownerId, chatId) =>
  allow('c:' + ownerId + ':' + chatId, cfg.limits.perChatPerMinute, 60000);

const allowApi = userId =>
  allow('a:' + userId, cfg.limits.apiPerMinute, 60000);

/** Периодическая чистка, чтобы карта не росла бесконечно. */
function sweep() {
  const cutoff = Date.now() - 120000;
  for (const [k, arr] of windows) {
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (!arr.length) windows.delete(k);
  }
}
const sweeper = setInterval(sweep, 60000);
if (sweeper.unref) sweeper.unref();

/* ------------------------------------------------- объём базы знаний */

function knowledgeChars(w) {
  return (w.knowledge || []).reduce((sum, k) => sum + ((k.body || '').length), 0);
}
function checkKnowledgeRoom(w, addChars) {
  const limit = cfg.limits.knowledgeChars;
  if (!limit) return { ok: true };
  const used = knowledgeChars(w);
  if (used + addChars > limit) return { ok: false, used, limit };
  return { ok: true, used, limit };
}

module.exports = {
  checkAiQuota, spendAi, usedToday, quotaLeft,
  allow, allowChat, allowApi, sweep,
  knowledgeChars, checkKnowledgeRoom,
  _global: globalDay,
  _reset() { windows.clear(); globalDay.date = today(); globalDay.used = 0; },
};
