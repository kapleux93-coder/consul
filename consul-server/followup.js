'use strict';
/* ============================================================================
 * Возврат замолчавших клиентов.
 *
 * Больше всего сделок теряется не на возражении, а в тишине: человек спросил
 * цену, задумался и забыл. Живой продавец через час напишет одну фразу — и
 * половина этих разговоров оживает. Бот должен уметь так же.
 *
 * Но написать первым легко испортить впечатление, поэтому правил больше, чем
 * самой отправки. Пишем ОДИН раз за диалог, только если:
 *   • последним говорил бот, а клиент не ответил;
 *   • клиент не отказался и не купил;
 *   • диалог не забрал человек и AI не на паузе;
 *   • сейчас не ночь по времени бизнеса;
 *   • есть остаток дневной квоты.
 * ========================================================================== */

const groq = require('./groq');

/* Границу слова здесь нельзя задавать через \b: в JavaScript он опирается на
 * \w = [A-Za-z0-9_], поэтому перед кириллицей не срабатывает никогда. С \b оба
 * выражения молча не находили ничего, и бот напоминал о себе даже после «не надо».
 * Поэтому левую границу задаём явным lookbehind. */
const W = '[A-Za-zА-Яа-яЁё0-9]';
const phrase = list => new RegExp('(?<!' + W + ')(?:' + list.join('|') + ')', 'i');

/** Слова, после которых напоминать нельзя: человек закрыл разговор. */
const REFUSAL = phrase([
  'не надо', 'не нужно', 'не интерес', 'неинтерес', 'отказ', 'откаж',
  'спасибо, нет', 'нет, спасиб', 'передума', 'уже купил', 'уже заказал',
  'нашёл в другом', 'нашел в другом', 'отстаньте', 'не пишите', 'не беспокой',
]);

/** Клиент попросил время подумать — это не отказ, а самый частый случай для возврата. */
const THINKING = phrase([
  'подума', 'посоветую', 'посовету', 'обсуд', 'прикин', 'решу',
  'позже', 'напишу сам', 'перезвон', 'вернусь',
]);

/**
 * Час в часовом поясе бизнеса.
 * @param {number} tzOffset смещение от UTC в часах
 */
function localHour(tzOffset, now = Date.now()) {
  return Math.floor(((now / 3600000) + (Number(tzOffset) || 0)) % 24 + 24) % 24;
}

/** Сейчас тихие часы — писать первым нельзя. */
function isQuiet(ai, now = Date.now()) {
  const from = Number(ai.quietFrom), to = Number(ai.quietTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const h = localHour(ai.tzOffset, now);
  // Окно может переходить через полночь: 22 → 9.
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}

/**
 * Стоит ли напомнить о себе в этом диалоге.
 * @returns {{ok:true, minutes:number}|{ok:false, why:string}}
 */
function shouldFollowUp(w, d, now = Date.now()) {
  const ai = w.ai || {};
  if (ai.followUp === false) return { ok: false, why: 'выключено' };
  if (ai.paused) return { ok: false, why: 'AI на паузе' };
  if (d.followedUp) return { ok: false, why: 'уже напоминали' };
  if (d.status !== 'ai') return { ok: false, why: 'диалог не у бота: ' + d.status };

  const msgs = d.msgs || [];
  if (!msgs.length) return { ok: false, why: 'пустой диалог' };

  const last = msgs[msgs.length - 1];
  if (last.r !== 'ai') return { ok: false, why: 'последним говорил не бот' };

  // Клиент должен был хоть что-то сказать: на одно приветствие не напоминают.
  const fromClient = msgs.filter(m => m.r === 'user');
  if (fromClient.length < 2) return { ok: false, why: 'клиент почти ничего не написал' };

  const lastClient = fromClient[fromClient.length - 1].t || '';
  if (REFUSAL.test(lastClient)) return { ok: false, why: 'клиент отказался' };

  const minutes = (now - (last.ts || 0)) / 60000;
  const need = Number(ai.followUpMin) || 45;
  if (minutes < need) return { ok: false, why: 'ещё рано: ' + Math.round(minutes) + ' из ' + need + ' мин' };

  // Слишком старый разговор оживлять неловко.
  if (minutes > 60 * 24) return { ok: false, why: 'разговор остыл больше суток назад' };

  if (isQuiet(ai, now)) return { ok: false, why: 'тихие часы' };

  return { ok: true, minutes: Math.round(minutes), thinking: THINKING.test(lastClient) };
}

/**
 * Сочиняет напоминание: короткое, без давления, с зацепкой по сути разговора.
 * @returns {Promise<{text:string, usage:object, model:string}>}
 */
async function compose(w, d, hint = {}) {
  const tail = (d.msgs || []).slice(-8).map(m => {
    if (m.r === 'user') return 'Клиент: ' + m.t;
    if (m.r === 'sys') return null;
    return 'Вы: ' + m.t;
  }).filter(Boolean).join('\n');

  const sys = [
    `Ты продавец компании «${w.biz.name || w.bot.name || 'компания'}». Клиент перестал отвечать ` +
      Math.round(hint.minutes || 60) + ' минут назад.',
    'Напиши ОДНО короткое сообщение, чтобы вернуть его в разговор.',
    '',
    'ПРАВИЛА',
    '- Одна-две строки, не больше. Это лёгкое касание, а не второе предложение.',
    '- Зацепись за то, о чём говорили: назови конкретную вещь, которую обсуждали.',
    hint.thinking
      ? '- Клиент сказал, что подумает. Не дави: спроси, остались ли вопросы, и предложи помочь с выбором.'
      : '- Мягко предложи следующий шаг: прислать фото, посчитать, забронировать.',
    '- Без «вы ещё здесь?», «напоминаю о себе», «не потерялись?» — это звучит навязчиво.',
    '- Не повторяй цену и условия, которые уже называл.',
    '- Не выдумывай скидки, акции и дедлайны.',
    '',
    'Разговор:',
    tail,
    '',
    'Ответ — один JSON: {"text":"сообщение клиенту"}',
  ].filter(Boolean).join('\n');

  const out = await groq.chat({
    system: sys,
    messages: [{ role: 'user', content: 'Напиши напоминание.' }],
    json: true, maxTokens: 160, temperature: 0.7,
  });
  const p = groq.extractJson(out.text);
  const text = String((p && p.text) || out.text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('пустое напоминание');
  return { text: text.slice(0, 400), usage: out.usage || {}, model: out.model };
}

module.exports = { shouldFollowUp, compose, isQuiet, localHour, REFUSAL, THINKING };
