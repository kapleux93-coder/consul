'use strict';
/* Тест лимитов: суточные квоты на вызовы модели, частота сообщений от клиента,
 * частота запросов мини-аппа и объём базы знаний. Всё без сети. */
process.env.LIMIT_DAILY_AI = '3';
process.env.LIMIT_DAILY_GLOBAL = '5';
process.env.LIMIT_CHAT_PER_MIN = '2';
process.env.LIMIT_API_PER_MIN = '3';
process.env.LIMIT_KB_CHARS = '100';

const assert = require('assert');
const limits = require('./limits');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const ws = id => ({ ownerId: String(id), knowledge: [] });

console.log('limits / суточная квота кабинета');

t('пропускает, пока не выбран лимит', () => {
  limits._reset();
  const w = ws(1);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(limits.checkAiQuota(w).ok, true, 'вызов ' + (i + 1));
    limits.spendAi(w);
  }
  assert.strictEqual(limits.usedToday(w), 3);
});

t('на четвёртом вызове отказывает и называет причину', () => {
  const w = ws(1);
  w.quota = { date: new Date().toISOString().slice(0, 10), used: 3 };
  const r = limits.checkAiQuota(w);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.scope, 'workspace');
  assert.strictEqual(r.limit, 3);
});

t('квота вчерашнего дня не переносится на сегодня', () => {
  const w = ws(2);
  w.quota = { date: '2000-01-01', used: 999 };
  assert.strictEqual(limits.usedToday(w), 0);
  assert.strictEqual(limits.checkAiQuota(w).ok, true);
});

t('остаток считается корректно', () => {
  limits._reset();
  const w = ws(3);
  assert.strictEqual(limits.quotaLeft(w), 3);
  limits.spendAi(w);
  assert.strictEqual(limits.quotaLeft(w), 2);
});

console.log('limits / общий лимит сервиса');

t('общий лимит держит несколько кабинетов вместе', () => {
  limits._reset();
  const a = ws('a'), b = ws('b');
  // по 2 вызова из двух кабинетов — это 4 из 5 общих
  for (let i = 0; i < 2; i++) { assert.ok(limits.checkAiQuota(a).ok); limits.spendAi(a); }
  for (let i = 0; i < 2; i++) { assert.ok(limits.checkAiQuota(b).ok); limits.spendAi(b); }
  assert.strictEqual(limits._global.used, 4);
  const c = ws('c');
  assert.strictEqual(limits.checkAiQuota(c).ok, true, 'пятый ещё проходит');
  limits.spendAi(c);
  const r = limits.checkAiQuota(ws('d'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.scope, 'service', 'сработал общий лимит, а не кабинетный');
});

console.log('limits / частота');

t('клиент не может слать быстрее лимита', () => {
  limits._reset();
  assert.strictEqual(limits.allowChat(1, 555), true);
  assert.strictEqual(limits.allowChat(1, 555), true);
  assert.strictEqual(limits.allowChat(1, 555), false, 'третье сообщение за минуту отсекается');
});

t('лимит частоты у каждого чата свой', () => {
  limits._reset();
  limits.allowChat(1, 555); limits.allowChat(1, 555);
  assert.strictEqual(limits.allowChat(1, 777), true, 'другой клиент не страдает');
  assert.strictEqual(limits.allowChat(2, 555), true, 'другой кабинет не страдает');
});

t('лимит запросов API считается по пользователю', () => {
  limits._reset();
  for (let i = 0; i < 3; i++) assert.strictEqual(limits.allowApi(42), true);
  assert.strictEqual(limits.allowApi(42), false);
  assert.strictEqual(limits.allowApi(43), true, 'другой пользователь не задет');
});

t('окно скользящее: старые события выпадают', () => {
  limits._reset();
  assert.strictEqual(limits.allow('k', 1, 30), true);
  assert.strictEqual(limits.allow('k', 1, 30), false);
  const until = Date.now() + 40;
  while (Date.now() < until) { /* ждём, пока окно проедет */ }
  assert.strictEqual(limits.allow('k', 1, 30), true, 'через 40 мс снова можно');
});

t('нулевой лимит означает «без ограничений»', () => {
  limits._reset();
  for (let i = 0; i < 50; i++) assert.strictEqual(limits.allow('free', 0, 1000), true);
});

console.log('limits / объём базы знаний');

t('считает суммарный объём источников', () => {
  const w = { knowledge: [{ body: 'a'.repeat(30) }, { body: 'b'.repeat(20) }] };
  assert.strictEqual(limits.knowledgeChars(w), 50);
});

t('не даёт превысить лимит объёма', () => {
  const w = { knowledge: [{ body: 'a'.repeat(90) }] };
  assert.strictEqual(limits.checkKnowledgeRoom(w, 5).ok, true);
  const r = limits.checkKnowledgeRoom(w, 50);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.limit, 100);
});

console.log('limits: ' + n + ' тестов пройдено\n');
