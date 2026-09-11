'use strict';
/* Тест сборки промпта и отбора знаний. Сеть не трогаем: Groq тут не нужен. */
process.env.CONSUL_DATA_DIR = require('path').join(require('os').tmpdir(), 'consul-test-ai-' + process.pid);
/* Пустая строка, а не delete: groq.js подключает config.js, тот читает .env, и
 * настоящий ключ из файла разработчика снова оказался бы в окружении — тест
 * пошёл бы в сеть вместо проверки фолбэка. Заданная пустая переменная .env
 * уже не перезаписывает. */
process.env.GROQ_API_KEY = '';

const assert = require('assert');
const fs = require('fs');
const ai = require('./ai');
const store = require('./store');

let n = 0;
const t = (name, fn) => { const r = fn(); n++; console.log('  ✓ ' + name); return r; };

function workspace(patch) {
  const w = store.defaults('900');
  w.bot.name = 'Nordlight Store'; w.bot.username = 'nordlight_bot';
  w.biz = { name: 'Nordlight Store', site: 'nordlight.ru', about: 'Светильники и решения для освещения дома.' };
  w.knowledge = [
    { id: 'k1', kind: 'doc', title: 'Каталог 2026', ready: true,
      body: 'Торшер Lumen Arc — 12 400 ₽, тёплый свет, диммер. Панель Lumen Office — 3 200 ₽ за штуку, от 10 шт скидка 7%.' },
    { id: 'k2', kind: 'rules', title: 'Правила доставки', ready: true,
      body: 'Доставка по Москве бесплатно от 5 000 ₽. Казань — 490 ₽, 2–3 дня. Возврат 14 дней.' },
    { id: 'k3', kind: 'faq', title: 'Черновик FAQ', ready: false, body: 'не готово' },
  ];
  return Object.assign(w, patch || {});
}

console.log('ai / retrieve');

t('находит релевантный источник по вопросу', () => {
  const got = ai.retrieve(workspace().knowledge, 'Сколько стоит доставка в Казань?');
  assert.strictEqual(got[0].title, 'Правила доставки');
});

t('находит каталог по названию товара', () => {
  const got = ai.retrieve(workspace().knowledge, 'есть торшер для гостиной?');
  assert.strictEqual(got[0].title, 'Каталог 2026');
});

t('не отдаёт неготовые источники', () => {
  const got = ai.retrieve(workspace().knowledge, 'черновик');
  assert.ok(!got.some(c => c.title === 'Черновик FAQ'));
});

t('на пустой базе возвращает пусто', () => {
  assert.deepStrictEqual(ai.retrieve([], 'что угодно'), []);
});

t('уважает лимит по объёму', () => {
  const big = [{ id: 'b', kind: 'doc', title: 'Большой', ready: true, body: 'доставка '.repeat(5000) }];
  const got = ai.retrieve(big, 'доставка', 4, 500);
  assert.strictEqual(got.length, 0, 'кусок не влезает в бюджет и не берётся');
});

console.log('ai / systemPrompt');

t('запрещает выдумывать факты и требует JSON', () => {
  const p = ai.systemPrompt(workspace(), ai.retrieve(workspace().knowledge, 'цена'));
  assert.ok(/Не выдумывай/.test(p), 'есть запрет на выдумывание');
  assert.ok(/"handoff"/.test(p), 'описан формат JSON');
  assert.ok(/Nordlight Store/.test(p), 'подставлено название компании');
});

t('выключенные возможности попадают в промпт как запреты', () => {
  const w = workspace();
  w.ai.canDiscount = false; w.ai.canContacts = false; w.ai.canProducts = false;
  const p = ai.systemPrompt(w, []);
  assert.ok(/Давать скидки: НЕТ/.test(p));
  assert.ok(/записывать имя и телефон: НЕТ/.test(p));
  assert.ok(/ценах и наличии: НЕТ/.test(p));
});

t('включённые возможности разрешены явно', () => {
  const w = workspace(); w.ai.canDiscount = true;
  assert.ok(/Давать скидки: да/.test(ai.systemPrompt(w, [])));
});

t('правила передачи человеку переносятся дословно', () => {
  const w = workspace();
  w.ai.handoff = ['клиент просит менеджера', 'оптовый заказ от 100 штук'];
  const p = ai.systemPrompt(w, []);
  assert.ok(p.includes('оптовый заказ от 100 штук'));
});

t('запрещённые темы переносятся в промпт', () => {
  const w = workspace(); w.ai.banned = ['политика', 'конкуренты'];
  assert.ok(/Запрещённые темы.*политика; конкуренты/.test(ai.systemPrompt(w, [])));
});

t('стиль и длина влияют на инструкции', () => {
  const formal = workspace(); formal.ai.style = 'formal'; formal.ai.length = 'long';
  const p = ai.systemPrompt(formal, []);
  assert.ok(/официально-деловым/.test(p));
  assert.ok(/До 6 предложений/.test(p));
});

t('пустая база знаний = прямое указание звать человека', () => {
  const w = workspace(); w.knowledge = [];
  const p = ai.systemPrompt(w, []);
  assert.ok(/ЗНАНИЯ: пусто/.test(p));
  assert.ok(/передавай человеку/.test(p));
});

console.log('ai / круг уточнений');

t('два вопроса подряд без фактов распознаются как круг', () => {
  // ровно тот диалог, который поймал пользователь на живом боте
  const d = { msgs: [
    { r: 'user', t: 'какие размеры бань у вас есть' },
    { r: 'ai',   t: 'Какие размеры бани вас интересуют — стандартные проекты или индивидуальные?' },
    { r: 'user', t: 'Стандарт.' },
    { r: 'ai',   t: 'Уточните, пожалуйста, какие параметры вам важны: площадь, высота или количество помещений?' },
  ] };
  assert.strictEqual(ai.questionLoop(d), true);
});

t('вопрос после ответа с фактами кругом не считается', () => {
  const d = { msgs: [
    { r: 'ai', t: 'Стандартная баня 4х6 метров стоит 320 000 ₽. Показать планировку?' },
    { r: 'ai', t: 'Уточните, сколько человек будет париться?' },
  ] };
  assert.strictEqual(ai.questionLoop(d), false, 'в первом ответе была цифра — клиент что-то узнал');
});

t('один вопрос — ещё не круг', () => {
  const d = { msgs: [
    { r: 'user', t: 'есть бани?' },
    { r: 'ai', t: 'Какие размеры вас интересуют?' },
  ] };
  assert.strictEqual(ai.questionLoop(d), false);
});

t('обычные утверждения кругом не считаются', () => {
  const d = { msgs: [
    { r: 'ai', t: 'Передаю менеджеру.' },
    { r: 'ai', t: 'Он ответит здесь же.' },
  ] };
  assert.strictEqual(ai.questionLoop(d), false);
});

console.log('ai / пустая база');

t('без знаний можно поздороваться, но не сочинять факты', () => {
  // Здороваться и выяснять задачу фактов не требует — гнать человека на
  // «здравствуйте» незачем. А вот на конкретный вопрос ответа нет.
  const w = workspace(); w.knowledge = [];
  const p = ai.systemPrompt(w, []);
  assert.ok(/Поздороваться, представиться и спросить/.test(p), 'приветствие разрешено');
  assert.ok(/handoff = true/.test(p), 'на вопрос по существу зовём человека');
  assert.ok(/выдумывать нельзя/.test(p));
});

t('промпт запрещает два уточнения подряд без фактов', () => {
  const p = ai.systemPrompt(workspace(), ai.retrieve(workspace().knowledge, 'цена'));
  assert.ok(/Отвечай тем, что есть/.test(p), 'сначала ответь тем, что знаешь');
  assert.ok(/два уточняющих вопроса/.test(p), 'запрет на два подряд');
});

t('отрицательный ответ из базы — полный ответ, а не повод звать человека', () => {
  // На стенде бот отвечал «рассрочки у нас нет» — верно, по базе — и всё равно
  // передавал разговор менеджеру. Повторять это «нет» человеку незачем.
  const p = ai.systemPrompt(workspace(), ai.retrieve(workspace().knowledge, 'цена'));
  assert.ok(/ответ отрицательный, но он есть в ЗНАНИЯХ/.test(p));
  assert.ok(/повторил твоё «нет»/.test(p));
});

t('человека зовём по короткому списку, а не по любому пробелу в базе', () => {
  const p = ai.systemPrompt(workspace(), ai.retrieve(workspace().knowledge, 'цена'));
  assert.ok(/НЕ зови человека, если/.test(p), 'есть явный список, когда не звать');
  assert.ok(/просто здоровается/.test(p));
  assert.ok(/Неудобно — не причина/.test(p));
});

t('lengthKey берётся из ползунка, если length не задан', () => {
  assert.strictEqual(ai.lengthKey({ lengthVal: 20 }), 'short');
  assert.strictEqual(ai.lengthKey({ lengthVal: 50 }), 'mid');
  assert.strictEqual(ai.lengthKey({ lengthVal: 90 }), 'long');
  assert.strictEqual(ai.lengthKey({ length: 'long', lengthVal: 10 }), 'long');
});

(async () => {
  console.log('ai / фолбэк без ключа');
  const r = await ai.reply(workspace(), { msgs: [], stage: 'new' }, 'Сколько стоит торшер?');
  assert.strictEqual(r.handoff, true, 'диалог уходит человеку');
  assert.strictEqual(r.fallback, true, 'ответ помечен как фолбэк');
  assert.ok(/менеджера/.test(r.reply), 'клиент видит честную фразу');
  assert.ok(!/12 400/.test(r.reply), 'никаких придуманных цен');
  n++; console.log('  ✓ без GROQ_API_KEY не выдумывает ответ, а зовёт человека');

  console.log('ai / тренировка стиля');

  {
    // Groq отвечает 400 на сообщение без content, и владелец вместо разговора
    // с «покупателем» видит ошибку сети. Пустые реплики выбрасываем до отправки.
    const groq = require('./groq');
    const real = groq.chat;
    let sent = null;
    groq.chat = async o => { sent = o.messages; return { text: '{"message":"ок","done":false}', usage: {} }; };
    try {
      await ai.customerMessage(workspace(),
        [{ r: 'client', t: 'Привет' }, { r: 'owner', t: '' }, { r: 'client' }, { r: 'owner', t: 'Есть' }],
        ai.SCENARIOS[0].id);
    } finally { groq.chat = real; }
    assert.ok(sent, 'запрос собран');
    assert.ok(sent.every(m => m.content), 'реплик без текста не осталось: ' + JSON.stringify(sent));
    assert.strictEqual(sent.length, 2, 'пустые выброшены, остальные на месте');
    n++; console.log('  ✓ пустая реплика в истории не валит тренировку стиля');
  }

  try { fs.rmSync(process.env.CONSUL_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('ai: ' + n + ' тестов пройдено\n');
})().catch(e => { console.error('  ✗ ' + e.message); process.exit(1); });
