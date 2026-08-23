'use strict';
/* ============================================================================
 * Заглушка Groq для локальной разработки и демо без ключа.
 *
 * Поднимает OpenAI-совместимый эндпоинт и отвечает по простым правилам,
 * читая тот же системный промпт, что уходит в настоящую модель. Нужна, чтобы
 * прогнать весь путь (клиент → бот → ответ → передача менеджеру), не тратя
 * токены. В проде не используется.
 *
 *   node mock-groq.js 8099
 *   GROQ_API_KEY=dev GROQ_BASE_URL=http://127.0.0.1:8099/v1 node server.js
 * ========================================================================== */

const http = require('http');
const PORT = Number(process.argv[2]) || 8099;
const MODEL = 'mock-groq-rules';

/** Достаёт факты из блока ЗНАНИЯ системного промпта. */
function factLines(system) {
  const start = system.indexOf('ЗНАНИЯ');
  if (start < 0) return [];
  const end = system.indexOf('ФОРМАТ ОТВЕТА', start);
  return system.slice(start, end < 0 ? undefined : end)
    .split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#') && !s.startsWith('ЗНАНИЯ'));
}

function answer(system, question) {
  const q = question.toLowerCase();
  const facts = factLines(system);
  const allow = k => new RegExp(k + ': да', 'i').test(system);
  const forbid = k => new RegExp(k + ': НЕТ', 'i').test(system);

  if (/менеджер|человек|оператор|жалоб|счёт|счет|инн|юрлиц|договор/.test(q))
    return { reply: 'Секунду, подключаю менеджера — он ответит здесь же.', handoff: true, reason: 'клиент просит человека или документы', stage: 'interested', interest: '', summary: 'Нужен человек: документы или претензия.', contact: '' };

  if (/скидк|дешевле/.test(q)) {
    if (forbid('Давать скидки')) return { reply: 'Про скидку уточню у менеджера — он ответит здесь.', handoff: true, reason: 'запрос скидки', stage: 'interested', interest: 'скидка', summary: 'Просит скидку.', contact: '' };
    return { reply: 'Могу дать 5% при заказе от трёх позиций. Оформляем?', handoff: false, reason: '', stage: 'interested', interest: 'скидка', summary: 'Торгуется по цене.', contact: '' };
  }

  if (!facts.length || /ЗНАНИЯ: пусто/.test(system))
    return { reply: 'Уточню у менеджера и вернусь с ответом.', handoff: true, reason: 'нет фактов в базе знаний', stage: 'new', interest: '', summary: 'Вопрос без данных в базе.', contact: '' };

  if (forbid('ценах и наличии') && /цен|стои|сколько|есть/.test(q))
    return { reply: 'Передаю вопрос менеджеру — он назовёт цену.', handoff: true, reason: 'AI не отвечает о ценах', stage: 'interested', interest: '', summary: 'Спрашивает цену.', contact: '' };

  // ищем строку факта, пересекающуюся со словами вопроса
  const words = q.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 4);
  const hit = facts.find(f => words.some(w => f.toLowerCase().includes(w.slice(0, w.length - 1))));
  const reply = hit
    ? hit.slice(0, 220) + (/[.?!]$/.test(hit.slice(0, 220)) ? '' : '.') + ' Показать подробнее?'
    : 'Подскажите, что именно ищете — подберу вариант и назову цену.';
  return {
    reply, handoff: false, reason: '',
    stage: 'interested',
    interest: words.slice(0, 3).join(' '),
    summary: 'Интересуется: ' + question.slice(0, 90),
    contact: (question.match(/(\+7|8)\d{9,}/) || [''])[0],
  };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) {}
    const msgs = body.messages || [];
    const system = (msgs.find(m => m.role === 'system') || {}).content || '';
    const last = [...msgs].reverse().find(m => m.role === 'user');
    const question = (last && last.content) || '';

    const isPost = /посты для Telegram-канала/.test(system);
    const content = isPost
      ? JSON.stringify({ text: 'Привезли новое — ' + question.replace(/^Формат:.*Тема:\s*/i, '') + '.\n\nПодобрать вариант можно прямо в боте: напишите, что нужно.' })
      : JSON.stringify(answer(system, question));

    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: Math.round(system.length / 4), completion_tokens: Math.round(content.length / 4) },
        model: MODEL,
      }));
    }, 250 + Math.random() * 350);
  });
}).listen(PORT, () => console.log('[mock-groq] http://127.0.0.1:' + PORT + '/v1 — заглушка модели, только для разработки'));
