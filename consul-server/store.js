'use strict';
/* ============================================================================
 * Хранилище Consul. Один рабочий кабинет (workspace) на владельца бота.
 *
 * Бэкенд — JSON-файл рядом с сервером (data/store.json), атомарная запись через
 * временный файл + rename. Зависимостей нет. Для продакшена с несколькими
 * инстансами это надо заменить на БД — интерфейс тут намеренно узкий
 * (get/save/find), чтобы такая замена была локальной.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CONSUL_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'store.json');

let db = null;
let saveTimer = null;

function empty() { return { workspaces: {}, byBotId: {}, byWebhookSecret: {}, seq: 1 }; }

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    db = empty();
  }
  for (const k of Object.keys(empty())) if (db[k] == null) db[k] = empty()[k];
  return db;
}

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] запись не удалась:', e.message);
  }
}

/** Отложенная запись — вызывается после каждой мутации. */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
  if (saveTimer.unref) saveTimer.unref();
}

/** Синхронный сброс на диск (при завершении процесса и в тестах). */
function persistNow() { clearTimeout(saveTimer); flush(); }

/* ------------------------------------------------------------ workspace */

function defaults(ownerId) {
  return {
    id: 'w' + ownerId,
    ownerId: String(ownerId),
    createdAt: Date.now(),
    onboarded: false,
    step: 0,
    bot: { connected: false, name: '', username: '', botId: 0, subs: 0, tokenEnc: '', webhookSecret: '' },
    biz: { name: '', site: '', about: '' },
    ai: {
      name: 'Ника', style: 'friendly', lang: 'RU', length: 'short', lengthVal: 40,
      canProducts: true, canContacts: true, canDiscount: false,
      handoff: ['клиент просит менеджера', 'жалоба'],
      instructions: '',
      banned: [],
      paused: false,
    },
    team: [], depts: ['Sales', 'Support'],
    knowledge: [],
    dialogs: {},
    counters: { msgs: 0, byAi: 0, handed: 0 },
    usage: { calls: 0, tokensIn: 0, tokensOut: 0, errors: 0 },
  };
}

function get(ownerId) {
  const d = load();
  return d.workspaces[String(ownerId)] || null;
}

function getOrCreate(ownerId) {
  const d = load();
  const key = String(ownerId);
  if (!d.workspaces[key]) { d.workspaces[key] = defaults(key); persist(); }
  const w = d.workspaces[key];
  // мягкая миграция: добавляем поля, появившиеся позже
  const def = defaults(key);
  for (const k of Object.keys(def)) if (w[k] == null) w[k] = def[k];
  for (const k of Object.keys(def.ai)) if (w.ai[k] == null) w.ai[k] = def.ai[k];
  return w;
}

function save(w) {
  const d = load();
  d.workspaces[String(w.ownerId)] = w;
  persist();
  return w;
}

/** Кабинет по id бота — маршрутизация входящих апдейтов Telegram. */
function findByBotId(botId) {
  const d = load();
  const owner = d.byBotId[String(botId)];
  return owner ? d.workspaces[owner] || null : null;
}

/** Кабинет по секрету вебхука — проверка X-Telegram-Bot-Api-Secret-Token. */
function findByWebhookSecret(secret) {
  const d = load();
  if (!secret) return null;
  const owner = d.byWebhookSecret[secret];
  return owner ? d.workspaces[owner] || null : null;
}

/** Привязывает бота к кабинету, снимая привязку с прежнего владельца. */
function bindBot(w, botId, webhookSecret) {
  const d = load();
  const prevOwner = d.byBotId[String(botId)];
  if (prevOwner && prevOwner !== String(w.ownerId)) {
    const prev = d.workspaces[prevOwner];
    if (prev) {
      if (prev.bot.webhookSecret) delete d.byWebhookSecret[prev.bot.webhookSecret];
      prev.bot = defaults(prevOwner).bot;
    }
  }
  if (w.bot.webhookSecret && w.bot.webhookSecret !== webhookSecret) delete d.byWebhookSecret[w.bot.webhookSecret];
  d.byBotId[String(botId)] = String(w.ownerId);
  d.byWebhookSecret[webhookSecret] = String(w.ownerId);
  persist();
}

function unbindBot(w) {
  const d = load();
  if (w.bot.botId) delete d.byBotId[String(w.bot.botId)];
  if (w.bot.webhookSecret) delete d.byWebhookSecret[w.bot.webhookSecret];
  w.bot = defaults(w.ownerId).bot;
  persist();
}

/** Полностью удаляет кабинет и все его данные. */
function remove(ownerId) {
  const d = load();
  const key = String(ownerId);
  const w = d.workspaces[key];
  if (!w) return false;
  if (w.bot && w.bot.botId) delete d.byBotId[String(w.bot.botId)];
  if (w.bot && w.bot.webhookSecret) delete d.byWebhookSecret[w.bot.webhookSecret];
  delete d.workspaces[key];
  persistNow();
  return true;
}

/** Все кабинеты — нужен для поиска по коду приглашения. */
function allWorkspaces() {
  return Object.values(load().workspaces);
}

/** Все кабинеты с подключённым ботом — нужен для long-polling режима. */
function allConnected() {
  return allWorkspaces().filter(w => w.bot && w.bot.connected && w.bot.tokenEnc);
}

/* ------------------------------------------------------------ dialogs */

function dialog(w, chatId) {
  return w.dialogs[String(chatId)] || null;
}

function upsertDialog(w, chatId, patch) {
  const key = String(chatId);
  const cur = w.dialogs[key] || {
    id: key, chatId: Number(chatId), name: '', full: '', un: '', phone: '',
    status: 'ai', stage: 'new', unread: false, ts: Date.now(), touches: 0,
    msgs: [], summary: '', interest: '', mgr: '—', note: '',
  };
  w.dialogs[key] = Object.assign(cur, patch);
  return w.dialogs[key];
}

function pushMessage(w, chatId, msg) {
  const d = upsertDialog(w, chatId, {});
  d.msgs.push(msg);
  if (d.msgs.length > 300) d.msgs = d.msgs.slice(-300);
  d.ts = msg.ts || Date.now();
  return d;
}

const genId = () => crypto.randomBytes(8).toString('hex');

module.exports = {
  get, getOrCreate, save, defaults, remove,
  findByBotId, findByWebhookSecret, bindBot, unbindBot, allConnected, allWorkspaces,
  dialog, upsertDialog, pushMessage,
  persist, persistNow, genId,
  _file: FILE,
  _reset() { db = empty(); persistNow(); },
};
