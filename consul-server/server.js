'use strict';
/* ============================================================================
 * Consul — бэкенд Telegram mini app «AI-менеджер для вашего бота».
 * Node 18+, без внешних зависимостей.
 *
 * Что делает:
 *   • отдаёт consul.html, подставляя window.CONSUL_CONFIG (адрес API, боты);
 *   • проверяет Telegram initData (подпись платформенного бота Consul);
 *   • хранит кабинет владельца: бот, компания, настройки AI, база знаний,
 *     команда, диалоги;
 *   • принимает сообщения клиентов в бота владельца (вебхук или long polling),
 *     отвечает через Groq и передаёт диалог менеджеру, когда так решает модель
 *     или когда AI недоступен;
 *   • пушит изменения в мини-апп по SSE;
 *   • шлёт уведомления владельцу и менеджерам через платформенного бота.
 *
 * Запуск (минимум):
 *   GROQ_API_KEY=gsk_... BOT_TOKEN=<токен бота Consul> node server.js
 *
 * Переменные окружения — см. README.md
 * ========================================================================== */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const cfg = require('./config');
const store = require('./store');
const secret = require('./secret');
const groq = require('./groq');
const ai = require('./ai');
const tg = require('./telegram');
const limits = require('./limits');
const extract = require('./extract');
const backup = require('./backup');

const PORT = cfg.port;
const BOT_TOKEN = cfg.botToken;                 // платформенный бот Consul
const BOT_USERNAME = cfg.botUsername;
const PUBLIC_URL = cfg.publicUrl;
const ALLOW_INSECURE_AUTH = cfg.allowInsecureAuth;
const HTML_FILE = process.env.CONSUL_HTML || path.join(__dirname, '..', 'consul.html');
const MAX_BODY = 512 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;

/* ============================================================ утилиты */

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};
const ok = (res, obj) => json(res, 200, obj || { ok: true });
const fail = (res, code, error) => json(res, code, { ok: false, error });
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 200);
const initials = s => String(s || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '??';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('тело запроса слишком большое')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('невалидный JSON')); }
    });
    req.on('error', reject);
  });
}

/** Сырое тело запроса — для загрузки файлов. */
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('Файл больше ' + Math.round(max / 1024 / 1024) + ' МБ')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ============================================================ авторизация */

/** Проверка подписи initData по документации Telegram Web Apps. */
function verifyInitData(initData) {
  if (!initData) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  const authDate = Number(params.get('auth_date')) || 0;
  params.delete('hash');
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');

  if (!BOT_TOKEN) {
    if (!ALLOW_INSECURE_AUTH) return null;
    try { const u = JSON.parse(params.get('user') || 'null'); return u ? Object.assign({}, u, { _unverified: true }) : null; }
    catch (e) { return null; }
  }
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(dcs).digest('hex');
  let equal = false;
  try { equal = crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex')); } catch (e) { equal = false; }
  if (!equal) return null;
  // initData живёт сутки — дольше принимать незачем
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
}

/** Достаёт пользователя из заголовка/тела/квери. */
function authOf(req, body, url) {
  const raw = req.headers['x-init-data'] || (body && body.initData) || (url && url.searchParams.get('initData')) || '';
  return verifyInitData(raw);
}

/* ============================================================ SSE */

const streams = new Map();   // ownerId -> Set<res>

function sseAdd(ownerId, res) {
  const key = String(ownerId);
  if (!streams.has(key)) streams.set(key, new Set());
  streams.get(key).add(res);
}
function sseDrop(ownerId, res) {
  const set = streams.get(String(ownerId));
  if (set) { set.delete(res); if (!set.size) streams.delete(String(ownerId)); }
}
/** Отправляет один диалог вместе со счётчиками — иначе цифры на главной отстают. */
function pushDialog(w, d) { push(w.ownerId, 'dialog', { dialog: publicDialog(d), counters: w.counters, usage: w.usage }); }

function push(ownerId, event, data) {
  const set = streams.get(String(ownerId));
  if (!set || !set.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(frame); } catch (e) { set.delete(res); } }
}

/* ============================================================ вид кабинета для клиента */

/** Кабинет без секретов, в форме, которую ждёт мини-апп. */
function publicState(w) {
  return {
    onboarded: w.onboarded, step: w.step,
    bot: {
      connected: w.bot.connected, name: w.bot.name, username: w.bot.username,
      subs: w.bot.subs, tokenMask: w.bot.tokenEnc ? secret.mask(secret.decrypt(w.bot.tokenEnc)) : '',
    },
    biz: w.biz,
    ai: w.ai,
    team: w.team.map(m => ({ name: m.name, un: m.un, role: m.role, dept: m.dept, linked: !!m.tgId, code: m.tgId ? '' : m.code })),
    depts: w.depts,
    knowledge: w.knowledge.map(k => ({ id: k.id, badge: k.badge, title: k.title, meta: k.meta, kind: k.kind, ready: k.ready, chars: (k.body || '').length })),
    dialogs: Object.values(w.dialogs).sort((a, b) => b.ts - a.ts).map(publicDialog),
    counters: w.counters,
    usage: w.usage,
    ai_ready: groq.enabled(),
    mode: PUBLIC_URL ? 'webhook' : 'polling',
    notifyOk: w.notifyOk !== false,
    quota: {
      usedToday: limits.usedToday(w),
      dailyLimit: cfg.limits.dailyPerWorkspace,
      kbUsed: limits.knowledgeChars(w),
      kbLimit: cfg.limits.knowledgeChars,
    },
    links: cfg.urls,
  };
}
const publicDialog = d => ({
  id: d.id, name: d.name, full: d.full, un: d.un, phone: d.phone, status: d.status, stage: d.stage,
  unread: d.unread, ts: d.ts, touches: d.touches, interest: d.interest, summary: d.summary,
  mgr: d.mgr, note: d.note, msgs: d.msgs,
});

/* ============================================================ уведомления */

/** Кому в Telegram писать про переданный диалог: владелец + привязанные менеджеры. */
function notifyTargets(w, dept) {
  const ids = new Set();
  ids.add(Number(w.ownerId));
  w.team.filter(m => m.tgId && (!dept || !m.dept || m.dept === dept)).forEach(m => ids.add(Number(m.tgId)));
  return [...ids].filter(Boolean);
}

async function notifyHandoff(w, dialog, reason) {
  if (!BOT_TOKEN) return;
  const link = BOT_USERNAME ? `\n\nОткрыть: https://t.me/${BOT_USERNAME}?startapp=d${dialog.chatId}` : '';
  const last = (dialog.msgs.filter(m => m.r === 'user').slice(-1)[0] || {}).t || '';
  const text = `🔔 AI передал диалог\n\n${dialog.full || dialog.name}${dialog.un ? ' (@' + dialog.un + ')' : ''}\nПричина: ${reason || 'нужен человек'}\n\n«${clean(last, 300)}»${link}`;
  for (const id of notifyTargets(w)) {
    try { await tg.sendMessage(BOT_TOKEN, id, text); } catch (e) { /* пользователь мог не нажать /start */ }
  }
}

/* ============================================================ приём сообщения клиента */

const inflight = new Set();   // ключи «кабинет:чат», чтобы не отвечать дважды параллельно

async function handleIncoming(w, msg) {
  const token = secret.decrypt(w.bot.tokenEnc);
  // Без токена наружу писать нечем (так бывает в dev-имитации), но диалог всё
  // равно обрабатываем: владелец увидит его в приложении.
  /** @returns {Promise<boolean>} доставлено ли сообщение клиенту */
  const deliver = async text => {
    if (!token) return true;   // dev-имитация без бота: считаем доставленным
    try {
      await tg.sendLong(token, msg.chatId, text);
      return true;
    } catch (e) {
      // 403 — клиент заблокировал бота; chat not found — чат удалён.
      if (e.code === 403 || /bot was blocked|chat not found|user is deactivated/i.test(e.message)) {
        const d0 = store.dialog(w, msg.chatId);
        if (d0 && d0.status !== 'closed') { d0.status = 'closed'; store.save(w); pushDialog(w, d0); }
        console.warn('[tg] клиент ' + msg.chatId + ' недоступен: ' + e.message);
        return false;
      }
      if (e.code === 401) { await onTokenRevoked(w); return false; }
      throw e;
    }
  };
  const key = w.ownerId + ':' + msg.chatId;
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    // Не затираем уже известное пустыми полями: апдейт может прийти без username.
    const full = [msg.firstName, msg.lastName].filter(Boolean).join(' ') || msg.username || '';
    const patch = {};
    if (full) {
      patch.full = full;
      patch.name = msg.firstName ? msg.firstName + (msg.lastName ? ' ' + msg.lastName[0] + '.' : '') : full;
    }
    if (msg.username) patch.un = msg.username;
    if (msg.phone) patch.phone = msg.phone;
    const d = store.upsertDialog(w, msg.chatId, patch);
    if (!d.full) { d.full = 'Клиент'; d.name = 'Клиент'; }

    /* /start и прочие команды AI не обрабатывает */
    if (msg.isCommand) {
      store.pushMessage(w, msg.chatId, { r: 'user', t: msg.text, ts: msg.ts });
      if (/^\/start/.test(msg.text)) {
        const hello = w.biz.name
          ? `Здравствуйте! Это ${w.biz.name}. Напишите, что вас интересует — подскажу по товарам, ценам и доставке.`
          : 'Здравствуйте! Напишите, чем могу помочь.';
        if (await deliver(hello)) store.pushMessage(w, msg.chatId, { r: 'ai', t: hello, ts: Date.now() });
      }
      store.save(w); pushDialog(w, d);
      return;
    }

    store.pushMessage(w, msg.chatId, { r: 'user', t: msg.text, ts: msg.ts });
    d.unread = true;
    d.touches = (d.touches || 0) + 1;
    w.counters.msgs++;
    store.save(w);
    pushDialog(w, d);

    /* Диалог у человека или AI на паузе — не отвечаем, только уведомляем */
    if (d.status === 'human') return;
    if (w.ai.paused) {
      if (d.status !== 'attention') { d.status = 'attention'; store.save(w); pushDialog(w, d); }
      await notifyHandoff(w, d, 'AI на паузе');
      return;
    }

    /* Защита от флуда: клиент, шлющий сообщения очередью, не должен
       раскручивать счётчик вызовов модели. */
    if (!limits.allowChat(w.ownerId, msg.chatId)) {
      console.warn('[limit] чат ' + msg.chatId + ' превысил частоту, ответ пропущен');
      return;
    }

    /* Суточная квота: ключ Groq общий, поэтому один кабинет не должен
       выжечь его целиком. Упёрлись — зовём человека, а не молчим. */
    const quota = limits.checkAiQuota(w);
    if (!quota.ok) {
      const text = 'Сейчас передам ваш вопрос менеджеру — он ответит здесь же.';
      if (!(await deliver(text))) { store.save(w); return; }
      store.pushMessage(w, msg.chatId, { r: 'ai', t: text, ts: Date.now() });
      store.pushMessage(w, msg.chatId, { r: 'sys', t: 'Дневной лимит ответов AI исчерпан — диалог передан человеку', ts: Date.now() });
      d.status = 'attention';
      w.counters.handed++;
      store.save(w); pushDialog(w, d);
      await notifyHandoff(w, d, quota.scope === 'workspace'
        ? 'исчерпан дневной лимит ответов AI (' + quota.limit + ')'
        : 'сервис достиг общего дневного лимита ответов');
      return;
    }

    if (token) tg.sendChatAction(token, msg.chatId, 'typing');
    const t0 = Date.now();
    const r = await ai.reply(w, d, msg.text);
    const ms = Date.now() - t0;
    if (!r.fallback) limits.spendAi(w);

    d.stage = r.stage || d.stage;
    if (r.interest) d.interest = r.interest;
    if (r.summary) d.summary = r.summary;
    if (r.contact && !d.phone) d.phone = r.contact;
    w.usage.calls++;
    w.usage.tokensIn += (r.usage && r.usage.prompt_tokens) || 0;
    w.usage.tokensOut += (r.usage && r.usage.completion_tokens) || 0;
    if (r.fallback) w.usage.errors++;

    // Не доставили (клиент заблокировал бота, токен отозван) — не пишем в ленту
    // ответ, которого клиент не увидит, и не трогаем статус диалога.
    if (!(await deliver(r.reply))) { store.save(w); return; }
    store.pushMessage(w, msg.chatId, { r: 'ai', t: r.reply, ts: Date.now(), ms, model: r.model || undefined });
    w.counters.msgs++;

    if (r.handoff) {
      d.status = 'attention';
      w.counters.handed++;
      store.pushMessage(w, msg.chatId, { r: 'sys', t: 'AI передал диалог: ' + (r.reason || 'нужен человек'), ts: Date.now() });
      store.save(w);
      pushDialog(w, d);
      await notifyHandoff(w, d, r.reason);
    } else {
      d.status = 'ai';
      w.counters.byAi++;
      store.save(w);
      pushDialog(w, d);
    }
  } catch (e) {
    console.error('[incoming] ' + e.message);
  } finally {
    inflight.delete(key);
  }
}

/** Токен бота отозван в BotFather — отключаем и говорим владельцу. */
async function onTokenRevoked(w) {
  console.warn('[tg] токен бота @' + w.bot.username + ' отозван — отключаю');
  const username = w.bot.username;
  tg.stopPolling(w.bot.botId);
  store.unbindBot(w);
  store.save(w);
  push(w.ownerId, 'state', publicState(w));
  if (BOT_TOKEN) {
    await tg.sendMessage(BOT_TOKEN, Number(w.ownerId),
      '⚠️ Бот @' + username + ' отключён: Telegram больше не принимает его токен.\n\n' +
      'Скорее всего, токен отозвали в @BotFather. Откройте Consul и подключите бота заново — клиенты сейчас не получают ответов.'
    ).catch(() => {});
  }
}

/* ============================================================ платформенный бот */

/** Обрабатывает /start у бота Consul: приглашение менеджера по коду. */
async function handlePlatformUpdate(update) {
  const msg = tg.parseUpdate(update);
  if (!msg || !BOT_TOKEN) return;
  const m = msg.text.match(/^\/start\s+join_([A-Za-z0-9]+)/);
  if (!m) {
    const open = PUBLIC_URL ? '\n\nОткрыть: кнопка «Открыть Consul» в меню бота.' : '';
    if (/^\/(start|app)\b/.test(msg.text)) {
      await tg.sendMessage(BOT_TOKEN, msg.chatId,
        'Consul — AI-менеджер для вашего Telegram-бота.\n\n' +
        'Подключите своего бота, добавьте материалы о компании — и он начнёт сам отвечать клиентам, ' +
        'а сложные диалоги будет передавать вам.' + open).catch(() => {});
    } else if (/^\/help\b/.test(msg.text)) {
      await tg.sendMessage(BOT_TOKEN, msg.chatId,
        'Как это работает\n\n' +
        '1. Подключаете своего бота — токен даёт @BotFather.\n' +
        '2. Добавляете материалы: сайт, каталог, прайс, правила доставки.\n' +
        '3. Настраиваете стиль ответов и правила передачи человеку.\n' +
        '4. Клиенты пишут вашему боту — AI отвечает по вашим материалам.\n\n' +
        'Когда AI не уверен или клиент просит человека, диалог приходит вам сюда. ' +
        'Вы забираете его кнопкой Take over и отвечаете сами.').catch(() => {});
    }
    return;
  }
  const code = m[1];
  let found = null;
  for (const w of store.allWorkspaces()) {
    const member = w.team.find(x => x.code === code && !x.tgId);
    if (member) { found = { w, member }; break; }
  }
  if (!found) {
    await tg.sendMessage(BOT_TOKEN, msg.chatId, 'Ссылка-приглашение уже использована или устарела. Попросите владельца создать новую.').catch(() => {});
    return;
  }
  const { w, member } = found;
  member.tgId = msg.userId;
  member.un = msg.username || member.un;
  if (!member.name || member.name === 'Менеджер') member.name = [msg.firstName, msg.lastName].filter(Boolean).join(' ') || member.name;
  member.code = '';
  store.save(w);
  push(w.ownerId, 'state', publicState(w));
  await tg.sendMessage(BOT_TOKEN, msg.chatId,
    `Готово, ${member.name}. Вы в команде «${w.biz.name || w.bot.name}» (${member.dept}).\nБуду присылать сюда диалоги, которые AI передаёт человеку.`).catch(() => {});
  await tg.sendMessage(BOT_TOKEN, Number(w.ownerId), `✅ ${member.name} принял приглашение и получает передачи.`).catch(() => {});
}

/* ============================================================ маршруты API */

const routes = {

  /* ---- состояние ---- */
  'POST /api/state': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const myName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Владелец';
    // Владелец — всегда первый в команде: он получает передачи и подписывает ответы.
    if (!w.team.length) {
      w.team.push({ name: myName, un: user.username || '', role: 'владелец', dept: w.depts[0], tgId: user.id, code: '' });
      store.save(w);
    }
    ok(res, { ok: true, state: publicState(w), me: { id: user.id, name: myName, un: user.username || '' } });
  },

  'POST /api/onboarded': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    w.onboarded = true; w.step = 5; store.save(w);
    ok(res, { ok: true });
  },

  'POST /api/step': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    w.step = Math.max(0, Math.min(6, Number(body.step) || 0)); store.save(w);
    ok(res, { ok: true });
  },

  /* ---- бот ---- */
  'POST /api/bot/connect': async (req, res, body, user) => {
    const token = clean(body.token, 120);
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) return fail(res, 400, 'Некорректный формат токена');
    let me;
    try { me = await tg.getMe(token); }
    catch (e) {
      const unauthorized = e.code === 401 || /unauthorized|401/i.test(e.message);
      return fail(res, 400, unauthorized
        ? 'Telegram не принял этот токен. Проверьте, что скопировали его целиком из @BotFather.'
        : 'Не получилось связаться с Telegram: ' + e.message);
    }

    const w = store.getOrCreate(user.id);
    const webhookSecret = crypto.randomBytes(24).toString('hex');
    w.bot = {
      connected: true,
      name: me.first_name || 'Бот',
      username: me.username || '',
      botId: me.id,
      subs: w.bot.subs || 0,
      tokenEnc: secret.encrypt(token),
      webhookSecret,
    };
    if (!w.biz.name) w.biz.name = me.first_name || '';
    store.bindBot(w, me.id, webhookSecret);
    store.save(w);

    let mode = 'polling', warn = '';
    if (PUBLIC_URL) {
      try { await tg.setWebhook(token, `${PUBLIC_URL}/tg/${webhookSecret}`, webhookSecret); mode = 'webhook'; }
      catch (e) { warn = 'Вебхук не установился: ' + e.message + '. Включаю опрос.'; tg.startPolling(token, me.id, updateHandlerFor(w)); }
    } else {
      await tg.deleteWebhook(token);
      tg.startPolling(token, me.id, updateHandlerFor(w));
    }
    ok(res, { ok: true, bot: publicState(w).bot, mode, warn });
  },

  'POST /api/bot/disconnect': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const token = secret.decrypt(w.bot.tokenEnc);
    if (token) { await tg.deleteWebhook(token); tg.stopPolling(w.bot.botId); }
    store.unbindBot(w); store.save(w);
    ok(res, { ok: true });
  },

  /* ---- компания и настройки ---- */
  'POST /api/biz': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (body.name != null) w.biz.name = clean(body.name, 80);
    if (body.site != null) w.biz.site = clean(body.site, 200);
    if (body.about != null) w.biz.about = clean(body.about, 2000);
    store.save(w); ok(res, { ok: true, biz: w.biz });
  },

  'POST /api/ai': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const p = body.patch || body;
    const str = ['name', 'style', 'lang', 'length', 'instructions'];
    const bool = ['canProducts', 'canContacts', 'canDiscount', 'paused'];
    str.forEach(k => { if (p[k] != null) w.ai[k] = clean(p[k], k === 'instructions' ? 1200 : 40); });
    bool.forEach(k => { if (p[k] != null) w.ai[k] = !!p[k]; });
    if (p.lengthVal != null) w.ai.lengthVal = Math.max(0, Math.min(100, Number(p.lengthVal) || 0));
    if (Array.isArray(p.handoff)) w.ai.handoff = p.handoff.slice(0, 12).map(x => clean(x, 80)).filter(Boolean);
    if (Array.isArray(p.banned)) w.ai.banned = p.banned.slice(0, 12).map(x => clean(x, 80)).filter(Boolean);
    store.save(w); ok(res, { ok: true, ai: w.ai });
  },

  /* ---- команда ---- */
  'POST /api/team/invite': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (w.team.length >= 20) return fail(res, 400, 'Слишком много участников');
    const code = crypto.randomBytes(6).toString('hex');
    const member = {
      name: clean(body.name, 60) || 'Менеджер',
      un: clean(body.un, 40).replace('@', ''),
      role: w.team.length ? 'менеджер' : 'владелец',
      dept: w.depts.includes(clean(body.dept, 40)) ? clean(body.dept, 40) : w.depts[0],
      tgId: 0, code,
    };
    w.team.push(member); store.save(w);
    const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=join_${code}` : '';
    ok(res, { ok: true, team: publicState(w).team, link, code });
  },

  'POST /api/team/remove': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const i = Number(body.index);
    if (Number.isInteger(i) && w.team[i]) w.team.splice(i, 1);
    store.save(w); ok(res, { ok: true, team: publicState(w).team });
  },

  'POST /api/team/dept': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const i = Number(body.index), dept = clean(body.dept, 40);
    if (w.team[i] && w.depts.includes(dept)) w.team[i].dept = dept;
    store.save(w); ok(res, { ok: true, team: publicState(w).team });
  },

  'POST /api/depts/add': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = clean(body.name, 40);
    if (d && !w.depts.includes(d) && w.depts.length < 10) w.depts.push(d);
    store.save(w); ok(res, { ok: true, depts: w.depts });
  },

  /* ---- база знаний ---- */
  'POST /api/knowledge/add': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (w.knowledge.length >= 40) return fail(res, 400, 'Слишком много источников — удалите ненужные');
    const room = limits.checkKnowledgeRoom(w, String(body.body || '').length);
    if (!room.ok) return fail(res, 400, 'База знаний заполнена: ' + Math.round(room.limit / 1000) + ' тыс. знаков. Удалите лишнее или сократите текст.');
    const kind = ['text', 'doc', 'price', 'rules', 'faq', 'web'].includes(body.kind) ? body.kind : 'text';
    const item = {
      id: store.genId(),
      kind,
      badge: clean(body.badge, 4) || { text: 'TXT', doc: 'DOC', price: 'XLS', rules: 'DOC', faq: 'FAQ', web: 'WEB' }[kind],
      title: clean(body.title, 80) || 'Без названия',
      body: String(body.body || '').slice(0, 60000),
      meta: '',
      ready: true,
      addedAt: Date.now(),
    };
    item.meta = item.body ? `${Math.round(item.body.length / 100) / 10} тыс. знаков` : 'пусто';
    if (!item.body) { item.ready = false; item.meta = 'черновик — нет текста'; }
    w.knowledge.push(item); store.save(w);
    ok(res, { ok: true, knowledge: publicState(w).knowledge });
  },

  'POST /api/knowledge/remove': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    w.knowledge = w.knowledge.filter(k => k.id !== body.id);
    store.save(w); ok(res, { ok: true, knowledge: publicState(w).knowledge });
  },

  'POST /api/knowledge/import': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const url = clean(body.url, 300);
    if (!url) return fail(res, 400, 'Не указан адрес');
    let text = '';
    try { text = await fetchText(url); }
    catch (e) { return fail(res, 400, 'Не удалось прочитать сайт: ' + e.message); }
    if (!text) return fail(res, 400, 'На странице не нашлось текста');
    const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const exist = w.knowledge.find(k => k.kind === 'web' && k.title === host);
    const item = exist || { id: store.genId(), kind: 'web', badge: 'WEB', title: host, addedAt: Date.now() };
    item.body = text.slice(0, 60000);
    item.ready = true;
    item.meta = `${Math.round(item.body.length / 100) / 10} тыс. знаков · обновлено сейчас`;
    if (!exist) w.knowledge.push(item);
    if (!w.biz.site) w.biz.site = host;
    store.save(w);
    ok(res, { ok: true, knowledge: publicState(w).knowledge, chars: item.body.length });
  },

  /* ---- загрузка файла в базу знаний (сырое тело, имя в заголовке) ---- */
  'POST /api/knowledge/upload': async (req, res, body, user, raw) => {
    const w = store.getOrCreate(user.id);
    if (w.knowledge.length >= 40) return fail(res, 400, 'Слишком много источников — удалите ненужные');
    const filename = decodeURIComponent(String(req.headers['x-filename'] || 'file.txt')).slice(0, 120);
    if (!raw || !raw.length) return fail(res, 400, 'Пустой файл');

    let got;
    try { got = extract.extract(raw, filename); }
    catch (e) { return fail(res, 400, e.message); }

    const room = limits.checkKnowledgeRoom(w, got.text.length);
    if (!room.ok) return fail(res, 400, 'База знаний заполнена: ' + Math.round(room.limit / 1000) + ' тыс. знаков. Удалите лишнее.');

    const badge = { docx: 'DOC', xlsx: 'XLS', pdf: 'PDF', text: 'TXT', html: 'WEB' }[got.kind] || 'TXT';
    const kindMap = { docx: 'doc', xlsx: 'price', pdf: 'doc', text: 'text', html: 'web' };
    const title = clean(body && body.title, 80) || filename.replace(/\.[a-z0-9]+$/i, '');
    const item = {
      id: store.genId(),
      kind: kindMap[got.kind] || 'text',
      badge,
      title,
      body: got.text.slice(0, 120000),
      meta: Math.round(got.text.length / 100) / 10 + ' тыс. знаков · ' + filename,
      ready: true,
      addedAt: Date.now(),
    };
    w.knowledge.push(item);
    store.save(w);
    ok(res, { ok: true, knowledge: publicState(w).knowledge, chars: item.body.length, title: item.title });
  },

  /* ---- тестовый чат в онбординге ---- */
  'POST /api/ai/test': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const text = clean(body.text, 1000);
    if (!text) return fail(res, 400, 'Пустой запрос');
    const q = limits.checkAiQuota(w);
    if (!q.ok) return fail(res, 429, q.scope === 'workspace'
      ? 'Дневной лимит ответов AI исчерпан (' + q.limit + '). Обновится завтра.'
      : 'Сервис достиг общего дневного лимита ответов. Попробуйте позже.');
    if (!w.testDialog) w.testDialog = { id: 'test', msgs: [], stage: 'new', interest: '', summary: '' };
    if (body.reset) w.testDialog = { id: 'test', msgs: [], stage: 'new', interest: '', summary: '' };
    w.testDialog.msgs.push({ r: 'user', t: text, ts: Date.now() });
    const t0 = Date.now();
    const r = await ai.reply(w, w.testDialog, text);
    if (!r.fallback) limits.spendAi(w);
    w.testDialog.msgs.push({ r: 'ai', t: r.reply, ts: Date.now() });
    if (w.testDialog.msgs.length > 40) w.testDialog.msgs = w.testDialog.msgs.slice(-40);
    w.usage.calls++;
    w.usage.tokensIn += (r.usage && r.usage.prompt_tokens) || 0;
    w.usage.tokensOut += (r.usage && r.usage.completion_tokens) || 0;
    store.save(w);
    const used = ai.retrieve(w.knowledge, text, 4).map(c => c.title);
    ok(res, { ok: true, reply: r.reply, handoff: r.handoff, reason: r.reason, ms: Date.now() - t0, model: r.model, sources: used, fallback: !!r.fallback, error: r.error || '' });
  },

  /* ---- тренировка стиля: AI играет клиента, владелец отвечает как продавец ---- */
  'POST /api/style/scenarios': async (req, res, body, user) => {
    ok(res, { ok: true, scenarios: ai.SCENARIOS.map(s => ({ id: s.id, title: s.title })) });
  },

  'POST /api/style/next': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (!groq.enabled()) return fail(res, 503, 'AI не настроен: нет GROQ_API_KEY');
    const q = limits.checkAiQuota(w);
    if (!q.ok) return fail(res, 429, 'Дневной лимит обращений к AI исчерпан. Обновится завтра.');

    const history = (Array.isArray(body.history) ? body.history : []).slice(-16)
      .map(m => ({ r: m.r === 'client' ? 'client' : 'owner', t: clean(m.t, 600) }))
      .filter(m => m.t);
    try {
      const r = await ai.customerMessage(w, history, clean(body.scenario, 20));
      limits.spendAi(w);
      w.usage.calls++;
      w.usage.tokensIn += (r.usage && r.usage.prompt_tokens) || 0;
      w.usage.tokensOut += (r.usage && r.usage.completion_tokens) || 0;
      store.save(w);
      ok(res, { ok: true, message: r.message, done: r.done, scenario: { id: r.scenario.id, title: r.scenario.title } });
    } catch (e) { fail(res, 502, 'Groq: ' + e.message); }
  },

  'POST /api/style/analyze': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (!groq.enabled()) return fail(res, 503, 'AI не настроен: нет GROQ_API_KEY');
    const replies = (Array.isArray(body.replies) ? body.replies : [])
      .map(t => clean(t, 600)).filter(Boolean).slice(0, 20);
    if (replies.length < 3) return fail(res, 400, 'Нужно хотя бы три ваших ответа — по двум манеру не понять');

    const q = limits.checkAiQuota(w);
    if (!q.ok) return fail(res, 429, 'Дневной лимит обращений к AI исчерпан. Обновится завтра.');
    try {
      const profile = await ai.analyzeStyle(w, replies);
      limits.spendAi(w);
      w.usage.calls++;
      w.usage.tokensIn += (profile.usage && profile.usage.prompt_tokens) || 0;
      w.usage.tokensOut += (profile.usage && profile.usage.completion_tokens) || 0;
      delete profile.usage;
      w.ai.styleDraft = profile;          // черновик: применяется только по кнопке
      store.save(w);
      ok(res, { ok: true, profile });
    } catch (e) { fail(res, 502, e.message); }
  },

  'POST /api/style/apply': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const p = w.ai.styleDraft;
    if (!p) return fail(res, 400, 'Нечего применять — сначала пройдите тренировку');
    w.ai.styleProfile = {
      summary: p.summary, traits: p.traits, instructions: p.instructions,
      examples: p.examples, trainedAt: p.trainedAt,
    };
    if (body.applySettings !== false) {
      w.ai.style = p.style;
      w.ai.lengthVal = p.lengthVal;
      w.ai.length = p.lengthVal < 34 ? 'short' : p.lengthVal < 67 ? 'mid' : 'long';
    }
    delete w.ai.styleDraft;
    store.save(w);
    ok(res, { ok: true, ai: w.ai });
  },

  'POST /api/style/forget': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    delete w.ai.styleProfile;
    delete w.ai.styleDraft;
    store.save(w);
    ok(res, { ok: true, ai: w.ai });
  },

  /* ---- диалоги ---- */
  'POST /api/dialog/send': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = store.dialog(w, body.id);
    if (!d) return fail(res, 404, 'Диалог не найден');
    const token = secret.decrypt(w.bot.tokenEnc);
    if (!token) return fail(res, 400, 'Бот не подключён');
    const text = clean(body.text, 3500);
    if (!text) return fail(res, 400, 'Пустое сообщение');
    try { await tg.sendMessage(token, d.chatId, text); }
    catch (e) { return fail(res, 502, 'Telegram: ' + e.message); }
    const human = d.status === 'human';
    store.pushMessage(w, d.id, { r: human ? 'human' : 'ai', t: text, ts: Date.now(), who: human ? clean(body.who, 40) || 'вы' : undefined });
    w.counters.msgs++;
    store.save(w); pushDialog(w, d);
    ok(res, { ok: true, dialog: publicDialog(d) });
  },

  'POST /api/dialog/takeover': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = store.dialog(w, body.id);
    if (!d) return fail(res, 404, 'Диалог не найден');
    d.status = 'human';
    d.mgr = clean(body.who, 60) || (w.team[0] && w.team[0].name) || 'менеджер';
    store.pushMessage(w, d.id, { r: 'sys', t: 'Диалог ведёт ' + d.mgr + ' — AI на паузе', ts: Date.now() });
    d.unread = false;
    store.save(w); pushDialog(w, d);
    ok(res, { ok: true, dialog: publicDialog(d) });
  },

  'POST /api/dialog/return': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = store.dialog(w, body.id);
    if (!d) return fail(res, 404, 'Диалог не найден');
    d.status = 'ai'; d.mgr = '—';
    store.pushMessage(w, d.id, { r: 'sys', t: 'Диалог возвращён AI', ts: Date.now() });
    store.save(w); pushDialog(w, d);
    ok(res, { ok: true, dialog: publicDialog(d) });
  },

  'POST /api/dialog/read': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = store.dialog(w, body.id);
    if (d) { d.unread = false; store.save(w); }
    ok(res, { ok: true });
  },

  'POST /api/dialog/note': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const d = store.dialog(w, body.id);
    if (!d) return fail(res, 404, 'Диалог не найден');
    d.note = clean(body.note, 400);
    store.save(w); ok(res, { ok: true, dialog: publicDialog(d) });
  },

  /* ---- канал ---- */
  'POST /api/channel/post': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    if (!groq.enabled()) return fail(res, 503, 'AI не настроен: нет GROQ_API_KEY');
    const q = limits.checkAiQuota(w);
    if (!q.ok) return fail(res, 429, 'Дневной лимит обращений к AI исчерпан. Обновится завтра.');
    try {
      const r = await ai.channelPost(w, clean(body.topic, 300) || 'новость компании', clean(body.kind, 20));
      limits.spendAi(w);
      w.usage.calls++; store.save(w);
      ok(res, { ok: true, text: r.text, model: r.model });
    } catch (e) { fail(res, 502, 'Groq: ' + e.message); }
  },

  /* ---- имитация входящего сообщения: только для локальной разработки ---- */
  'POST /api/dev/incoming': async (req, res, body, user) => {
    if (!ALLOW_INSECURE_AUTH) return fail(res, 403, 'Доступно только при ALLOW_INSECURE_AUTH=1');
    const w = store.getOrCreate(user.id);
    await handleIncoming(w, {
      chatId: Number(body.chatId) || 900001,
      userId: Number(body.chatId) || 900001,
      text: clean(body.text, 1000) || 'Здравствуйте!',
      firstName: clean(body.firstName, 40) || 'Тестовый',
      lastName: clean(body.lastName, 40) || 'Клиент',
      username: clean(body.username, 40) || 'test_client',
      isCommand: /^\//.test(String(body.text || '')),
      ts: Date.now(),
    });
    ok(res, { ok: true, state: publicState(w) });
  },

  /* ---- удаление кабинета: владелец забирает свои данные из сервиса ---- */
  'POST /api/account/delete': async (req, res, body, user) => {
    const w = store.get(user.id);
    if (!w) return ok(res, { ok: true, deleted: false });
    if (String(body.confirm) !== 'УДАЛИТЬ') return fail(res, 400, 'Нужно подтверждение');

    // Сначала отвязываем бота от Telegram, иначе вебхук продолжит стучаться.
    const token = secret.decrypt(w.bot.tokenEnc);
    if (token) { try { await tg.deleteWebhook(token); } catch (e) {} }
    tg.stopPolling(w.bot.botId);

    const summary = { dialogs: Object.keys(w.dialogs || {}).length, knowledge: (w.knowledge || []).length };
    store.remove(user.id);
    push(user.id, 'state', null);
    console.log('[account] кабинет ' + user.id + ' удалён по запросу владельца');
    ok(res, { ok: true, deleted: true, summary });
  },

  /* ---- сводка для владельца сервиса (ADMIN_IDS) ---- */
  'POST /api/admin/stats': async (req, res, body, user) => {
    if (!cfg.adminIds.includes(Number(user.id))) return fail(res, 403, 'Недоступно');
    const all = store.allWorkspaces();
    const day = new Date().toISOString().slice(0, 10);
    ok(res, {
      ok: true,
      stats: {
        workspaces: all.length,
        connected: all.filter(w => w.bot && w.bot.connected).length,
        onboarded: all.filter(w => w.onboarded).length,
        dialogs: all.reduce((n, w) => n + Object.keys(w.dialogs || {}).length, 0),
        aiCallsToday: all.reduce((n, w) => n + (w.quota && w.quota.date === day ? w.quota.used : 0), 0),
        globalToday: limits._global.used,
        tokensIn: all.reduce((n, w) => n + ((w.usage && w.usage.tokensIn) || 0), 0),
        tokensOut: all.reduce((n, w) => n + ((w.usage && w.usage.tokensOut) || 0), 0),
        aiErrors: all.reduce((n, w) => n + ((w.usage && w.usage.errors) || 0), 0),
        top: all
          .map(w => ({ id: w.ownerId, bot: w.bot.username || '—', dialogs: Object.keys(w.dialogs || {}).length, calls: (w.usage && w.usage.calls) || 0 }))
          .sort((a, b) => b.calls - a.calls).slice(0, 20),
      },
    });
  },

  /* ---- можем ли мы вообще написать владельцу в Telegram ---- */
  'POST /api/notify/check': async (req, res, body, user) => {
    if (!BOT_TOKEN) return ok(res, { ok: true, reachable: false, reason: 'сервер без BOT_TOKEN' });
    const w = store.getOrCreate(user.id);
    try {
      await tg.sendChatActionStrict(BOT_TOKEN, user.id, 'typing');
      w.notifyOk = true; store.save(w);
      ok(res, { ok: true, reachable: true });
    } catch (e) {
      w.notifyOk = false; store.save(w);
      const blocked = e.code === 403 || /bot was blocked|chat not found/i.test(e.message);
      ok(res, {
        ok: true, reachable: false,
        reason: blocked
          ? 'бот не может написать вам первым — нажмите Start в @' + (BOT_USERNAME || 'боте')
          : e.message,
        link: BOT_USERNAME ? 'https://t.me/' + BOT_USERNAME : '',
      });
    }
  },

  /* ---- диагностика ---- */
  'POST /api/diag': async (req, res, body, user) => {
    const w = store.getOrCreate(user.id);
    const health = cfg.check();
    const out = {
      groq: groq.enabled(), model: null,
      botToken: !!BOT_TOKEN, publicUrl: PUBLIC_URL || null,
      mode: PUBLIC_URL ? 'webhook' : 'polling',
      knowledge: w.knowledge.length, dialogs: Object.keys(w.dialogs).length,
      usage: w.usage,
      quotaToday: limits.usedToday(w), quotaLimit: cfg.limits.dailyPerWorkspace,
      ready: health.ready, warnings: health.warnings, blocking: health.blocking,
    };
    if (groq.enabled()) { try { out.model = await groq.model(); } catch (e) { out.modelError = e.message; } }
    ok(res, { ok: true, diag: out });
  },
};

/* ---- вспомогательное: чтение страницы сайта ---- */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(/^https?:\/\//.test(url) ? url : 'https://' + url); } catch (e) { return reject(new Error('плохой адрес')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('только http(s)'));
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname)) return reject(new Error('внутренние адреса недоступны'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: 10000, headers: { 'user-agent': 'ConsulBot/1.0 (+knowledge import)' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && !fetchText._depth) {
        fetchText._depth = 1;
        return fetchText(new URL(r.headers.location, u).href).then(t => { fetchText._depth = 0; resolve(t); }, e => { fetchText._depth = 0; reject(e); });
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let size = 0; const parts = [];
      r.on('data', c => { size += c.length; if (size > 2 * 1024 * 1024) { req.destroy(); return; } parts.push(c); });
      r.on('end', () => resolve(htmlToText(Buffer.concat(parts).toString('utf8'))));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('таймаут')); });
    req.on('error', e => reject(new Error(e.message)));
  });
}
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ============================================================ маршрутизация апдейтов */

async function routeUpdate(botId, update) {
  const w = store.findByBotId(botId);
  if (!w) return;
  const msg = tg.parseUpdate(update);
  if (!msg) return;
  await handleIncoming(w, msg);
}

/* ============================================================ HTTP */

/** Фиктивный initData для локальной разработки без Telegram. */
function devInitData() {
  const p = new URLSearchParams();
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('user', JSON.stringify({ id: 1, first_name: 'Локальный', last_name: 'Разработчик', username: 'dev' }));
  p.set('hash', 'dev');
  return p.toString();
}

let htmlCache = null, htmlMtime = 0;
function serveHtml(res) {
  try {
    const st = fs.statSync(HTML_FILE);
    if (!htmlCache || st.mtimeMs !== htmlMtime || ALLOW_INSECURE_AUTH) {
      let html = fs.readFileSync(HTML_FILE, 'utf8');
      const cfg = `<script>window.CONSUL_CONFIG=${JSON.stringify({
        api: PUBLIC_URL || '',
        bot: BOT_USERNAME,
        mode: PUBLIC_URL ? 'webhook' : 'polling',
        // Только для локальной разработки: позволяет открыть мини-апп в обычном
        // браузере, без Telegram. В проде ALLOW_INSECURE_AUTH не выставляют.
        devInitData: ALLOW_INSECURE_AUTH && !BOT_TOKEN ? devInitData() : undefined,
      })};</script>`;
      html = html.replace('</head>', cfg + '\n</head>');
      htmlCache = Buffer.from(html); htmlMtime = st.mtimeMs;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': htmlCache.length, 'cache-control': 'no-cache' });
    res.end(htmlCache);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('consul.html не найден: ' + HTML_FILE);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-init-data, x-filename');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* --- вебхук бота владельца --- */
  if (req.method === 'POST' && pathname.startsWith('/tg/')) {
    const s = pathname.slice(4);
    const w = store.findByWebhookSecret(s);
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!w || (header && header !== s)) { res.writeHead(401); return res.end(); }
    res.writeHead(200); res.end();                       // отвечаем сразу, обрабатываем асинхронно
    try {
      const update = await readBody(req).catch(() => null);
      if (update) { const msg = tg.parseUpdate(update); if (msg) handleIncoming(w, msg); }
    } catch (e) { console.error('[webhook] ' + e.message); }
    return;
  }

  /* --- вебхук платформенного бота --- */
  if (req.method === 'POST' && pathname === '/tg-platform/' + (process.env.PLATFORM_WEBHOOK_SECRET || 'disabled')) {
    res.writeHead(200); res.end();
    try { const u = await readBody(req).catch(() => null); if (u) handlePlatformUpdate(u); } catch (e) {}
    return;
  }

  if (pathname === '/health') {
    return ok(res, { ok: true, uptime: Math.round(process.uptime()), groq: groq.enabled(), mode: PUBLIC_URL ? 'webhook' : 'polling', bots: tg.pollers.size });
  }

  /* --- SSE --- */
  if (req.method === 'GET' && pathname === '/api/stream') {
    const user = authOf(req, null, url);
    if (!user) { res.writeHead(401); return res.end(); }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseAdd(user.id, res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseDrop(user.id, res); });
    return;
  }

  /* --- API --- */
  if (pathname.startsWith('/api/')) {
    const key = req.method + ' ' + pathname;
    const handler = routes[key];
    if (!handler) return fail(res, 404, 'Неизвестный метод: ' + key);

    const isUpload = pathname === '/api/knowledge/upload';
    let body = {}, raw = null;
    try {
      if (isUpload) raw = await readRaw(req, MAX_UPLOAD);
      else body = await readBody(req);
    } catch (e) { return fail(res, 400, e.message); }

    const user = authOf(req, body, url);
    if (!user) return fail(res, 401, BOT_TOKEN ? 'Не удалось проверить подпись Telegram' : 'Сервер запущен без BOT_TOKEN — авторизация невозможна');

    if (!limits.allowApi(user.id)) return fail(res, 429, 'Слишком много запросов. Подождите минуту.');

    try { await handler(req, res, body, user, raw); }
    catch (e) { console.error('[api] ' + key + ': ' + e.stack); if (!res.headersSent) fail(res, 500, e.message); }
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/consul.html' || pathname === '/index.html')) return serveHtml(res);

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* ============================================================ старт */

/** Подписывает обработчик апдейтов на реакцию «токен отозван». */
function updateHandlerFor(w) {
  const fn = u => routeUpdate(w.bot.botId, u);
  fn.onRevoked = () => onTokenRevoked(store.getOrCreate(w.ownerId));
  return fn;
}

async function boot() {
  const health = cfg.report();
  if (health.fatal.length) process.exit(1);

  /* Ключ мало «задать» — его надо проверить. Иначе сервис поднимется,
     а каждый диалог будет молча уходить человеку. */
  if (groq.enabled()) {
    try {
      const models = await groq.listModels();
      if (!models.length) throw new Error('ключ принят, но список моделей пуст');
      console.log('[groq] ключ работает, модель: ' + (await groq.model()));
    } catch (e) {
      if (/401|invalid.?api.?key/i.test(e.message)) {
        console.error('\n  ✗ GROQ_API_KEY отклонён Groq: ключ недействителен.');
        console.error('    Пока это так, бот НЕ отвечает клиентам — все диалоги уходят менеджеру.');
        console.error('    Возьмите рабочий ключ на https://console.groq.com/keys\n');
      } else {
        console.warn('[groq] не удалось проверить ключ: ' + e.message + ' — попробую при первом ответе');
      }
    }
  }

  const connected = store.allConnected();
  for (const w of connected) {
    const token = secret.decrypt(w.bot.tokenEnc);
    if (!token) continue;
    if (PUBLIC_URL) {
      try { await tg.setWebhook(token, `${PUBLIC_URL}/tg/${w.bot.webhookSecret}`, w.bot.webhookSecret); }
      catch (e) {
        console.warn('[tg] вебхук для @' + w.bot.username + ': ' + e.message);
        if (e.code === 401) await onTokenRevoked(w);
      }
    } else {
      await tg.deleteWebhook(token);
      tg.startPolling(token, w.bot.botId, updateHandlerFor(w));
    }
  }
  if (BOT_TOKEN && !PUBLIC_URL) {
    await tg.deleteWebhook(BOT_TOKEN);
    tg.startPolling(BOT_TOKEN, 'platform', handlePlatformUpdate);
  } else if (BOT_TOKEN && PUBLIC_URL && process.env.PLATFORM_WEBHOOK_SECRET) {
    try { await tg.setWebhook(BOT_TOKEN, `${PUBLIC_URL}/tg-platform/${process.env.PLATFORM_WEBHOOK_SECRET}`, process.env.PLATFORM_WEBHOOK_SECRET); }
    catch (e) { console.warn('[tg] вебхук платформенного бота: ' + e.message); }
  }

  backup.schedule(store._file);

  server.listen(PORT, () => {
    console.log(`[consul] слушаю :${PORT} · режим: ${PUBLIC_URL ? 'вебхук ' + PUBLIC_URL : 'long polling'} · подключённых ботов: ${connected.length}`);
  });
}

function shutdown() {
  console.log('\n[consul] останавливаюсь…');
  tg.stopAllPolling();
  store.persistNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) boot();

module.exports = { server, verifyInitData, publicState, handleIncoming, htmlToText, routes, boot };
