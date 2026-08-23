'use strict';
/* ============================================================================
 * Работа с Telegram Bot API от имени бота ВЛАДЕЛЬЦА (у каждого кабинета свой
 * токен), плюс два режима приёма сообщений:
 *
 *   • webhook  — если задан PUBLIC_URL. Telegram сам стучится на
 *                PUBLIC_URL/tg/<secret>. Так работает продакшен.
 *   • polling  — если PUBLIC_URL нет (локальная разработка). Сервер сам
 *                опрашивает getUpdates по всем подключённым ботам.
 *
 * Зависимостей нет, глобальный fetch (Node 18+).
 * ========================================================================== */

const API = 'https://api.telegram.org';
const TIMEOUT = Number(process.env.TG_TIMEOUT_MS) || 15000;

async function call(token, method, params, timeoutMs) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(timeoutMs || TIMEOUT),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error('telegram ' + method + ': ' + (data.description || res.status));
    err.code = data.error_code;
    err.retryAfter = data.parameters && data.parameters.retry_after;
    throw err;
  }
  return data.result;
}

const getMe = token => call(token, 'getMe');

/** Отправка с одной повторной попыткой на 429 (flood control). */
async function sendMessage(token, chatId, text, extra) {
  const params = Object.assign({ chat_id: chatId, text: String(text).slice(0, 4096), disable_web_page_preview: true }, extra || {});
  try {
    return await call(token, 'sendMessage', params);
  } catch (e) {
    if (e.code === 429 && e.retryAfter) {
      await new Promise(r => setTimeout(r, Math.min(e.retryAfter * 1000, 10000)));
      return call(token, 'sendMessage', params);
    }
    throw e;
  }
}

/**
 * Отправка длинного текста: Telegram режет всё, что больше 4096 символов,
 * поэтому бьём по границам абзацев и предложений.
 */
async function sendLong(token, chatId, text, extra) {
  // Через module.exports, а не напрямую: так подмена sendMessage в тестах
  // работает и для длинных сообщений — шов у модуля один.
  const send = (...a) => module.exports.sendMessage(...a);
  const LIMIT = 4000;
  const s = String(text || '');
  if (s.length <= LIMIT) return send(token, chatId, s, extra);
  const parts = [];
  let rest = s;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf('\n\n', LIMIT);
    if (cut < LIMIT * 0.5) cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT * 0.5) cut = rest.lastIndexOf('. ', LIMIT);
    if (cut < LIMIT * 0.5) cut = rest.lastIndexOf(' ', LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  let last = null;
  for (const p of parts) last = await send(token, chatId, p, extra);
  return last;
}

const sendChatAction = (token, chatId, action) =>
  call(token, 'sendChatAction', { chat_id: chatId, action: action || 'typing' }).catch(() => null);

/** То же, но с ошибкой наружу — нужно, чтобы проверить достижимость чата. */
const sendChatActionStrict = (token, chatId, action) =>
  call(token, 'sendChatAction', { chat_id: chatId, action: action || 'typing' });

const getChatMemberCount = (token, chatId) =>
  call(token, 'getChatMemberCount', { chat_id: chatId }).catch(() => 0);

async function setWebhook(token, url, secret) {
  return call(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message', 'my_chat_member'],
    drop_pending_updates: true,
  });
}
const deleteWebhook = token => call(token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => null);

/** Единый вид входящего сообщения для остального кода. */
function parseUpdate(update) {
  const m = update.message || update.edited_message;
  if (!m || !m.chat || m.chat.type !== 'private') return null;
  const from = m.from || {};
  const text = m.text || m.caption ||
    (m.photo ? '[фото]' : m.document ? '[документ: ' + ((m.document && m.document.file_name) || '') + ']' :
     m.voice ? '[голосовое сообщение]' : m.contact ? '[контакт] ' + (m.contact.phone_number || '') : '');
  if (!text) return null;
  return {
    updateId: update.update_id,
    chatId: m.chat.id,
    userId: from.id,
    text: text.slice(0, 3000),
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    username: from.username || '',
    phone: (m.contact && m.contact.phone_number) || '',
    isCommand: /^\/[a-z_]+/i.test(text),
    ts: (m.date ? m.date * 1000 : Date.now()),
  };
}

/* --------------------------------------------------------- long polling */

const pollers = new Map();   // botId -> { stop() }

/**
 * Запускает опрос getUpdates для одного бота.
 * @param {string} token
 * @param {number|string} botId
 * @param {(update:object)=>Promise<void>} onUpdate
 */
function startPolling(token, botId, onUpdate) {
  stopPolling(botId);
  let offset = 0, alive = true, backoff = 1000;
  const loop = async () => {
    while (alive) {
      try {
        const ups = await call(token, 'getUpdates', {
          offset, timeout: 25, allowed_updates: ['message', 'edited_message'],
        }, 32000);
        backoff = 1000;
        for (const u of ups) {
          offset = u.update_id + 1;
          try { await onUpdate(u); } catch (e) { console.error('[tg] обработка апдейта:', e.message); }
        }
      } catch (e) {
        if (!alive) return;
        if (e.code === 409) { console.error('[tg] конфликт getUpdates (бот уже опрашивается где-то ещё) — останавливаю polling для ' + botId); return; }
        if (e.code === 401) {
          console.error('[tg] токен отозван для ' + botId + ' — останавливаю polling');
          pollers.delete(String(botId));
          if (typeof onUpdate.onRevoked === 'function') { try { await onUpdate.onRevoked(); } catch (err) {} }
          return;
        }
        console.error('[tg] getUpdates: ' + e.message);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  };
  pollers.set(String(botId), { stop() { alive = false; } });
  loop();
}

function stopPolling(botId) {
  const p = pollers.get(String(botId));
  if (p) { p.stop(); pollers.delete(String(botId)); }
}
const stopAllPolling = () => { for (const id of [...pollers.keys()]) stopPolling(id); };

module.exports = {
  call, getMe, sendMessage, sendLong, sendChatAction, sendChatActionStrict, getChatMemberCount,
  setWebhook, deleteWebhook, parseUpdate,
  startPolling, stopPolling, stopAllPolling, pollers,
};
