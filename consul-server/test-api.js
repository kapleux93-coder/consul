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

  await t('запрос счёта: диалог уходит человеку и приходит уведомление', async () => {
    const w = store.getOrCreate(4242);
    sent.length = 0;
    await handleIncoming(w, { chatId: 555, userId: 555, text: 'Нужен счёт на юрлицо, ИНН пришлю', firstName: 'Марина', ts: Date.now() });
    const d = store.dialog(w, 555);
    assert.strictEqual(d.status, 'attention');
    assert.ok(d.msgs.some(m => m.r === 'sys' && /передал диалог/.test(m.t)), 'в ленте есть системная отметка');
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
