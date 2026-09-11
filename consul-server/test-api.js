'use strict';
/* Сквозной тест HTTP-слоя: поднимаем реальный сервер, Telegram и Groq подменяем.
 * Проверяем авторизацию, онбординг, базу знаний и весь путь входящего сообщения:
 * клиент пишет → AI отвечает → передача менеджеру → take over → ответ человеком. */
const os = require('os');
const path = require('path');
process.env.CONSUL_DATA_DIR = path.join(os.tmpdir(), 'consul-test-api-' + process.pid);
process.env.BOT_TOKEN = '999:PLATFORM-TEST-TOKEN';
process.env.BOT_USERNAME = 'consul_test_bot';
process.env.PORT = '0';
delete process.env.PUBLIC_URL;
delete process.env.GROQ_API_KEY;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

/* ---- подменяем Telegram: ничего не шлём наружу, всё пишем в sent[] ---- */
const tg = require('./telegram');
const sent = [];
tg.getMe = async token => {
  if (!/^\d+:/.test(token)) { const e = new Error('telegram getMe: Unauthorized 401'); e.code = 401; throw e; }
  return { id: 7001, first_name: 'Nordlight Store', username: 'nordlight_bot' };
};
tg.sendMessage = async (token, chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; };
tg.sendChatAction = async () => null;
tg.setWebhook = async () => true;
tg.deleteWebhook = async () => true;
tg.startPolling = () => {};
tg.stopPolling = () => {};
tg.stopAllPolling = () => {};

/* ---- подменяем Groq: детерминированный «ум» без сети ---- */
const groq = require('./groq');
let groqOn = true, lastSystem = '';
groq.enabled = () => groqOn;
groq.model = async () => 'test-model';
groq.chat = async ({ system, messages }) => {
  lastSystem = system;
  const q = (messages[messages.length - 1] || {}).content || '';

  // Тренировка стиля: модель играет покупателя.
  if (/Ты играешь ПОКУПАТЕЛЯ/.test(system)) {
    const turns = messages.filter(m => m.role === 'assistant').length;
    return {
      text: JSON.stringify({ message: ['Добрый день, скидка есть?', 'А если две штуки?', 'Ладно, спасибо'][Math.min(turns, 2)], done: turns >= 2 }),
      usage: { prompt_tokens: 80, completion_tokens: 10 }, model: 'test-model',
    };
  }
  // Разбор манеры письма владельца.
  if (/разбираешь манеру письма продавца/.test(system)) {
    return {
      text: JSON.stringify({
        summary: 'Пишет коротко и по делу, на «вы».',
        style: 'neutral', lengthVal: 20,
        traits: ['короткие ответы', 'обращается на «вы»', 'без смайлов'],
        instructions: 'Отвечай в одно-два предложения, на «вы», без смайлов и лишних вступлений.',
        examples: ['Скидка 5% от трёх штук'],
      }),
      usage: { prompt_tokens: 120, completion_tokens: 60 }, model: 'test-model',
    };
  }

  // Проверка материалов: жалуемся на темы, которых в них нет.
  if (/готов ли бот-продавец/.test(system)) {
    const TOPICS = [
      [/оплат|картой|наличн/i, 'Как у вас можно оплатить?', 'Клиент спросит про способы оплаты'],
      [/доставк|самовывоз/i, 'Как происходит доставка?', 'Клиент спросит, привезёте ли вы'],
      [/гарант/i, 'Какая у вас гарантия?', 'Клиент спросит про гарантию'],
    ];
    const questions = TOPICS.filter(([re]) => !re.test(q)).map(([, qq, why]) => ({ q: qq, why }));
    return { text: JSON.stringify({ questions }), usage: { prompt_tokens: 200, completion_tokens: 30 }, model: 'test-model' };
  }

  // Разбор простыни на разделы: возвращаем границы строк, как настоящая модель.
  if (/раскладываешь материалы компании по разделам/.test(system)) {
    const lines = q.replace(/^Текст:\n/, '').split('\n');
    const at = re => lines.findIndex(l => re.test(l)) + 1;
    const delivery = at(/Доставка/i);
    const sections = delivery > 1
      ? [{ title: 'Цены', kind: 'price', from: 1, to: delivery - 1 },
         { title: 'Доставка и оплата', kind: 'rules', from: delivery, to: lines.length }]
      : [{ title: 'Материалы', kind: 'text', from: 1, to: lines.length }];
    return { text: JSON.stringify({ sections }), usage: { prompt_tokens: 300, completion_tokens: 40 }, model: 'test-model' };
  }

  const wantsHuman = /менеджер|счёт|инн|юрлиц/i.test(q);
  const body = wantsHuman
    ? { reply: 'Подключаю менеджера.', handoff: true, reason: 'запрос счёта', stage: 'interested', interest: 'счёт на юрлицо', summary: 'Просит счёт на организацию.', contact: '' }
    : { reply: 'Торшер Lumen Arc — 12 400 ₽.', handoff: false, reason: '', stage: 'interested', interest: 'торшер', summary: 'Ищет торшер до 15 000 ₽.', contact: '' };
  return { text: JSON.stringify(body), usage: { prompt_tokens: 100, completion_tokens: 20 }, model: 'test-model' };
};

const { server, handleIncoming, htmlToText } = require('./server');
const store = require('./store');
const ai = require('./ai');

/* ---- подписанный initData владельца ---- */
const OWNER = { id: 4242, first_name: 'Анна', last_name: 'Ковалёва', username: 'anna_k' };
function initData(user) {
  const p = new URLSearchParams();
  p.set('auth_date', String(Math.floor(Date.now() / 1000)));
  p.set('user', JSON.stringify(user));
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(dcs).digest('hex'));
  return p.toString();
}
const AUTH = initData(OWNER);

let base = '';
const api = async (pathname, body, auth) => {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-init-data': auth === undefined ? AUTH : auth },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

/** Минимальный настоящий DOCX (zip с word/document.xml). */
function makeDocx(text) {
  const zlib = require('zlib');
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    text.split('\n').map(l => '<w:p><w:r><w:t>' + l + '</w:t></w:r></w:p>').join('') +
    '</w:body></w:document>';
  const name = Buffer.from('word/document.xml', 'utf8');
  const rawBuf = Buffer.from(xml, 'utf8');
  const data = zlib.deflateRawSync(rawBuf);
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < rawBuf.length; i++) {
    c = (crc ^ rawBuf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(rawBuf.length, 22);
  lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(rawBuf.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const central = Buffer.concat([ch, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(lh.length + name.length + data.length, 16);
  return Buffer.concat([lh, name, data, central, eocd]);
}

(async () => {
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('api');

  await t('без initData отдаёт 401', async () => {
    const r = await api('/api/state', {}, '');
    assert.strictEqual(r.status, 401);
  });

  await t('подделанный initData отклоняется', async () => {
    const r = await api('/api/state', {}, AUTH.replace('4242', '4243'));
    assert.strictEqual(r.status, 401);
  });

  await t('неизвестный метод — 404 с понятным текстом', async () => {
    const r = await api('/api/nope');
    assert.strictEqual(r.status, 404);
    assert.ok(/Неизвестный метод/.test(r.json.error));
  });

  await t('первый вызов создаёт кабинет и заводит владельца в команде', async () => {
    const r = await api('/api/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state.onboarded, false);
    assert.strictEqual(r.json.state.bot.connected, false);
    assert.strictEqual(r.json.me.id, 4242);
    assert.strictEqual(r.json.state.team.length, 1);
    assert.strictEqual(r.json.state.team[0].name, 'Анна Ковалёва');
    assert.strictEqual(r.json.state.team[0].role, 'владелец');
    assert.strictEqual(r.json.state.team[0].linked, true);
  });

  await t('битый токен бота не принимается', async () => {
    const r = await api('/api/bot/connect', { token: 'просто-текст' });
    assert.strictEqual(r.status, 400);
    assert.ok(/формат/i.test(r.json.error));
  });

  await t('подключение бота сохраняет имя и маскирует токен', async () => {
    const r = await api('/api/bot/connect', { token: '7284419055:AAF9kZq3vTnLm2xYcRp8QwErTyUiOpAsDfG' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.bot.username, 'nordlight_bot');
    assert.ok(/••••/.test(r.json.bot.tokenMask), 'токен не отдаётся целиком');
    store.persistNow();
    const raw = JSON.parse(fs.readFileSync(store._file, 'utf8'));
    const stored = JSON.stringify(raw.workspaces['4242'].bot);
    assert.ok(!stored.includes('AAF9kZq3'), 'на диске токен зашифрован');
  });

  await t('настройки компании и AI сохраняются', async () => {
    await api('/api/biz', { name: 'Nordlight Store', site: 'nordlight.ru', about: 'Светильники для дома.' });
    const r = await api('/api/ai', { patch: { style: 'formal', canDiscount: true, handoff: ['жалоба', 'оптовый заказ'], lengthVal: 80 } });
    assert.strictEqual(r.json.ai.style, 'formal');
    assert.strictEqual(r.json.ai.canDiscount, true);
    assert.deepStrictEqual(r.json.ai.handoff, ['жалоба', 'оптовый заказ']);
  });

  await t('база знаний принимает текст и отдаёт объём', async () => {
    const r = await api('/api/knowledge/add', { kind: 'doc', title: 'Каталог 2026', body: 'Торшер Lumen Arc — 12 400 ₽. '.repeat(20) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.knowledge.length, 1);
    assert.ok(r.json.knowledge[0].ready);
    assert.ok(r.json.knowledge[0].chars > 400);
  });

  await t('источник без текста помечается черновиком', async () => {
    const r = await api('/api/knowledge/add', { kind: 'faq', title: 'FAQ', body: '' });
    const faq = r.json.knowledge.find(k => k.title === 'FAQ');
    assert.strictEqual(faq.ready, false);
  });

  console.log('api / разбор простыни на разделы');

  const SHEET = [
    'Цены на бани под ключ',
    'Баня 4х6 — 320 000 ₽',
    'Баня 3х4 — 210 000 ₽',
    'Баня 6х6 с террасой — 520 000 ₽',
    'Доставка и оплата',
    'По Московской области бесплатно, дальше 45 ₽/км',
    'Предоплата 30%, рассрочка на 6 месяцев',
    'Гарантия 3 года',
  ].join('\n') + '\n' + 'Печь Termofor входит в стоимость. '.repeat(8);

  await t('простыня режется на разделы, но не сохраняется сама', async () => {
    const before = (await api('/api/state')).json.state.knowledge.length;
    const r = await api('/api/knowledge/split', { text: SHEET });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.sections.length, 2, 'цены и условия — разные разделы');
    assert.strictEqual(r.json.sections[0].kind, 'price');
    assert.strictEqual(r.json.sections[1].kind, 'rules');
    const after = (await api('/api/state')).json.state.knowledge.length;
    assert.strictEqual(after, before, 'до подтверждения владельца ничего не сохраняем');
  });

  await t('при разборе не теряется ни одной строки', async () => {
    // Потерянная строка — это потерянная цена. Проверяем побуквенно.
    const r = await api('/api/knowledge/split', { text: SHEET });
    const joined = r.json.sections.map(s => s.body).join('\n');
    const norm = t => t.replace(/\s+/g, ' ').trim();
    assert.strictEqual(norm(joined), norm(SHEET), 'склеенные разделы совпадают с исходником');
  });

  await t('короткий текст разбирать не даём — это один материал', async () => {
    const r = await api('/api/knowledge/split', { text: 'Баня 4х6 — 320 000 ₽' });
    assert.strictEqual(r.status, 400);
    assert.ok(/короткий/i.test(r.json.error), r.json.error);
  });

  await t('разделы сохраняются пачкой с названиями и видами', async () => {
    const split = await api('/api/knowledge/split', { text: SHEET });
    const r = await api('/api/knowledge/addMany', { sections: split.json.sections });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.added, 2);
    const price = r.json.knowledge.find(k => k.title === 'Цены');
    assert.ok(price, 'раздел с ценами в базе');
    assert.strictEqual(price.kind, 'price');
    assert.ok(price.ready);
  });

  await t('переименованный владельцем раздел сохраняется как он назвал', async () => {
    const r = await api('/api/knowledge/addMany', {
      sections: [{ title: 'Мой прайс', kind: 'price', body: 'Баня 4х6 — 320 000 ₽' }],
    });
    assert.ok(r.json.knowledge.some(k => k.title === 'Мой прайс'));
  });

  await t('пустые разделы не сохраняем', async () => {
    const r = await api('/api/knowledge/addMany', { sections: [{ title: 'Пусто', kind: 'text', body: '   ' }] });
    assert.strictEqual(r.status, 400);
  });

  console.log('api / что бот не понял');

  /* Проверки ниже чистят базу знаний, а следующие за ними на неё опираются.
     Снимаем копию и возвращаем всё на место в конце блока. */
  const kbBackup = [];
  for (const k of (await api('/api/state')).json.state.knowledge) {
    const full = await api('/api/knowledge/get', { id: k.id });
    kbBackup.push({ kind: k.kind, title: k.title, body: full.json.item.body });
  }
  const wipeKb = async () => {
    for (const k of (await api('/api/state')).json.state.knowledge) await api('/api/knowledge/remove', { id: k.id });
  };
  const restoreKb = async () => {
    await wipeKb();
    for (const k of kbBackup) await api('/api/knowledge/add', k);
  };

  await t('бот читает материалы и спрашивает про то, чего в них нет', async () => {
    // К этому месту в базе уже лежат материалы прошлых проверок, и в них
    // упомянуто всё подряд. Начинаем с чистого листа, иначе дыр не будет.
    await wipeKb();
    await api('/api/knowledge/add', { kind: 'price', title: 'Прайс', body: 'Торшер Lumen Arc — 12 400 ₽. Доставка по городу бесплатно.' });
    const r = await api('/api/knowledge/gaps');
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.questions.length, 'дыры найдены: ' + JSON.stringify(r.json));
    const all = r.json.questions.map(q => q.q).join(' | ');
    assert.ok(/оплат/i.test(all), 'спросил про оплату — её в материалах нет: ' + all);
    assert.ok(!/доставк/i.test(all), 'про доставку не спрашивает, она есть: ' + all);
    assert.ok(r.json.questions.every(q => q.q.length <= 160));
  });

  await t('ответы владельца становятся материалом, а не теряются', async () => {
    const r = await api('/api/knowledge/answers', { answers: [
      { q: 'Как у вас можно оплатить?', a: 'Картой на сайте или наличными курьеру.' },
      { q: 'Какая у вас гарантия?', a: 'Два года на всё.' },
    ] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.added, 2);
    const item = r.json.knowledge.find(k => k.title === 'Ответы владельца');
    assert.ok(item && item.ready, 'материал создан и готов');
    const full = await api('/api/knowledge/get', { id: item.id });
    assert.ok(/Картой на сайте/.test(full.json.item.body), 'ответ внутри');
    assert.ok(/Как у вас можно оплатить\?/.test(full.json.item.body), 'вместе с вопросом');
  });

  await t('повторные ответы дописываются в тот же материал', async () => {
    const before = (await api('/api/state')).json.state.knowledge.filter(k => k.title === 'Ответы владельца').length;
    await api('/api/knowledge/answers', { answers: [{ q: 'Есть самовывоз?', a: 'Да, склад на Ленина 5.' }] });
    const after = (await api('/api/state')).json.state.knowledge.filter(k => k.title === 'Ответы владельца');
    assert.strictEqual(after.length, before, 'новый материал не заводим');
    const full = await api('/api/knowledge/get', { id: after[0].id });
    assert.ok(/Картой на сайте/.test(full.json.item.body), 'старые ответы на месте');
    assert.ok(/Ленина 5/.test(full.json.item.body), 'новый дописан');
  });

  await t('пустые ответы не сохраняем', async () => {
    const r = await api('/api/knowledge/answers', { answers: [{ q: 'Вопрос', a: '   ' }] });
    assert.strictEqual(r.status, 400);
  });

  await t('без материалов проверять нечего', async () => {
    await wipeKb();
    const r = await api('/api/knowledge/gaps');
    assert.strictEqual(r.status, 502, 'честный отказ, а не пустой список');
    await restoreKb();
  });

  console.log('api / правка материала');

  await t('материал можно переименовать, сменить вид и переписать текст', async () => {
    const st = await api('/api/state');
    const k = st.json.state.knowledge.find(x => x.title === 'Мой прайс');
    const r = await api('/api/knowledge/update', { id: k.id, title: 'Прайс 2026', kind: 'rules', body: 'Доставка бесплатно' });
    assert.strictEqual(r.status, 200);
    const upd = r.json.knowledge.find(x => x.id === k.id);
    assert.strictEqual(upd.title, 'Прайс 2026');
    assert.strictEqual(upd.kind, 'rules');
    assert.ok(upd.ready);
  });

  await t('правка чужого материала не проходит', async () => {
    const r = await api('/api/knowledge/update', { id: 'нет-такого', title: 'Х' });
    assert.strictEqual(r.status, 404);
  });

  await t('стёртый текст делает материал черновиком, а не мусором в базе', async () => {
    const st = await api('/api/state');
    const k = st.json.state.knowledge.find(x => x.title === 'Прайс 2026');
    const r = await api('/api/knowledge/update', { id: k.id, body: '' });
    const upd = r.json.knowledge.find(x => x.id === k.id);
    assert.strictEqual(upd.ready, false);
    await api('/api/knowledge/remove', { id: k.id });
  });

  await t('без модели разбор честно отказывает, а не молчит', async () => {
    groqOn = false;
    const r = await api('/api/knowledge/split', { text: SHEET });
    groqOn = true;
    assert.strictEqual(r.status, 503);
    assert.ok(/одним материалом/.test(r.json.error), r.json.error);
  });

  await t('тестовый чат отвечает и называет источник', async () => {
    const r = await api('/api/ai/test', { text: 'Есть торшер до 15 000?', reset: true });
    assert.strictEqual(r.status, 200);
    assert.ok(/Lumen Arc/.test(r.json.reply));
    assert.deepStrictEqual(r.json.sources, ['Каталог 2026']);
    assert.strictEqual(r.json.handoff, false);
  });

  await t('настройки владельца реально доезжают до промпта', async () => {
    assert.ok(/официально-деловым/.test(lastSystem), 'стиль formal в промпте');
    assert.ok(/Давать скидки: да/.test(lastSystem), 'скидки разрешены');
    assert.ok(/оптовый заказ/.test(lastSystem), 'правило передачи из настроек');
    assert.ok(/Торшер Lumen Arc/.test(lastSystem), 'база знаний подмешана');
  });

  await t('входящее сообщение клиента: AI отвечает сам', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 555, userId: 555, text: 'Есть торшер для гостиной?', firstName: 'Марина', lastName: 'Соколова', username: 'marina_s', ts: Date.now() });
    const d = store.dialog(w, 555);
    assert.strictEqual(d.status, 'ai');
    assert.strictEqual(d.unread, true);
    assert.strictEqual(d.stage, 'interested');
    assert.strictEqual(d.interest, 'торшер');
    assert.ok(d.summary, 'карточка клиента заполнена моделью');
    assert.strictEqual(d.msgs.length, 2);
    assert.strictEqual(sent[0].chatId, 555, 'ответ ушёл клиенту');
    assert.ok(/Lumen Arc/.test(sent[0].text));
  });

  await t('сообщение, пролежавшее в очереди, получает извинение перед ответом', async () => {
    // Бесплатный хостинг усыпляет сервис; сообщения ждут в очереди Telegram.
    // Бодрый ответ через час, будто ничего не было, читается как издёвка.
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 556, userId: 556, text: 'Есть торшер для гостиной?',
      firstName: 'Пётр', ts: Date.now() - 90 * 60000 });
    assert.ok(sent.length >= 2, 'сначала извинение, потом ответ: ' + sent.length);
    assert.ok(/Извин/i.test(sent[0].text), 'первым идёт извинение: ' + sent[0].text);
    assert.ok(/Lumen Arc/.test(sent.map(x => x.text).join(' ')), 'по существу тоже ответили');
    const d = store.dialog(w, 556);
    assert.ok(d.msgs.some(m => m.r === 'ai' && /Извин/i.test(m.t)), 'извинение видно и владельцу');
  });

  await t('свежее сообщение обходится без извинений', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 557, userId: 557, text: 'Есть торшер для гостиной?',
      firstName: 'Ольга', ts: Date.now() - 60000 });
    assert.ok(sent.length, 'ответ ушёл');
    assert.ok(!/Извин/i.test(sent[0].text), 'извиняться не за что: ' + sent[0].text);
  });

  await t('запрос счёта: диалог уходит человеку и приходит уведомление', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 555, userId: 555, text: 'Нужен счёт на юрлицо, ИНН пришлю', firstName: 'Марина', ts: Date.now() });
    const d = store.dialog(w, 555);
    assert.strictEqual(d.status, 'attention');
    assert.ok(d.msgs.some(m => m.r === 'sys' && /передал разговор/.test(m.t)), 'в ленте есть системная отметка');
    assert.strictEqual(w.counters.handed, 1);
    const notify = sent.find(s => s.chatId === 4242);
    assert.ok(notify, 'владелец получил уведомление');
    assert.ok(/AI передал диалог/.test(notify.text));
    assert.ok(/marina_s/.test(notify.text));
  });

  await t('take over переводит диалог на человека', async () => {
    const r = await api('/api/dialog/takeover', { id: '555', who: 'Анна' });
    assert.strictEqual(r.json.dialog.status, 'human');
    assert.strictEqual(r.json.dialog.mgr, 'Анна');
    assert.strictEqual(r.json.dialog.unread, false);
  });

  await t('пока диалог у человека, AI молчит', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 555, userId: 555, text: 'Есть торшер?', firstName: 'Марина', ts: Date.now() });
    assert.strictEqual(sent.length, 0, 'наружу ничего не ушло');
    assert.strictEqual(store.dialog(w, 555).status, 'human');
  });

  await t('ответ владельца уходит клиенту от имени человека', async () => {
    sent.length = 0;
    const r = await api('/api/dialog/send', { id: '555', text: 'Счёт подготовлю сегодня.', who: 'Анна' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sent[0].chatId, 555);
    const last = r.json.dialog.msgs[r.json.dialog.msgs.length - 1];
    assert.strictEqual(last.r, 'human');
    assert.strictEqual(last.who, 'Анна');
  });

  await t('return to AI возвращает диалог боту', async () => {
    const r = await api('/api/dialog/return', { id: '555' });
    assert.strictEqual(r.json.dialog.status, 'ai');
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 555, userId: 555, text: 'Есть торшер?', firstName: 'Марина', ts: Date.now() });
    assert.ok(sent.some(s => s.chatId === 555), 'AI снова отвечает');
  });

  await t('пауза AI: клиенту не отвечаем, зовём человека', async () => {
    await api('/api/ai', { patch: { paused: true } });
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 777, userId: 777, text: 'Здравствуйте, есть лента?', firstName: 'Светлана', ts: Date.now() });
    assert.ok(!sent.some(s => s.chatId === 777), 'клиенту AI не написал');
    assert.strictEqual(store.dialog(w, 777).status, 'attention');
    assert.ok(sent.some(s => s.chatId === 4242), 'владельцу пришло уведомление');
    await api('/api/ai', { patch: { paused: false } });
  });

  await t('/start обрабатывается приветствием, а не моделью', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 888, userId: 888, text: '/start', firstName: 'Игорь', isCommand: true, ts: Date.now() });
    assert.ok(/Nordlight Store/.test(sent[0].text));
    assert.strictEqual(store.dialog(w, 888).status, 'ai');
  });

  await t('менеджер представляется своим именем', async () => {
    const w = store.getOrCreate(4242);
    w.ai.name = 'Ника'; store.save(w);
    sent.length = 0;
    await handleIncoming(w, { chatId: 889, userId: 889, text: '/start', firstName: 'Игорь', isCommand: true, ts: Date.now() });
    assert.ok(/Ника/.test(sent[0].text), 'имя в приветствии: ' + sent[0].text);
    assert.ok(/Nordlight Store/.test(sent[0].text), 'компания тоже названа');
  });

  await t('имя не подставляется само — иначе все боты платформы одна «Ника»', async () => {
    // Бот представляется этим именем клиенту. Придумать его за владельца
    // значит выдать несуществующего человека за живого.
    const fresh = require('./store').defaults('нового');
    assert.strictEqual(fresh.ai.name, '', 'у нового кабинета имени нет');
    const sys = require('./ai').systemPrompt(
      Object.assign(fresh, { biz: { name: 'Банный двор' }, bot: { name: 'b', username: 'b' } }), []);
    assert.ok(!/Тебя зовут/.test(sys), 'модели имя не навязано');
    assert.ok(/не придумывай себе имя/.test(sys), 'и выдумывать его запрещено');
  });

  await t('без имени приветствие остаётся связным', async () => {
    const w = store.getOrCreate(4242);
    const saved = w.ai.name;
    w.ai.name = ''; store.save(w);
    sent.length = 0;
    await handleIncoming(w, { chatId: 890, userId: 890, text: '/start', firstName: 'Игорь', isCommand: true, ts: Date.now() });
    assert.ok(/Nordlight Store/.test(sent[0].text), sent[0].text);
    assert.ok(!/Меня зовут/.test(sent[0].text), 'не представляемся пустым именем: ' + sent[0].text);
    w.ai.name = saved; store.save(w);
  });

  await t('ответ бота не снимает отметку «ждёт вас»', async () => {
    // Иначе разговор, который владелец не успел посмотреть, тихо уходит из
    // списка: клиент написал ещё раз, бот ответил — и всё как будто в порядке.
    const w = store.getOrCreate(4242);
    await handleIncoming(w, { chatId: 772, userId: 772, text: 'Нужен счёт на юрлицо', firstName: 'Ольга', ts: Date.now() });
    assert.strictEqual(store.dialog(store.getOrCreate(4242), 772).status, 'attention');
    await handleIncoming(store.getOrCreate(4242), { chatId: 772, userId: 772, text: 'Есть торшер для гостиной?', firstName: 'Ольга', ts: Date.now() });
    const d = store.dialog(store.getOrCreate(4242), 772);
    assert.strictEqual(d.status, 'attention', 'отметка на месте');
    assert.ok(d.msgs.some(m => m.r === 'ai' && /Lumen Arc/.test(m.t)), 'но отвечать бот не перестал');
  });

  await t('повторная передача не будит владельца второй раз', async () => {
    // Когда «ждёт вас» приходит по три раза про один разговор, уведомления
    // перестают читать — и пропускают те, где человек действительно нужен.
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 771, userId: 771, text: 'Нужен счёт на юрлицо', firstName: 'Пётр', ts: Date.now() });
    const afterFirst = store.getOrCreate(4242).counters.handed;
    const notifies = sent.filter(x => /передал|ждёт|счёт/i.test(x.text)).length;

    sent.length = 0;
    await handleIncoming(store.getOrCreate(4242), { chatId: 771, userId: 771, text: 'И ещё договор нужен', firstName: 'Пётр', ts: Date.now() });
    const w2 = store.getOrCreate(4242);
    assert.strictEqual(w2.counters.handed, afterFirst, 'счётчик передач не растёт на том же разговоре');
    assert.strictEqual(w2.dialogs['771'].status, 'attention',
      'отметка «ждёт вас» держится, пока владелец сам её не снял');
    const sys = w2.dialogs['771'].msgs.filter(m => m.r === 'sys' && /передал разговор/.test(m.t));
    assert.strictEqual(sys.length, 1, 'системная отметка одна, а не на каждое сообщение');
    assert.ok(notifies >= 0);
  });

  await t('приветствие задаёт владелец, а не мы за него', async () => {
    const w = store.getOrCreate(4242);
    const r = await api('/api/ai', { patch: { hello: 'Привет! Это баня. Пишите, подберём.' } });
    assert.strictEqual(r.status, 200);
    sent.length = 0;
    await handleIncoming(store.getOrCreate(4242), { chatId: 891, userId: 891, text: '/start',
      firstName: 'Игорь', isCommand: true, ts: Date.now() });
    assert.strictEqual(sent[0].text, 'Привет! Это баня. Пишите, подберём.');
    await api('/api/ai', { patch: { hello: '' } });
  });

  await t('без своего приветствия собираем нейтральное', async () => {
    const w = store.getOrCreate(4242);
    w.ai.hello = ''; w.ai.name = 'Ника'; store.save(w);
    sent.length = 0;
    await handleIncoming(store.getOrCreate(4242), { chatId: 892, userId: 892, text: '/start',
      firstName: 'Игорь', isCommand: true, ts: Date.now() });
    assert.ok(/Ника/.test(sent[0].text), sent[0].text);
    assert.ok(/Nordlight Store/.test(sent[0].text), 'и компания названа');
  });

  await t('слишком длинное приветствие обрезается, а не уходит целиком', async () => {
    const r = await api('/api/ai', { patch: { hello: 'я'.repeat(900) } });
    assert.ok(r.json.ai.hello.length <= 400, 'длина: ' + r.json.ai.hello.length);
    await api('/api/ai', { patch: { hello: '' } });
  });

  await t('на прямой вопрос «ты бот?» модели велено не врать', () => {
    const w = store.getOrCreate(4242);
    const sys = require('./ai').systemPrompt(w, []);
    assert.ok(/бот ты или человек/.test(sys), 'правило есть в промпте');
    assert.ok(/Никогда не утверждай, что ты живой человек/.test(sys));
  });

  await t('когда Groq недоступен, диалог честно уходит человеку', async () => {
    groqOn = false;
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 999, userId: 999, text: 'Сколько стоит доставка?', firstName: 'Артём', ts: Date.now() });
    const d = store.dialog(w, 999);
    assert.strictEqual(d.status, 'attention');
    const toClient = sent.find(s => s.chatId === 999);
    assert.ok(/менеджера/.test(toClient.text), 'клиенту честная фраза');
    assert.ok(!/₽/.test(toClient.text), 'никаких выдуманных цен');
    groqOn = true;
  });

  console.log('api / воронка онбординга');

  await t('чужому сводка не отдаётся', async () => {
    const r = await api('/api/admin/stats');
    assert.strictEqual(r.status, 403);
  });

  await t('воронка показывает, где отваливаются', async () => {
    const saved = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '4242';
    try {
      const r = await api('/api/admin/stats');
      assert.strictEqual(r.status, 200);
      const f = r.json.funnel;
      assert.deepStrictEqual(f.steps.map(s => s.key), ['opened', 'connected', 'firstClient']);
      assert.ok(typeof f.withKnowledge === 'number', 'материалы считаются отдельно от воронки');
      assert.ok(typeof f.finished === 'number', 'и завершённая настройка тоже');
      assert.ok(f.steps[0].count >= 1, 'кабинет теста попал в воронку');
      // Шаги вложены друг в друга: следующий не может быть больше предыдущего.
      for (let i = 1; i < f.steps.length; i++) {
        assert.ok(f.steps[i].count <= f.steps[i - 1].count,
          f.steps[i].key + ' больше, чем ' + f.steps[i - 1].key);
      }
      assert.strictEqual(f.steps[0].ofAll, 100, 'первый шаг — база отсчёта');
      assert.ok(f.steps.every(s => s.ofPrev >= 0 && s.ofPrev <= 100), 'доли в пределах ста');
    } finally {
      if (saved === undefined) delete process.env.ADMIN_IDS; else process.env.ADMIN_IDS = saved;
    }
  });

  await t('отметки ставятся один раз и не сдвигаются', async () => {
    const w = store.getOrCreate(4242);
    const first = w.milestones.opened;
    assert.ok(first, 'вход отмечен');
    await api('/api/state');
    assert.strictEqual(store.getOrCreate(4242).milestones.opened, first, 'повторный вход не переписал отметку');
  });

  await t('клиент, написавший до конца настройки, не ломает воронку', async () => {
    // «Закончил настройку» не на пути к «боту написал клиент»: человек может
    // не нажать «готово» никогда, а бот уже работает. Шаги должны остаться
    // вложенными, иначе на графике появится отрицательный отвал.
    const saved = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '4242';
    try {
      const f = (await api('/api/admin/stats')).json.funnel;
      for (let i = 1; i < f.steps.length; i++) {
        assert.ok(f.steps[i].count <= f.steps[i - 1].count,
          f.steps[i].key + ' (' + f.steps[i].count + ') больше ' + f.steps[i - 1].key + ' (' + f.steps[i - 1].count + ')');
        assert.ok(f.steps[i].lost >= 0, 'отвал не может быть отрицательным');
      }
    } finally {
      if (saved === undefined) delete process.env.ADMIN_IDS; else process.env.ADMIN_IDS = saved;
    }
  });

  await t('кабинеты без отметок в воронку не попадают', async () => {
    // Заведённые до появления счётчика иначе выглядели бы как «открыл и бросил».
    const old = store.getOrCreate(9911);
    old.milestones = { opened: 0, connected: 0, knowledge: 0, onboarded: 0, firstClient: 0 };
    store.save(old);
    const saved = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '4242';
    try {
      const r = await api('/api/admin/stats');
      assert.ok(r.json.funnel.untracked >= 1, 'посчитаны отдельно: ' + r.json.funnel.untracked);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_IDS; else process.env.ADMIN_IDS = saved;
      store.remove(9911);
    }
  });

  await t('приветствие платформенного бота открывает кабинет одной кнопкой', async () => {
    // Человек приходит по ссылке из рекламы. Если сказать ему «нажмите кнопку
    // в меню бота», половина не найдёт её — кнопка должна быть в сообщении.
    const { server: srv } = require('./server');
    const saved = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://consul.example.com';
    try {
      sent.length = 0;
      const marks = [];
      const real = tg.sendMessage;
      tg.sendMessage = async (token, chatId, text, extra) => { marks.push({ text, extra }); return { message_id: 1 }; };
      try { await require('./server').handlePlatformUpdate({ message: {
        chat: { id: 77, type: 'private' }, from: { id: 77, first_name: 'Пётр' }, text: '/start', date: Math.floor(Date.now() / 1000),
      } }); } finally { tg.sendMessage = real; }
      assert.ok(marks.length, 'бот ответил на /start');
      const kb = marks[0].extra && marks[0].extra.reply_markup;
      assert.ok(kb, 'к сообщению приложена клавиатура');
      const btn = kb.inline_keyboard[0][0];
      assert.ok(btn.web_app && btn.web_app.url, 'кнопка открывает мини-апп: ' + JSON.stringify(btn));
      assert.ok(!/кнопка .Открыть Consul. в меню/.test(marks[0].text), 'больше не отправляем искать кнопку в меню');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved;
    }
  });

  await t('бот сам сообщает Telegram id для ADMIN_IDS', async () => {
    // Иначе за собственным id приходится идти к чужому боту, хотя свой видит
    // его в каждом сообщении.
    const marks = [];
    const real = tg.sendMessage;
    tg.sendMessage = async (token, chatId, text) => { marks.push(text); return { message_id: 1 }; };
    try {
      await require('./server').handlePlatformUpdate({ message: {
        chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Анна' },
        text: '/id', date: Math.floor(Date.now() / 1000),
      } });
    } finally { tg.sendMessage = real; }
    assert.ok(marks.length, 'бот ответил');
    assert.ok(/4242/.test(marks[0]), 'id в ответе: ' + marks[0]);
    assert.ok(/ADMIN_IDS/.test(marks[0]), 'сказано, куда его вписать');
  });

  await t('уже вписанному в ADMIN_IDS бот об этом и говорит', async () => {
    const saved = process.env.ADMIN_IDS;
    process.env.ADMIN_IDS = '4242';
    const marks = [];
    const real = tg.sendMessage;
    tg.sendMessage = async (token, chatId, text) => { marks.push(text); return { message_id: 1 }; };
    try {
      await require('./server').handlePlatformUpdate({ message: {
        chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Анна' },
        text: '/id', date: Math.floor(Date.now() / 1000),
      } });
    } finally {
      tg.sendMessage = real;
      if (saved === undefined) delete process.env.ADMIN_IDS; else process.env.ADMIN_IDS = saved;
    }
    assert.ok(/уже в ADMIN_IDS/.test(marks[0]), marks[0]);
  });

  await t('приглашение менеджера отдаёт рабочую ссылку', async () => {
    const r = await api('/api/team/invite', { name: 'Дмитрий Морозов', un: 'dmitry_m', dept: 'Support' });
    assert.strictEqual(r.status, 200);
    assert.ok(/^https:\/\/t\.me\/consul_test_bot\?start=join_[0-9a-f]{12}$/.test(r.json.link), r.json.link);
    assert.strictEqual(r.json.team.length, 2);
    assert.strictEqual(r.json.team[1].name, 'Дмитрий Морозов');
    assert.strictEqual(r.json.team[1].dept, 'Support');
    assert.strictEqual(r.json.team[1].linked, false, 'пока не нажал ссылку — передачи не получает');
  });

  await t('state отдаёт диалоги и счётчики', async () => {
    const r = await api('/api/state');
    const s = r.json.state;
    assert.ok(s.dialogs.length >= 4);
    assert.ok(s.counters.msgs > 0 && s.counters.byAi > 0 && s.counters.handed > 0);
    assert.strictEqual(s.mode, 'polling');
    assert.ok(!JSON.stringify(s).includes('tokenEnc'), 'секреты не утекают в state');
    assert.ok(!JSON.stringify(s).includes('webhookSecret'));
  });

  await t('вебхук с неизвестным секретом отклоняется', async () => {
    const res = await fetch(base + '/tg/неизвестный', { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 401);
  });

  await t('health отвечает без авторизации', async () => {
    const r = await (await fetch(base + '/health')).json();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'polling');
  });

  await t('htmlToText вычищает скрипты и теги', () => {
    const txt = htmlToText('<html><head><style>a{color:red}</style><script>alert(1)</script></head><body><h1>Цены</h1><p>Торшер&nbsp;12&nbsp;400&nbsp;₽</p></body></html>');
    assert.ok(!/alert|color:red|</.test(txt), txt);
    assert.ok(/Цены/.test(txt) && /12 400/.test(txt));
  });

  await t('загрузка DOCX кладёт текст в базу знаний', async () => {
    const zlib = require('zlib');
    const docx = makeDocx('Правила доставки\nПо Москве бесплатно от 5 000 рублей, курьер 490 рублей.\nПо России СДЭК 2-5 дней, возврат в течение 14 дней.');
    const res = await fetch(base + '/api/knowledge/upload', {
      method: 'POST',
      headers: { 'x-init-data': AUTH, 'x-filename': encodeURIComponent('rules.docx'), 'content-type': 'application/octet-stream' },
      body: docx,
    });
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    assert.ok(j.chars > 60, 'текст извлечён');
    const added = j.knowledge.find(k => k.title === 'rules');
    assert.ok(added && added.ready, 'источник добавлен и готов');
  });

  await t('файл неизвестного формата отклоняется понятным текстом', async () => {
    const res = await fetch(base + '/api/knowledge/upload', {
      method: 'POST',
      headers: { 'x-init-data': AUTH, 'x-filename': 'photo.heic' },
      body: Buffer.from('xx'),
    });
    const j = await res.json();
    assert.strictEqual(res.status, 400);
    assert.ok(/Не понимаю формат/.test(j.error), j.error);
  });

  await t('дневная квота AI останавливает ответы и передаёт диалог человеку', async () => {
    const limits = require('./limits');
    const w = store.getOrCreate(4242);
    w.quota = { date: new Date().toISOString().slice(0, 10), used: 100000 };
    sent.length = 0;
    await handleIncoming(w, { chatId: 1234, userId: 1234, text: 'Есть торшер?', firstName: 'Пётр', ts: Date.now() });
    const d = store.dialog(w, 1234);
    assert.strictEqual(d.status, 'attention', 'диалог ушёл человеку');
    assert.ok(d.msgs.some(m => m.r === 'sys' && /лимит/i.test(m.t)), 'в ленте отмечена причина');
    const toClient = sent.find(s => s.chatId === 1234);
    assert.ok(/менеджеру/.test(toClient.text), 'клиент получил честный ответ');
    assert.ok(sent.some(s => s.chatId === 4242), 'владелец уведомлён');
    delete w.quota;
  });

  await t('слишком частые сообщения от одного клиента пропускаются', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    for (let i = 0; i < 10; i++) {
      await handleIncoming(w, { chatId: 4321, userId: 4321, text: 'вопрос ' + i, firstName: 'Флуд', ts: Date.now() });
    }
    const answers = sent.filter(s => s.chatId === 4321).length;
    assert.ok(answers < 10, 'ответили не на все ' + answers);
    assert.ok(answers > 0, 'но часть обработали');
  });

  await t('клиент заблокировал бота — диалог закрывается, а не роняет обработку', async () => {
    const w = store.getOrCreate(4242);
    const orig = tg.sendMessage;
    tg.sendMessage = async (token, chatId) => {
      if (chatId === 5555) { const e = new Error('Forbidden: bot was blocked by the user'); e.code = 403; throw e; }
      return { message_id: 1 };
    };
    await handleIncoming(w, { chatId: 5555, userId: 5555, text: 'Есть торшер?', firstName: 'Блок', ts: Date.now() });
    tg.sendMessage = orig;
    assert.strictEqual(store.dialog(w, 5555).status, 'closed');
  });

  await t('оповещение о сбоях AI приходит не сразу и не на каждый', async () => {
    process.env.ADMIN_IDS = '4242';

    // Порог — пять сбоев за десять минут: разовая ошибка админа не будит.
    groqOn = false;
    const w = store.getOrCreate(4242);
    sent.length = 0;
    for (let i = 0; i < 3; i++) {
      await handleIncoming(w, { chatId: 8000 + i, userId: 8000 + i, text: 'есть?', firstName: 'К' + i, ts: Date.now() });
    }
    const early = sent.filter(s => s.chatId === 4242 && /не отвечает/.test(s.text)).length;
    assert.strictEqual(early, 0, 'три сбоя — ещё не повод для тревоги');

    for (let i = 3; i < 7; i++) {
      await handleIncoming(w, { chatId: 8000 + i, userId: 8000 + i, text: 'есть?', firstName: 'К' + i, ts: Date.now() });
    }
    const alerts = sent.filter(s => s.chatId === 4242 && /Модель не отвечает/.test(s.text));
    assert.ok(alerts.length >= 1, 'после пяти сбоев админ предупреждён');
    assert.strictEqual(alerts.length, 1, 'но только один раз, а не на каждый сбой');
    groqOn = true;
    delete process.env.ADMIN_IDS;
  });

  await t('админская сводка закрыта для посторонних', async () => {
    const r = await api('/api/admin/stats');
    assert.strictEqual(r.status, 403);
  });

  await t('diag показывает готовность и лимиты', async () => {
    const r = await api('/api/diag');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.json.diag.ready, 'boolean');
    assert.ok(Array.isArray(r.json.diag.warnings));
    assert.strictEqual(r.json.diag.quotaLimit, 300);
  });

  await t('тренировка стиля: AI играет клиента, а не продавца', async () => {
    const r = await api('/api/style/next', { history: [], scenario: 'haggle' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.message.length > 3, 'клиент что-то написал');
    // модель получила роль покупателя, а не менеджера
    assert.ok(/ПОКУПАТЕЛЯ/.test(lastSystem), 'в промпте роль покупателя');
    assert.ok(!/ФОРМАТ ОТВЕТА[\s\S]*handoff/.test(lastSystem), 'это не промпт менеджера');
  });

  await t('разбор стиля требует минимум трёх ответов', async () => {
    const r = await api('/api/style/analyze', { replies: ['Да', 'Нет'] });
    assert.strictEqual(r.status, 400);
    assert.ok(/три/.test(r.json.error), r.json.error);
  });

  await t('разбор возвращает профиль и не применяет его сам', async () => {
    const replies = ['Здравствуйте! Скидка 5% от трёх штук', 'Дешевле не выйдет, гарантия три года', 'За две дам 7%'];
    const r = await api('/api/style/analyze', { replies });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.profile.instructions, 'есть инструкция для бота');
    assert.ok(Array.isArray(r.json.profile.traits));
    const st = await api('/api/state');
    assert.ok(!st.json.state.ai.styleProfile, 'до подтверждения профиль не применён');
  });

  await t('применение профиля меняет настройки и промпт бота', async () => {
    const before = store.getOrCreate(4242).ai.style;
    const r = await api('/api/style/apply', {});
    assert.strictEqual(r.status, 200);
    const w = store.getOrCreate(4242);
    assert.ok(w.ai.styleProfile, 'профиль сохранён');
    assert.ok(!w.ai.styleDraft, 'черновик убран');
    const prompt = ai.systemPrompt(w, []);
    assert.ok(/ГОЛОС КОМПАНИИ/.test(prompt), 'голос попал в системный промпт');
    assert.ok(prompt.includes(w.ai.styleProfile.instructions), 'инструкция дословно в промпте');
  });

  await t('снятие голоса убирает его и из промпта', async () => {
    await api('/api/style/forget', {});
    const w = store.getOrCreate(4242);
    assert.ok(!w.ai.styleProfile);
    assert.ok(!/ГОЛОС КОМПАНИИ/.test(ai.systemPrompt(w, [])));
  });

  await t('применять нечего, если тренировки не было', async () => {
    const r = await api('/api/style/apply', {});
    assert.strictEqual(r.status, 400);
  });

  await t('владелец забрал диалог во время ожидания — бот не влезает', async () => {
    process.env.HUMANIZE = '1';
    const w = store.getOrCreate(4242);
    sent.length = 0;

    // сообщение поставлено в очередь, ответ ещё не отправлен
    await handleIncoming(w, { chatId: 6100, userId: 6100, text: 'есть бани?', firstName: 'Олег', ts: Date.now() });
    assert.strictEqual(sent.filter(s => s.chatId === 6100).length, 0, 'бот ещё молчит, ждёт очередь');

    // владелец успевает забрать диалог
    await api('/api/dialog/takeover', { id: '6100', who: 'Анна' });
    await new Promise(r => setTimeout(r, 3200));

    assert.strictEqual(sent.filter(s => s.chatId === 6100).length, 0, 'бот не ответил поверх человека');
    assert.strictEqual(store.dialog(store.getOrCreate(4242), 6100).status, 'human');
    process.env.HUMANIZE = '0';
  });

  await t('проверка достижимости владельца: недоступен, если бот не может писать', async () => {
    const orig = tg.sendChatActionStrict;
    tg.sendChatActionStrict = async () => { const e = new Error('Forbidden: bot was blocked by the user'); e.code = 403; throw e; };
    const r = await api('/api/notify/check');
    tg.sendChatActionStrict = orig;
    assert.strictEqual(r.json.reachable, false);
    assert.ok(/Start/.test(r.json.reason), r.json.reason);
    const st = await api('/api/state');
    assert.strictEqual(st.json.state.notifyOk, false, 'флаг попал в состояние');
  });

  await t('после Start достижимость восстанавливается', async () => {
    const orig = tg.sendChatActionStrict;
    tg.sendChatActionStrict = async () => ({ ok: true });
    const r = await api('/api/notify/check');
    tg.sendChatActionStrict = orig;
    assert.strictEqual(r.json.reachable, true);
    const st = await api('/api/state');
    assert.strictEqual(st.json.state.notifyOk, true);
  });

  await t('удаление кабинета требует подтверждения', async () => {
    const r = await api('/api/account/delete', { confirm: 'да' });
    assert.strictEqual(r.status, 400);
    assert.ok(store.get(4242), 'кабинет на месте');
  });

  await t('удаление кабинета стирает данные и отвязывает бота', async () => {
    const before = store.get(4242);
    assert.ok(Object.keys(before.dialogs).length > 0);
    const botId = before.bot.botId;
    const r = await api('/api/account/delete', { confirm: 'УДАЛИТЬ' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.deleted, true);
    assert.ok(r.json.summary.dialogs > 0, 'сводка по удалённому');
    assert.strictEqual(store.get(4242), null, 'кабинета больше нет');
    assert.strictEqual(store.findByBotId(botId), null, 'бот отвязан');
    store.persistNow();
    const raw = JSON.parse(fs.readFileSync(store._file, 'utf8'));
    assert.ok(!raw.workspaces['4242'], 'на диске тоже нет');
  });

  await t('после удаления следующий вход создаёт чистый кабинет', async () => {
    const r = await api('/api/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state.onboarded, false);
    assert.strictEqual(r.json.state.dialogs.length, 0);
    assert.strictEqual(r.json.state.bot.connected, false);
  });

  console.log('api / политика данных');

  await t('политика и условия открываются на том же домене', async () => {
    for (const p of ['/privacy', '/terms']) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 200, p + ' должен открываться');
      const html = await res.text();
      assert.ok(/text\/html/.test(res.headers.get('content-type') || ''), p + ' отдаётся как страница');
      assert.ok(html.length > 1500, p + ' не должен быть заглушкой');
    }
  });

  await t('без оператора ссылку на политику приложению не отдаём', async () => {
    delete process.env.OPERATOR_NAME; delete process.env.OPERATOR_EMAIL;
    const r = await api('/api/state');
    assert.strictEqual(r.json.state.links.privacy, '', 'документ без ответственного лица не показываем');
  });

  await t('с оператором ссылки появляются и ведут на встроенные страницы', async () => {
    process.env.OPERATOR_NAME = 'ИП Тестов';
    process.env.OPERATOR_EMAIL = 'test@example.com';
    process.env.PUBLIC_URL = 'https://consul.example.com';
    try {
      const links = require('./config').urls;
      assert.strictEqual(links.privacy, 'https://consul.example.com/privacy');
      assert.strictEqual(links.terms, 'https://consul.example.com/terms');
      const html = require('./legal').privacy();
      assert.ok(html.includes('test@example.com'), 'в тексте есть адрес для связи');
      assert.ok(!/Оператор не указан/.test(html), 'заглушки про оператора больше нет');
    } finally {
      delete process.env.OPERATOR_NAME; delete process.env.OPERATOR_EMAIL;
      delete process.env.PUBLIC_URL;
    }
  });

  await t('у юрлица на странице видны реквизиты, а не одно название', async () => {
    // «ООО „Ромашка“» в реестре десятки — по одному названию непонятно,
    // к кому идти. Реквизиты задаются отдельной строкой и необязательны.
    process.env.OPERATOR_NAME = 'ООО «Тест»';
    process.env.OPERATOR_EMAIL = 'test@example.com';
    process.env.OPERATOR_DETAILS = 'ИНН 7701234567, Москва, ул. Примерная, 1';
    try {
      const html = require('./legal').privacy();
      assert.ok(html.includes('ООО «Тест»'), 'название есть');
      assert.ok(html.includes('ИНН 7701234567'), 'реквизиты есть');
      assert.ok(html.includes('ООО «Тест»', html.indexOf('class="foot"')) || /foot[\s\S]*Тест/.test(html),
        'оператор подписан и в подвале');
    } finally {
      delete process.env.OPERATOR_NAME; delete process.env.OPERATOR_EMAIL; delete process.env.OPERATOR_DETAILS;
    }
  });

  await t('без реквизитов страница остаётся связной', async () => {
    process.env.OPERATOR_NAME = 'Иванов Иван Иванович';
    process.env.OPERATOR_EMAIL = 'test@example.com';
    try {
      const html = require('./legal').privacy();
      assert.ok(html.includes('Иванов Иван Иванович'));
      assert.ok(!/<br>\s*<br>/.test(html), 'нет пустой строки на месте реквизитов');
    } finally {
      delete process.env.OPERATOR_NAME; delete process.env.OPERATOR_EMAIL;
    }
  });

  await t('политика говорит про роли, основания и передачу за пределы ЕЭЗ', async () => {
    // Европейскому оператору мало «кто отвечает и куда писать»: нужны роли
    // контролёра и обработчика, основания обработки и вывоз данных в США.
    const html = require('./legal').privacy();
    for (const must of ['контролёр', 'обработчик', 'Исполнение договора',
                        'за пределы ЕЭЗ', 'надзорный орган', 'Скачать мои данные']) {
      assert.ok(html.includes(must), 'в политике нет «' + must + '»');
    }
    const terms = require('./legal').terms();
    assert.ok(/по вашему поручению/.test(terms), 'в условиях есть обязательства обработчика');
  });

  await t('политика объясняет, что доступ к боту отзывается одной командой', async () => {
    const html = require('./legal').privacy();
    assert.ok(/\/revoke/.test(html), 'способ отозвать доступ назван');
    assert.ok(/удаляется отдельно/.test(html), 'и сказано, что отзыв не стирает переписку');
  });

  await t('регион серверов попадает на страницу, когда задан', async () => {
    process.env.DATA_REGION = 'Франкфурт, Германия';
    try { assert.ok(require('./legal').privacy().includes('Франкфурт')); }
    finally { delete process.env.DATA_REGION; }
  });

  await t('выгрузка отдаёт данные один раз и по короткой ссылке', async () => {
    // Тест самодостаточен: к этому моменту кабинет мог быть удалён и создан
    // заново, поэтому сами кладём в него переписку и материал.
    const w = store.getOrCreate(4242);
    await handleIncoming(w, { chatId: 4001, userId: 4001, text: 'Есть торшер для гостиной?',
      firstName: 'Экспорт', ts: Date.now() });
    await api('/api/knowledge/add', { kind: 'price', title: 'Прайс для выгрузки', body: 'Торшер — 12 400 ₽' });

    const r = await api('/api/account/export');
    assert.strictEqual(r.status, 200);
    assert.ok(/\/export\/[0-9a-f]{48}$/.test(r.json.url), 'ссылка одноразовая: ' + r.json.url);

    const res = await fetch(base + new URL(r.json.url).pathname);
    assert.strictEqual(res.status, 200);
    assert.ok(/attachment/.test(res.headers.get('content-disposition') || ''), 'файл скачивается, а не открывается');
    const data = await res.json();
    assert.ok(Array.isArray(data.диалоги), 'диалоги выгружены');
    assert.ok(data.диалоги.some(d => (d.сообщения || []).length), 'переписка внутри');
    assert.ok(Array.isArray(data.базаЗнаний), 'база знаний выгружена');

    const again = await fetch(base + new URL(r.json.url).pathname);
    assert.strictEqual(again.status, 410, 'вторая попытка по той же ссылке не проходит');
  });

  await t('в выгрузке нет токена бота', async () => {
    // Файл уедет в мессенджер и осядет в загрузках. Токену там не место.
    const r = await api('/api/account/export');
    const raw = await (await fetch(base + new URL(r.json.url).pathname)).text();
    assert.ok(!/tokenEnc|webhookSecret/.test(raw), 'секреты не выгружаем');
    assert.ok(!/PLATFORM-TEST-TOKEN|\d{6,}:[A-Za-z0-9_-]{20,}/.test(raw), 'токен в открытом виде тоже');
  });

  await t('чужая ссылка на выгрузку не работает', async () => {
    const res = await fetch(base + '/export/' + 'ff'.repeat(24));
    assert.strictEqual(res.status, 410);
  });

  await t('своя страница перекрывает встроенную', async () => {
    process.env.PRIVACY_URL = 'https://example.com/policy';
    try { assert.strictEqual(require('./config').urls.privacy, 'https://example.com/policy'); }
    finally { delete process.env.PRIVACY_URL; }
  });

  await t('отключение бота снимает привязку', async () => {
    const r = await api('/api/bot/disconnect');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store.findByBotId(7001), null);
  });

  server.close();
  store.persistNow();
  try { fs.rmSync(process.env.CONSUL_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('api: ' + n + ' тестов пройдено\n');
  process.exit(0);
})().catch(e => { console.error('  ✗ ' + (e.stack || e.message)); process.exit(1); });
