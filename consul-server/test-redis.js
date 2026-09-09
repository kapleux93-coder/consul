'use strict';
/* Тест Redis-бэкенда хранилища против локальной заглушки Upstash.
 * Проверяем главное: данные переживают перезапуск, команд уходит мало,
 * а сетевой сбой не приводит к потере чужих кабинетов. */
const http = require('http');
const assert = require('assert');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- заглушка Upstash REST ---- */
let store = {};              // ключ → значение
let calls = [];              // все пришедшие команды
let failNext = 0;            // сколько ближайших запросов провалить

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(500); return res.end('boom'); }
    const cmd = JSON.parse(raw || '[]');
    calls.push(cmd);
    const [op, key, val] = cmd;
    if (op === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: store[key] ?? null }));
    }
    if (op === 'SET') {
      store[key] = val;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: 'OK' }));
    }
    if (op === 'KEYS') {
      const re = new RegExp('^' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: Object.keys(store).filter(k => re.test(k)) }));
    }
    if (op === 'DEL') {
      delete store[key];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ result: 1 }));
    }
    res.writeHead(400); res.end('unknown');
  });
});

/** Загружает store.js заново — как будто сервис перезапустили. */
function freshStore() {
  delete require.cache[require.resolve('./store')];
  return require('./store');
}

(async () => {
  await new Promise(r => stub.listen(0, r));
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:' + stub.address().port;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.CONSUL_REDIS_KEY = 'consul:test';

  console.log('store / redis');

  await t('выбирает Redis, когда заданы адрес и токен', async () => {
    const s = freshStore();
    assert.strictEqual(s.backend, 'redis');
  });

  await t('на пустой базе стартует с нуля', async () => {
    const s = freshStore();
    const r = await s.initRemote();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.backend, 'redis');
    assert.strictEqual(r.workspaces, 0);
  });

  await t('сохраняет кабинет и пишет его в Redis', async () => {
    const s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(777);
    w.biz.name = 'Nordlight Store';
    w.bot.connected = true; w.bot.username = 'nordlight_bot'; w.bot.botId = 7001; w.bot.tokenEnc = 'enc';
    s.bindBot(w, 7001, 'sec-777');
    s.save(w);
    await s.persistNow();
    assert.ok(store['consul:test'], 'ключ появился в Redis');
    assert.strictEqual(JSON.parse(store['consul:test']).workspaces['777'].biz.name, 'Nordlight Store');
  });

  await t('после перезапуска кабинет на месте', async () => {
    const s = freshStore();
    const r = await s.initRemote();
    assert.strictEqual(r.workspaces, 1);
    const w = s.get(777);
    assert.strictEqual(w.biz.name, 'Nordlight Store');
    assert.strictEqual(s.findByBotId(7001).ownerId, '777', 'индекс ботов тоже восстановился');
    assert.strictEqual(s.findByWebhookSecret('sec-777').ownerId, '777');
  });

  await t('диалоги переживают перезапуск', async () => {
    let s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(777);
    s.upsertDialog(w, 555, { full: 'Марина Соколова', un: 'marina_s' });
    s.pushMessage(w, 555, { r: 'user', t: 'есть торшер?', ts: 1000 });
    s.save(w);
    await s.persistNow();

    s = freshStore();
    await s.initRemote();
    const d = s.dialog(s.get(777), 555);
    assert.strictEqual(d.full, 'Марина Соколова');
    assert.strictEqual(d.msgs.length, 1);
  });

  await t('много правок подряд — одна запись, а не сто', async () => {
    const s = freshStore();
    await s.initRemote();
    calls = [];
    const w = s.getOrCreate(777);
    for (let i = 0; i < 50; i++) { w.counters.msgs++; s.save(w); }
    await sleep(900);
    const writes = calls.filter(c => c[0] === 'SET').length;
    assert.ok(writes <= 2, 'записей в Redis: ' + writes + ' (ожидали не больше 2)');
    assert.strictEqual(JSON.parse(store['consul:test']).workspaces['777'].counters.msgs, 50, 'последнее значение сохранено');
  });

  await t('сбой сети при старте не затирает базу пустой', async () => {
    const before = store['consul:test'];
    const s = freshStore();
    failNext = 3;                      // клиент не повторяет — все попытки лягут
    const r = await s.initRemote();
    failNext = 0;
    assert.strictEqual(r.ok, false, 'старт помечен как неудачный');
    assert.ok(r.error, 'причина названа');
    assert.strictEqual(store['consul:test'], before, 'данные в Redis не тронуты');
  });

  await t('сбой при записи не теряет изменения — повторит позже', async () => {
    const s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(777);
    w.biz.about = 'Светильники для дома';
    s.save(w);
    failNext = 1;
    await s.persistNow();              // первая попытка провалится
    await sleep(1400);                 // ретрай
    assert.strictEqual(JSON.parse(store['consul:test']).workspaces['777'].biz.about, 'Светильники для дома');
  });

  await t('удаление кабинета доезжает до Redis', async () => {
    const s = freshStore();
    await s.initRemote();
    assert.strictEqual(s.remove(777), true);
    await sleep(100);
    assert.deepStrictEqual(JSON.parse(store['consul:test']).workspaces, {});
  });

  console.log('redis / резервные копии');

  await t('снимок ложится отдельным ключом с датой', async () => {
    const s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(555); w.biz.name = 'Банный двор'; s.save(w);
    await s.persistNow();

    const r = await s.snapshot(Date.parse('2026-09-09T10:00:00Z'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.key, 'consul:test:backup:2026-09-09');
    const snap = JSON.parse(store[r.key]);
    assert.strictEqual(snap.workspaces['555'].biz.name, 'Банный двор', 'данные внутри копии');
    assert.ok(store['consul:test'], 'основной ключ на месте');
  });

  await t('пустую базу не копируем — иначе она вытеснит хорошие копии', async () => {
    const s = freshStore();
    await s.initRemote();
    s._reset();
    const r = await s.snapshot();
    assert.strictEqual(r.ok, false);
    assert.ok(/пуста/.test(r.reason), r.reason);
  });

  await t('старые копии подчищаются, свежие остаются', async () => {
    for (const k of Object.keys(store)) if (k.includes(':backup:')) delete store[k];
    const s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(556); s.save(w);
    // Семь дней подряд при KEEP=5.
    for (let d = 1; d <= 7; d++) {
      await s.snapshot(Date.parse('2026-09-0' + d + 'T10:00:00Z'));
    }
    const list = await s.snapshots();
    assert.strictEqual(list.length, 5, 'храним ровно последние пять: ' + list.join(', '));
    assert.strictEqual(list[list.length - 1], '2026-09-07', 'самая свежая на месте');
    assert.ok(!list.includes('2026-09-01'), 'самая старая удалена');
  });

  await t('слишком большая база копию не роняет, а честно отказывает', async () => {
    const s = freshStore();
    await s.initRemote();
    const w = s.getOrCreate(557);
    w.biz.about = 'x'.repeat(200);
    s.save(w);
    await s.persistNow();          // свежий экземпляр читает из Redis, а не из памяти
    const saved = process.env.BACKUP_MAX_BYTES;
    process.env.BACKUP_MAX_BYTES = '50';
    try {
      // Предел читается при загрузке модуля, поэтому берём свежий экземпляр.
      delete require.cache[require.resolve('./store')];
      const s2 = require('./store');
      await s2.initRemote();
      const r = await s2.snapshot();
      assert.strictEqual(r.ok, false);
      assert.ok(/не влезет/.test(r.reason), r.reason);
    } finally {
      if (saved === undefined) delete process.env.BACKUP_MAX_BYTES; else process.env.BACKUP_MAX_BYTES = saved;
      delete require.cache[require.resolve('./store')];
    }
  });

  stub.close();
  console.log('redis: ' + n + ' тестов пройдено\n');
  process.exit(0);
})().catch(e => { console.error('  ✗ ' + (e.stack || e.message)); process.exit(1); });
