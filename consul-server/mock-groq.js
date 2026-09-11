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
const PORT = Number(process.argv[2]) || Number(process.env.MOCK_GROQ_PORT) || 8099;
const MODEL = 'mock-groq-rules';

/** Достаёт факты из блока ЗНАНИЯ системного промпта. */
function factLines(system) {
  // Именно заголовок в начале строки: слово «ЗНАНИЯХ» встречается и в правилах
  // выше, а по нему заглушка начинала выдавать клиенту куски промпта.
  const m = /^ЗНАНИЯ[ :(]/m.exec(system);   // без \b: с кириллицей он не работает
  if (!m) return [];
  const start = m.index;
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
  // Пустая строка — граница между сообщениями, как её ставит настоящая модель.
  const reply = hit
    ? hit.slice(0, 220) + (/[.?!]$/.test(hit.slice(0, 220)) ? '' : '.') + '\n\nПоказать подробнее?'
    : 'Подскажите, что именно ищете — подберу вариант и назову цену.';
  // Заглушка изображает продавца: температура, следующий шаг, возражение.
  const objection = /дорог|дешевле|подума|竞|конкурент/i.test(q) ? 'смущает цена' : '';
  const temperature = /беру|оформ|давайте|куплю|счёт/i.test(q) ? 'hot'
    : /дорог|подума|сравн/i.test(q) ? 'warm' : 'warm';
  return {
    reply, handoff: false, reason: '',
    stage: 'interested',
    interest: words.slice(0, 3).join(' '),
    summary: 'Интересуется: ' + question.slice(0, 90),
    contact: (question.match(/(\+7|8)\d{9,}/) || [''])[0],
    nextStep: 'прислать фото',
    temperature,
    objection,
  };
}

/** Реплики «клиента» по кругу — достаточно, чтобы прогнать сценарий. */
function customerTurn(system, msgs) {
  const turns = msgs.filter(m => m.role === 'assistant').length;
  const byScenario = {
    'помочь выбрать': [
      'Здравствуйте! Подскажите, что взять для гостиной?',
      'А подешевле есть что-то похожее?',
      'Понял. А чем они отличаются по свету?',
      'Ок, спасибо, подумаю.',
    ],
    'доставки': [
      'Здравствуйте, в Казань за сколько доставите?',
      'А если сегодня оплачу, когда приедет?',
      'Хорошо. Курьер до двери привезёт?',
      'Спасибо, всё понятно.',
    ],
    'скидку': [
      'Добрый день. А скидка какая-то есть?',
      'У других дешевле видел. Подвинетесь?',
      'А если возьму две штуки?',
      'Ладно, подумаю ещё.',
    ],
    'позже обещанного': [
      'Здравствуйте. Заказ обещали вчера, его до сих пор нет.',
      'И что мне теперь делать? Он нужен был к выходным.',
      'Хорошо, жду ответа сегодня.',
    ],
    'большая партия': [
      'Добрый день. Нужно 30 штук для офиса, какие условия?',
      'А счёт на юрлицо сделаете?',
      'Отлично, пришлите реквизиты.',
    ],
  };
  const key = Object.keys(byScenario).find(k => system.includes(k)) || 'помочь выбрать';
  const list = byScenario[key];
  const message = list[Math.min(turns, list.length - 1)];
  return { message, done: turns >= list.length - 1 };
}

/** Грубый разбор стиля: считаем то же, что считала бы модель. */
function styleProfile(text) {
  const replies = text.split('\n').slice(1).map(l => l.replace(/^\d+\.\s*/, '')).filter(Boolean);
  const joined = replies.join(' ');
  const avgWords = replies.length ? Math.round(joined.split(/\s+/).length / replies.length) : 0;
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined);
  const formal = /вы\b|Вы\b|пожалуйста|добрый день/i.test(joined);
  const excl = (joined.match(/!/g) || []).length;

  const traits = [];
  traits.push(avgWords < 8 ? 'очень короткие ответы' : avgWords < 20 ? 'короткие ответы' : 'развёрнутые ответы');
  traits.push(formal ? 'обращается на «вы»' : 'общается неформально');
  traits.push(hasEmoji ? 'использует смайлы' : 'без смайлов');
  if (excl > replies.length / 2) traits.push('часто ставит восклицательный знак');

  const lengthVal = avgWords < 8 ? 15 : avgWords < 20 ? 45 : 80;
  return {
    summary: 'Пишет ' + traits[0] + ', ' + traits[1] + '.',
    style: hasEmoji || excl > 1 ? 'friendly' : formal ? 'formal' : 'neutral',
    lengthVal,
    traits,
    instructions: 'Отвечай так же: ' + traits.join(', ') + '. Держи ту же длину и тот же тон.',
    examples: replies.slice(0, 3),
  };
}

const srv = http.createServer((req, res) => {
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

    let content;
    if (/посты для Telegram-канала/.test(system)) {
      content = JSON.stringify({ text: 'Привезли новое — ' + question.replace(/^Формат:.*Тема:\s*/i, '') + '.\n\nПодобрать вариант можно прямо в боте: напишите, что нужно.' });
    } else if (/Клиент перестал отвечать/.test(system)) {
      content = JSON.stringify({ text: 'Посчитал доставку — по области бесплатно. Прислать фото готовой 4х6?' });
    } else if (/Ты играешь ПОКУПАТЕЛЯ/.test(system)) {
      content = JSON.stringify(customerTurn(system, msgs));
    } else if (/готов ли бот-продавец/.test(system)) {
      // Ищем в материалах несколько обязательных тем и жалуемся на отсутствующие.
      const TOPICS = [
        [/оплат|картой|наличн/i, 'Как у вас можно оплатить?', 'Клиент спросит про способы оплаты'],
        [/доставк|привоз|самовывоз/i, 'Как происходит доставка?', 'Клиент спросит, привезёте ли вы'],
        [/гарант/i, 'Какая у вас гарантия?', 'Клиент спросит про гарантию'],
        [/возврат|обмен/i, 'Можно ли вернуть или обменять?', 'Клиент спросит про возврат'],
      ];
      const questions = TOPICS.filter(([re]) => !re.test(question)).map(([, q, why]) => ({ q, why }));
      content = JSON.stringify({ questions });
    } else if (/раскладываешь материалы компании по разделам/.test(system)) {
      content = JSON.stringify(splitSections(question));
    } else if (/разбираешь манеру письма продавца/.test(system)) {
      content = JSON.stringify(styleProfile(question));
    } else {
      content = JSON.stringify(answer(system, question));
    }

    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: Math.round(system.length / 4), completion_tokens: Math.round(content.length / 4) },
        model: MODEL,
      }));
    }, 250 + Math.random() * 350);
  });
});


/**
 * Заглушка разбора простыни на разделы. Настоящая модель режет по смыслу;
 * здесь достаточно правдоподобных границ, чтобы проверить код вокруг:
 * ищем строки-заголовки по ключевым словам и делим по ним.
 */
function splitSections(userText) {
  const lines = userText.replace(/^Текст:\n/, '').split('\n').map(l => l.replace(/^\d+\t/, ''));
  const KIND = [
    [/доставк|оплат|возврат|гарант|рассрочк/i, 'rules', 'Доставка и оплата'],
    [/вопрос|faq/i, 'faq', 'Частые вопросы'],
    [/режим работы|работаем с|контакт|адрес/i, 'text', 'О компании'],
  ];
  // Каждая найденная тема открывает свой раздел; то, что было до первой,
  // становится началом — обычно это как раз прайс.
  const marks = [];
  lines.forEach((l, i) => {
    for (const [re, kind, title] of KIND) {
      if (re.test(l) && !marks.some(m => m.kind === kind)) marks.push({ from: i + 1, kind, title });
    }
  });
  marks.sort((a, b) => a.from - b.from);
  if (!marks.length || marks[0].from > 1) {
    const priced = lines.some(l => /₽|руб|\d\s*000/.test(l));
    marks.unshift({ from: 1, kind: priced ? 'price' : 'text', title: priced ? 'Цены' : 'Материалы' });
  }
  return {
    sections: marks.map((m, i) => ({
      title: m.title, kind: m.kind, from: m.from,
      to: i === marks.length - 1 ? lines.length : marks[i + 1].from - 1,
    })),
  };
}

srv.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    // Порт занят: скорее всего, заглушка уже поднята прошлым запуском.
    // Для разработки это не ошибка — просто пользуемся тем, что работает.
    console.log('[mock-groq] порт ' + PORT + ' уже занят — использую запущенную заглушку');
    return;
  }
  console.error('[mock-groq] ' + e.message);
});

srv.listen(PORT, () => console.log('[mock-groq] http://127.0.0.1:' + PORT + '/v1 — заглушка модели, только для разработки'));

module.exports = srv;
