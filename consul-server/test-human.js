'use strict';
/* Тест человеческого поведения: паузы, разбиение на реплики, живой индикатор.
 * Время проверяем по факту — с запасом на неточность таймеров. */
const assert = require('assert');
const human = require('./human');

let n = 0;
const pending = [];
const t = (name, fn) => {
  const r = fn();
  n++;
  if (r && typeof r.then === 'function') pending.push(r.then(() => console.log('  ✓ ' + name)));
  else console.log('  ✓ ' + name);
};

console.log('human / разбиение на реплики');

t('уважает разрывы, расставленные моделью', () => {
  const parts = human.split('Баня 4х6 — 320 000 ₽.\n\nОбычно берут её, если париться вдвоём.');
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], 'Баня 4х6 — 320 000 ₽.');
});

t('короткий ответ остаётся одним сообщением', () => {
  assert.deepStrictEqual(human.split('Да, есть.'), ['Да, есть.']);
});

t('длинный абзац режется по границе предложения', () => {
  const long = 'Стандартная баня 4х6 метров стоит 320 000 рублей, в неё входит парная шесть квадратов и комната отдыха двенадцать. ' +
               'Срок изготовления три-четыре недели, доставка по области бесплатно.';
  const parts = human.split(long);
  assert.strictEqual(parts.length, 2);
  assert.ok(/[.!?]$/.test(parts[0]), 'первая часть кончается на границе предложения: ' + parts[0]);
  assert.strictEqual(parts.join(' '), long, 'текст не потерян');
});

t('не дробит больше чем на три реплики', () => {
  const parts = human.split('Раз.\n\nДва.\n\nТри.\n\nЧетыре.\n\nПять.');
  assert.ok(parts.length <= 3, 'реплик: ' + parts.length);
  assert.ok(parts.join(' ').includes('Пять'), 'хвост склеен, а не выброшен');
});

t('пустой ответ не превращается в пустое сообщение', () => {
  assert.deepStrictEqual(human.split('   '), []);
});

console.log('human / паузы');

t('короткий ответ приходит быстрее длинного', () => {
  const short = human.delayFor('Да, есть.', true);
  const long = human.delayFor('Стандартная баня 4х6 стоит 320 000 рублей, входит парная и комната отдыха, срок три недели.', true);
  assert.ok(long > short, `${long} должно быть больше ${short}`);
});

t('пауза не мгновенная и не бесконечная', () => {
  for (let i = 0; i < 20; i++) {
    const d = human.delayFor('Есть, 320 000 ₽.', true);
    assert.ok(d >= 1200, 'слишком быстро: ' + d);
    assert.ok(d <= human._limits.MAX_PER_MESSAGE, 'слишком долго: ' + d);
  }
});

t('вторая реплика идёт быстрее первой — «дописывает мысль»', () => {
  const txt = 'Доставка бесплатная.';
  const first = human.delayFor(txt, true);
  const next = human.delayFor(txt, false);
  assert.ok(next < first, `${next} должно быть меньше ${first}`);
});

console.log('human / доставка');

t('отправляет по частям, обновляя индикатор печати', async () => {
  const sent = [], typings = [];
  const started = Date.now();
  const parts = await human.deliver({
    send: async t => { sent.push({ t, at: Date.now() - started }); return true; },
    typing: () => typings.push(Date.now() - started),
  }, 'Есть 4х6 за 320 000.\n\nПоказать планировку?', 0);

  assert.strictEqual(parts.length, 2);
  assert.strictEqual(sent.length, 2);
  assert.ok(parts[1].at > parts[0].at, 'у реплик разное фактическое время');
  assert.ok(typings.length >= 2, 'индикатор показывали хотя бы раз на реплику');
  assert.ok(sent[0].at >= 1000, 'первая реплика не мгновенная: ' + sent[0].at + ' мс');
  assert.ok(sent[1].at > sent[0].at, 'вторая пришла позже первой');
});

t('время работы модели засчитывается в паузу, а не удваивает её', async () => {
  const started = Date.now();
  await human.deliver({ send: async () => true, typing: () => {} }, 'Да, есть.', 5000);
  const spent = Date.now() - started;
  assert.ok(spent < 900, 'модель думала 5 с, ждать ещё столько же не нужно: ' + spent + ' мс');
});

t('недоставленная реплика останавливает остальные', async () => {
  const sent = [];
  const parts = await human.deliver({
    send: async t => { sent.push(t); return false; },   // клиент заблокировал бота
    typing: () => {},
  }, 'Первое.\n\nВторое.\n\nТретье.', 0);
  assert.strictEqual(sent.length, 1, 'после отказа не продолжаем слать');
  assert.strictEqual(parts.length, 0, 'ничего не считаем отправленным');
});

Promise.all(pending)
  .then(() => console.log('human: ' + n + ' тестов пройдено\n'))
  .catch(e => { console.error('  ✗ ' + (e.stack || e.message)); process.exit(1); });
