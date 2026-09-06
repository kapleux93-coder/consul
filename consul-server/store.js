'use strict';
/* ============================================================================
 * Хранилище Consul. Один рабочий кабинет (workspace) на владельца бота.
 *
 * Два бэкенда, выбирается сам:
 *   • Upstash Redis (REST) — когда заданы UPSTASH_REDIS_REST_URL и TOKEN.
 *     Нужен там, где нет постоянного диска: на бесплатном Render файловая
 *     система стирается при каждом перезапуске, и без внешнего хранилища
 *     владельцы теряли бы подключённых ботов.
 *   • JSON-файл рядом с сервером — локально и на VPS с диском.
 *
 * Приём один и тот же в обоих случаях: вся база держится в памяти, читается
 * один раз при старте, пишется целиком отложенно. Поэтому вызовы остаются
 * синхронными, а в Redis уходит несколько команд в минуту, а не на каждый чих —
 * это важно, чтобы влезть в бесплатные 500 тысяч команд в месяц.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CONSUL_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'store.json');

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REDIS_KEY = process.env.CONSUL_REDIS_KEY || 'consul:store';
const useRedis = !!(REDIS_URL && REDIS_TOKEN);

let db = null;
let saveTimer = null;
let writing = false;      // идёт запись в Redis
let dirtyAgain = false;   // за время записи данные снова изменились

function empty() { return { workspaces: {}, byBotId: {}, byWebhookSecret: {}, seq: 1 }; }

function normalize(obj) {
  const d = obj && typeof obj === 'object' ? obj : empty();
  for (const k of Object.keys(empty())) if (d[k] == null) d[k] = empty()[k];
  return d;
}

function load() {
  if (db) return db;
  if (useRedis) {
    // База должна быть загружена через initRemote() до первого обращения.
    // Если этого не произошло — начинаем с пустой, но громко жалуемся,
    // чтобы не затереть чужие данные молча.
    console.error('[store] обращение к Redis-хранилищу до initRemote() — начинаю с пустого');
    db = empty();
    return db;
  }
  try { db = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch (e) { db = empty(); }
  return db;
}

/* ------------------------------------------------------------ redis (REST) */

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + REDIS_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(Number(process.env.REDIS_TIMEOUT_MS) || 10000),
  });
  if (!res.ok) throw new Error('redis ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  if (data.error) throw new Error('redis: ' + data.error);
  return data.result;
}

/**
 * Читает базу из Redis в память. Вызывается один раз при старте до того,
 * как сервер начнёт принимать запросы.
 * @returns {Promise<{ok:boolean, workspaces:number, error?:string}>}
 */
async function initRemote() {
  if (!useRedis) return { ok: true, workspaces: Object.keys(load().workspaces).length, backend: 'file' };
  try {
    const raw = await redis(['GET', REDIS_KEY]);
    db = normalize(raw ? JSON.parse(raw) : null);
    return { ok: true, workspaces: Object.keys(db.workspaces).length, backend: 'redis' };
  } catch (e) {
    // Пустую базу поверх существующей не пишем: лучше упасть, чем потерять
    // чужие кабинеты из-за сетевого сбоя при старте.
    db = null;
    return { ok: false, error: e.message, backend: 'redis' };
  }
}

async function flushRedis() {
  if (!db) return;
  if (writing) { dirtyAgain = true; return; }
  writing = true;
  try {
    await redis(['SET', REDIS_KEY, JSON.stringify(db)]);
  } catch (e) {
    console.error('[store] запись в Redis не удалась:', e.message);
    dirtyAgain = true;   // попробуем на следующем сохранении
  } finally {
    writing = false;
    if (dirtyAgain) { dirtyAgain = false; setTimeout(flushRedis, 1000).unref?.(); }
  }
}

function flushFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] запись не удалась:', e.message);
  }
}

function flush() { return useRedis ? flushRedis() : flushFile(); }

/** Отложенная запись — вызывается после каждой мутации. */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, useRedis ? 700 : 200);
  if (saveTimer.unref) saveTimer.unref();
}

/** Сброс без ожидания таймера (при завершении процесса и в тестах). */
function persistNow() { clearTimeout(saveTimer); return flush(); }

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
      humanize: true,   // паузы, разбиение на реплики, ответ на очередь разом
      selling: true,    // активно продавать, а не просто отвечать на вопросы
      followUp: true,   // напомнить о себе, если клиент замолчал на середине
      followUpMin: 45,  // через сколько минут тишины
      quietFrom: 22,    // не писать первым с 22:00
      quietTo: 9,       // и до 9:00
      tzOffset: 3,      // часовой пояс бизнеса относительно UTC
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
    nextStep: '', temperature: '', objection: '', followedUp: 0,
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
  persist, persistNow, genId, initRemote,
  backend: useRedis ? 'redis' : 'file',
  _file: FILE,
  _reset() { db = empty(); persistNow(); },
};
