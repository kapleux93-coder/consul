'use strict';
/* ============================================================================
 * Клиент Groq (OpenAI-совместимый chat completions).
 *
 *   GROQ_API_KEY  — ключ с console.groq.com. Без него сервер поднимется, но
 *                   AI-ответы будут отключены (клиент увидит фолбэк-текст,
 *                   диалог уйдёт менеджеру).
 *   GROQ_MODEL    — модель. Если не задана или недоступна на аккаунте, берём
 *                   первую подходящую из PREFERRED по факту GET /models.
 *
 * Список моделей Groq со временем меняется, поэтому модель не зашита: при
 * старте сервер спрашивает у API, что доступно, и сам выбирает рабочую.
 * Зависимостей нет — глобальный fetch (Node 18+).
 * ========================================================================== */

/* config.js читает .env. Требуем его здесь не ради значений, а ради порядка:
 * если этот модуль загрузится раньше, ключ из .env ещё не будет в окружении,
 * enabled() навсегда вернёт false — и сервер молча начнёт передавать каждый
 * диалог человеку, как будто ключа нет. */
require('./config');

const API = () => process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const KEY = () => (process.env.GROQ_API_KEY || '').trim();
const TIMEOUT = () => Number(process.env.GROQ_TIMEOUT_MS) || 20000;

/* Порядок предпочтения: сначала то, что лучше держит инструкции и JSON. */
const PREFERRED = [
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];

let resolved = null;      // выбранная модель
let resolving = null;     // промис выбора, чтобы не гонять запрос параллельно

/* Ключ Groq один на весь сервис, а лимит у него общий и минутный. Когда он
 * исчерпан, продолжать долбиться бессмысленно: каждый кабинет потратит по
 * несколько секунд на ретраи, упрётся в тот же отказ и только продлит лимит.
 * Поэтому первый же 429 переводит весь сервис в паузу до времени, которое
 * назвал сам Groq: пока она идёт, к модели не ходим, а сразу зовём человека.
 * Так отказ становится быстрым и одинаковым для всех, а не случайным. */
let coolingUntil = 0;
const COOL_DEFAULT_MS = 20000;

/** Сколько миллисекунд осталось до конца паузы. 0 — можно работать. */
function cooling(now = Date.now()) {
  return coolingUntil > now ? coolingUntil - now : 0;
}

function coolDown(retryAfterSec) {
  const ms = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.min(retryAfterSec * 1000, 120000) : COOL_DEFAULT_MS;
  const until = Date.now() + ms;
  if (until > coolingUntil) {
    coolingUntil = until;
    console.warn('[groq] лимит исчерпан, пауза ' + Math.round(ms / 1000) + ' с — диалоги уходят менеджерам');
  }
}

const enabled = () => !!KEY();

async function request(pathname, init, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API() + pathname, Object.assign({
        signal: AbortSignal.timeout(TIMEOUT()),
      }, init, {
        headers: Object.assign({
          authorization: 'Bearer ' + KEY(),
          'content-type': 'application/json',
        }, (init && init.headers) || {}),
      }));
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : 400 * Math.pow(2, i);
        lastErr = new Error('groq ' + res.status + ' ' + (await res.text()).slice(0, 200));
        if (i < tries - 1) { await new Promise(r => setTimeout(r, waitMs)); continue; }
        // Ретраи кончились, а лимит держится: значит он не мгновенный всплеск,
        // и остальным кабинетам ходить туда сейчас незачем.
        if (res.status === 429) coolDown(ra);
        throw lastErr;
      }
      if (!res.ok) throw new Error('groq ' + res.status + ' ' + (await res.text()).slice(0, 300));
      return res.json();
    } catch (e) {
      lastErr = e;
      const retriable = e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONN|ENOTFOUND/i.test(e.message);
      if (!retriable || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/** Список id моделей, доступных этому ключу. */
async function listModels() {
  if (!enabled()) return [];
  const data = await request('/models', { method: 'GET' }, 2);
  return (data.data || []).map(m => m.id).filter(Boolean);
}

/**
 * Выбирает рабочую модель один раз за жизнь процесса.
 * Если GROQ_MODEL задана и доступна — берём её. Если задана, но недоступна —
 * громко предупреждаем и падаем на первую доступную из PREFERRED.
 */
async function model() {
  if (resolved) return resolved;
  if (!enabled()) return null;
  if (resolving) return resolving;
  resolving = (async () => {
    const want = process.env.GROQ_MODEL || '';
    let available = [];
    try {
      available = await listModels();
    } catch (e) {
      console.warn('[groq] не смог получить список моделей (' + e.message + '), беру ' + (want || PREFERRED[0]));
      resolved = want || PREFERRED[0];
      return resolved;
    }
    if (want && available.includes(want)) { resolved = want; }
    else {
      if (want) console.warn('[groq] модель "' + want + '" недоступна этому ключу — выбираю автоматически');
      resolved = PREFERRED.find(m => available.includes(m)) ||
        available.find(m => /llama|gpt|qwen|kimi|mistral/i.test(m) && !/whisper|tts|guard|vision/i.test(m)) ||
        available[0] || PREFERRED[0];
    }
    console.log('[groq] модель: ' + resolved);
    return resolved;
  })();
  return resolving;
}

/**
 * Один вызов чата.
 * @param {{system:string, messages:Array<{role:string,content:string}>, json?:boolean,
 *          maxTokens?:number, temperature?:number}} opts
 * @returns {Promise<{text:string, usage:object, model:string}>}
 */
async function chat(opts) {
  if (!enabled()) throw new Error('GROQ_API_KEY не задан');
  const left = cooling();
  if (left) throw new Error('groq 429: лимит исчерпан, до восстановления ' + Math.ceil(left / 1000) + ' с');
  const m = await model();
  const body = {
    model: m,
    messages: [{ role: 'system', content: opts.system }].concat(opts.messages || []),
    temperature: opts.temperature == null ? 0.4 : opts.temperature,
    max_tokens: opts.maxTokens || 700,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  let data;
  try {
    data = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // Некоторые модели не поддерживают json_object — повторяем без него.
    if (opts.json && /response_format|json_object/i.test(e.message)) {
      delete body.response_format;
      data = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    } else throw e;
  }
  const choice = (data.choices || [])[0] || {};
  return {
    text: (choice.message && choice.message.content) || '',
    usage: data.usage || {},
    model: data.model || m,
  };
}

/** Достаёт JSON-объект из ответа модели, даже если тот обёрнут в текст. */
function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (e) {} }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {} }
  return null;
}

module.exports = { enabled, chat, model, listModels, extractJson, cooling, PREFERRED,
  _resetCooling() { coolingUntil = 0; } };

/* --------------------------------------------------------------- CLI */
if (require.main === module && process.argv.includes('--list')) {
  (async () => {
    if (!enabled()) { console.error('GROQ_API_KEY не задан'); process.exit(1); }
    try {
      const ms = await listModels();
      console.log('Доступно моделей: ' + ms.length);
      ms.sort().forEach(m => console.log('  ' + m));
      console.log('\nБудет выбрана: ' + (await model()));
    } catch (e) { console.error('Ошибка: ' + e.message); process.exit(1); }
  })();
}
