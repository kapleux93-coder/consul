'use strict';
/* Тест возврата замолчавших клиентов. Написать первым легко испортить
 * впечатление, поэтому проверяем в основном случаи, когда писать НЕЛЬЗЯ. */
const assert = require('assert');
const f = require('./followup');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const MIN = 60000;
const now = Date.parse('2026-09-06T12:00:00Z');   // 15:00 по Москве — рабочее время

function ws(patch) {
  return Object.assign({
    biz: { name: 'Банный двор' }, bot: { name: 'bot', username: 'bot' },
    ai: { followUp: true, followUpMin: 45, quietFrom: 22, quietTo: 9, tzOffset: 3, paused: false },
  }, patch || {});
}

/** Диалог, где бот ответил и клиент замолчал. */
function dialog(patch, minutesAgo = 60) {
  return Object.assign({
    id: '1', chatId: 1, status: 'ai', followedUp: 0,
    msgs: [
      { r: 'user', t: 'здравствуйте, есть бани?', ts: now - (minutesAgo + 5) * MIN },
      { r: 'ai',   t: 'Есть. Для двоих обычно берут 4х6 — 320 000 ₽.', ts: now - (minutesAgo + 4) * MIN },
      { r: 'user', t: 'а подумать можно?', ts: now - (minutesAgo + 1) * MIN },
      { r: 'ai',   t: 'Конечно. Если что — посчитаю доставку в ваш город.', ts: now - minutesAgo * MIN },
    ],
  }, patch || {});
}

console.log('followup / когда напоминаем');

t('клиент молчит час после ответа бота — напоминаем', () => {
  const v = f.shouldFollowUp(ws(), dialog(), now);
  assert.strictEqual(v.ok, true, v.why);
  assert.strictEqual(v.minutes, 60);
  assert.strictEqual(v.thinking, true, '«подумать» распознано — тон будет мягче');
});

console.log('followup / когда молчим');

t('слишком рано — ждём положенное время', () => {
  const v = f.shouldFollowUp(ws(), dialog({}, 20), now);
  assert.strictEqual(v.ok, false);
  assert.ok(/рано/.test(v.why), v.why);
});

t('второй раз не напоминаем', () => {
  const v = f.shouldFollowUp(ws(), dialog({ followedUp: now - 10 * MIN }), now);
  assert.strictEqual(v.ok, false);
  assert.ok(/уже напоминали/.test(v.why));
});

t('диалог забрал человек — не лезем', () => {
  assert.strictEqual(f.shouldFollowUp(ws(), dialog({ status: 'human' }), now).ok, false);
});

t('диалог передан менеджеру — не лезем', () => {
  assert.strictEqual(f.shouldFollowUp(ws(), dialog({ status: 'attention' }), now).ok, false);
});

t('AI на паузе — молчим', () => {
  const w = ws(); w.ai.paused = true;
  assert.strictEqual(f.shouldFollowUp(w, dialog(), now).ok, false);
});

t('владелец выключил напоминания', () => {
  const w = ws(); w.ai.followUp = false;
  const v = f.shouldFollowUp(w, dialog(), now);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'выключено');
});

t('последним говорил клиент — значит ждём ответа бота, а не напоминаем', () => {
  const d = dialog();
  d.msgs.push({ r: 'user', t: 'ещё вопрос', ts: now - 60 * MIN });
  assert.strictEqual(f.shouldFollowUp(ws(), d, now).ok, false);
});

t('клиент отказался — не преследуем', () => {
  const refusals = ['спасибо, нет', 'не надо', 'уже купил в другом месте', 'не интересно', 'передумал'];
  for (const text of refusals) {
    const d = dialog();
    d.msgs[2].t = text;
    const v = f.shouldFollowUp(ws(), d, now);
    assert.strictEqual(v.ok, false, 'должны молчать после «' + text + '»');
    assert.ok(/отказ/.test(v.why), v.why);
  }
});

t('клиент почти ничего не написал — напоминать не о чем', () => {
  const d = { id: '2', chatId: 2, status: 'ai', followedUp: 0, msgs: [
    { r: 'user', t: '/start', ts: now - 70 * MIN },
    { r: 'ai', t: 'Здравствуйте! Чем помочь?', ts: now - 69 * MIN },
  ] };
  const v = f.shouldFollowUp(ws(), d, now);
  assert.strictEqual(v.ok, false);
  assert.ok(/почти ничего/.test(v.why), v.why);
});

t('разговор старше суток не оживляем', () => {
  const v = f.shouldFollowUp(ws(), dialog({}, 60 * 30), now);
  assert.strictEqual(v.ok, false);
  assert.ok(/остыл/.test(v.why), v.why);
});

t('распознавание отказа и раздумий вообще работает', () => {
  // Страховка от целого класса багов: \b в JavaScript не работает с кириллицей,
  // и оба выражения молча не находили ничего.
  assert.ok(f.REFUSAL.test('не надо'), 'отказ должен распознаваться');
  assert.ok(f.THINKING.test('я подумаю'), 'раздумья должны распознаваться');
  assert.ok(!f.REFUSAL.test('сколько стоит баня'), 'обычный вопрос не отказ');
  assert.ok(!f.THINKING.test('продумал проект'), 'слово внутри другого не считается');
});

console.log('followup / ночью не пишем');

t('час считается по поясу бизнеса, а не по серверу', () => {
  // 23:00 UTC = 02:00 в Москве
  assert.strictEqual(f.localHour(3, Date.parse('2026-09-06T23:00:00Z')), 2);
  assert.strictEqual(f.localHour(0, Date.parse('2026-09-06T23:00:00Z')), 23);
});

t('окно тишины переходит через полночь', () => {
  const ai = { quietFrom: 22, quietTo: 9, tzOffset: 3 };
  assert.strictEqual(f.isQuiet(ai, Date.parse('2026-09-06T20:00:00Z')), true, '23:00 мск — тихо');
  assert.strictEqual(f.isQuiet(ai, Date.parse('2026-09-06T01:00:00Z')), true, '04:00 мск — тихо');
  assert.strictEqual(f.isQuiet(ai, Date.parse('2026-09-06T09:00:00Z')), false, '12:00 мск — можно');
});

t('ночью напоминание не уходит', () => {
  const night = Date.parse('2026-09-06T01:00:00Z');   // 04:00 мск
  const d = dialog({}, 60);
  d.msgs.forEach(m => { m.ts = night - 70 * MIN; });
  d.msgs[3].ts = night - 60 * MIN;
  const v = f.shouldFollowUp(ws(), d, night);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'тихие часы');
});

t('выключенное окно тишины не мешает', () => {
  assert.strictEqual(f.isQuiet({ quietFrom: 0, quietTo: 0, tzOffset: 3 }), false);
});

console.log('followup: ' + n + ' тестов пройдено\n');
