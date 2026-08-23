'use strict';
/* Тест хранилища: создание кабинета, привязка бота, диалоги, миграция полей. */
process.env.CONSUL_DATA_DIR = require('path').join(require('os').tmpdir(), 'consul-test-store-' + process.pid);

const assert = require('assert');
const fs = require('fs');
const store = require('./store');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

console.log('store');

t('создаёт кабинет с дефолтами', () => {
  const w = store.getOrCreate(111);
  assert.strictEqual(w.ownerId, '111');
  assert.strictEqual(w.onboarded, false);
  assert.strictEqual(w.ai.style, 'friendly');
  assert.deepStrictEqual(w.depts, ['Sales', 'Support']);
});

t('возвращает тот же объект повторно', () => {
  const a = store.getOrCreate(111); a.biz.name = 'Nordlight';
  assert.strictEqual(store.getOrCreate(111).biz.name, 'Nordlight');
});

t('дописывает поля, появившиеся после создания', () => {
  const w = store.getOrCreate(111);
  delete w.usage; delete w.ai.banned;
  const w2 = store.getOrCreate(111);
  assert.ok(w2.usage, 'usage восстановлен');
  assert.ok(Array.isArray(w2.ai.banned), 'ai.banned восстановлен');
});

t('привязывает бота и находит кабинет по botId и секрету', () => {
  const w = store.getOrCreate(111);
  w.bot.connected = true; w.bot.botId = 7001; w.bot.tokenEnc = 'x'; w.bot.webhookSecret = 'sec1';
  store.bindBot(w, 7001, 'sec1');
  assert.strictEqual(store.findByBotId(7001).ownerId, '111');
  assert.strictEqual(store.findByWebhookSecret('sec1').ownerId, '111');
  assert.strictEqual(store.findByWebhookSecret('нет'), null);
});

t('перепривязка бота отбирает его у прежнего владельца', () => {
  const other = store.getOrCreate(222);
  other.bot.connected = true; other.bot.tokenEnc = 'y';
  store.bindBot(other, 7001, 'sec2');
  assert.strictEqual(store.findByBotId(7001).ownerId, '222');
  assert.strictEqual(store.getOrCreate(111).bot.connected, false, 'у прежнего владельца бот отключён');
  assert.strictEqual(store.findByWebhookSecret('sec1'), null, 'старый секрет больше не работает');
});

t('диалоги: upsert, сообщения, обрезка истории', () => {
  const w = store.getOrCreate(111);
  store.upsertDialog(w, 555, { full: 'Марина Соколова', un: 'marina_s' });
  store.pushMessage(w, 555, { r: 'user', t: 'привет', ts: 1000 });
  const d = store.dialog(w, 555);
  assert.strictEqual(d.full, 'Марина Соколова');
  assert.strictEqual(d.msgs.length, 1);
  assert.strictEqual(d.ts, 1000);
  for (let i = 0; i < 400; i++) store.pushMessage(w, 555, { r: 'ai', t: 'x' + i, ts: 2000 + i });
  assert.strictEqual(store.dialog(w, 555).msgs.length, 300, 'история обрезается до 300');
});

t('allConnected отдаёт только кабинеты с ботом', () => {
  const list = store.allConnected().map(w => w.ownerId).sort();
  assert.deepStrictEqual(list, ['222']);
});

t('переживает перезапись на диск и перечитывание', () => {
  store.persistNow();
  const raw = JSON.parse(fs.readFileSync(store._file, 'utf8'));
  assert.strictEqual(raw.workspaces['111'].biz.name, 'Nordlight');
  assert.strictEqual(raw.byBotId['7001'], '222');
});

try { fs.rmSync(process.env.CONSUL_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
console.log('store: ' + n + ' тестов пройдено\n');
