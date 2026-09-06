'use strict';
/* ============================================================================
 * Поведение бота во времени — то, что отличает живого человека от машины.
 *
 * Три вещи выдают бота сильнее всего:
 *   1. Мгновенный ответ. Человек читает вопрос, думает и печатает — это секунды.
 *   2. Стена текста одним сообщением. В мессенджере пишут короткими репликами.
 *   3. Ответ на каждую строчку отдельно. Человек дочитает очередь и ответит раз.
 *
 * Здесь только про время и форму подачи. Что именно сказать — решает ai.js.
 * ========================================================================== */

/** Сколько секунд человек «читает и думает» перед ответом. */
const THINK_MIN = Number(process.env.HUMAN_THINK_MIN_MS) || 1200;
const THINK_MAX = Number(process.env.HUMAN_THINK_MAX_MS) || 2600;

/** Скорость печати: знаков в секунду. 22 — быстрый человек с телефона. */
const CHARS_PER_SEC = Number(process.env.HUMAN_CHARS_PER_SEC) || 22;

/** Потолок на одно сообщение: дольше ждать клиент не станет. */
const MAX_PER_MESSAGE = Number(process.env.HUMAN_MAX_DELAY_MS) || 7000;

/** Пауза между репликами в очереди — как будто дописывает следующую мысль. */
const BETWEEN_MIN = 600;
const BETWEEN_MAX = 1400;

/** Сколько ждать продолжения, прежде чем отвечать на очередь сообщений. */
const BURST_WINDOW = Number(process.env.HUMAN_BURST_MS) || 2500;

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * Сколько всего должно пройти от вопроса до появления сообщения.
 * @param {string} text сообщение, которое отправим
 * @param {boolean} first первое сообщение в ответе (в нём есть «чтение» вопроса)
 */
function delayFor(text, first) {
  const typing = (String(text || '').length / CHARS_PER_SEC) * 1000;
  const think = first ? rand(THINK_MIN, THINK_MAX) : rand(BETWEEN_MIN, BETWEEN_MAX);
  return Math.min(think + typing, MAX_PER_MESSAGE);
}

/**
 * Режет ответ на естественные реплики.
 *
 * Модель сама расставляет разрывы пустой строкой — там, где человек нажал бы
 * «отправить». Если разрывов нет, а текст длинный, режем по предложениям:
 * лучше две коротких реплики, чем один абзац на пять строк.
 *
 * @returns {string[]} 1–3 сообщения
 */
function split(text, maxParts = 3) {
  const t = String(text || '').trim();
  if (!t) return [];

  let parts = t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  if (parts.length === 1 && t.length > 160) {
    // Режем по границе предложения ближе к середине, чтобы куски были соразмерны.
    const sentences = t.match(/[^.!?…]+[.!?…]+(\s|$)|[^.!?…]+$/g) || [t];
    if (sentences.length > 1) {
      const target = t.length / 2;
      let acc = '', best = null, bestDiff = Infinity;
      const heads = [];
      for (const s of sentences) {
        acc += s;
        heads.push(acc.trim());
        const diff = Math.abs(acc.length - target);
        if (diff < bestDiff) { bestDiff = diff; best = acc.length; }
      }
      if (best && best < t.length) {
        parts = [t.slice(0, best).trim(), t.slice(best).trim()].filter(Boolean);
      }
    }
  }

  if (parts.length > maxParts) {
    // Лишнее склеиваем в последнюю реплику, а не выбрасываем.
    const head = parts.slice(0, maxParts - 1);
    head.push(parts.slice(maxParts - 1).join(' '));
    parts = head;
  }
  return parts;
}

/**
 * Отправляет ответ так, как это делал бы человек: с паузами и живым
 * индикатором «печатает». Индикатор в Telegram гаснет через ~5 секунд,
 * поэтому обновляем его, пока идёт пауза.
 *
 * @param {{send:(text:string)=>Promise<any>, typing:()=>void}} io
 * @param {string} text полный ответ
 * @param {number} elapsed сколько уже прошло с последнего сообщения клиента:
 *        ожидание очереди плюс работа модели. Клиент это время уже прождал,
 *        добавлять к нему полную паузу — значит отвечать через десять секунд.
 * @returns {Promise<Array<{t:string, at:number}>>} отправленные реплики со временем
 */
async function deliver(io, text, elapsed = 0) {
  const parts = split(text);
  const sent = [];
  for (let i = 0; i < parts.length; i++) {
    let wait = delayFor(parts[i], i === 0);
    if (i === 0) wait = Math.max(0, wait - elapsed);

    const until = Date.now() + wait;
    while (Date.now() < until) {
      io.typing();
      await sleep(Math.min(4000, until - Date.now()));
    }
    const ok = await io.send(parts[i]);
    if (ok === false) return sent;      // не доставлено — дальше нет смысла
    sent.push({ t: parts[i], at: Date.now() });
  }
  return sent;
}

module.exports = {
  delayFor, split, deliver, sleep,
  BURST_WINDOW,
  _limits: { THINK_MIN, THINK_MAX, CHARS_PER_SEC, MAX_PER_MESSAGE, BETWEEN_MIN, BETWEEN_MAX },
};
