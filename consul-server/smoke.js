'use strict';
/* ============================================================================
 * Дымовой прогон на НАСТОЯЩЕЙ модели:  npm run smoke
 *
 * Автотесты подменяют Groq заглушкой — они проверяют код, но не то, как модель
 * себя ведёт. Здесь наоборот: настоящий ключ, настоящие ответы, и смотреть
 * глазами. Ничего никуда не отправляется, Telegram не задействован, база не
 * трогается — всё в памяти.
 *
 * Что смотреть в выводе:
 *   • бот называет цену из прайса и НЕ выдумывает того, чего там нет;
 *   • на «дорого» отвечает по существу, а не «понимаю ваши сомнения»;
 *   • без базы знаний зовёт человека, а не переспрашивает по кругу;
 *   • напоминание короткое и цепляется за то, о чём говорили.
 * ========================================================================== */

const store = require('./store');
const ai = require('./ai');
const followup = require('./followup');
const groq = require('./groq');

/** Вымышленная компания с маленьким, но настоящим прайсом. */
function workspace() {
  const w = store.defaults('smoke');
  w.biz = { name: 'Банный двор', site: 'bannydvor.ru', about: 'Строим бани из бруса под ключ по Подмосковью.' };
  w.bot = { name: 'Банный двор', username: 'smoke' };
  w.ai.followUp = true;   // по умолчанию выключено, но проверить надо
  w.ai.name = 'Алексей';
  w.knowledge = [{
    id: 'k1', kind: 'price', title: 'Прайс на бани', ready: true,
    body: [
      'Бани из профилированного бруса под ключ.',
      'Баня 4х6 — 320 000 ₽. Парная 6 м², комната отдыха 12 м², душевая.',
      'Баня 3х4 — 210 000 ₽. Парная 5 м², предбанник 6 м².',
      'Баня 6х6 с террасой — 520 000 ₽.',
      'Срок изготовления 3–4 недели. Доставка по Московской области бесплатно, дальше 45 ₽/км.',
      'Монтаж на участке 1 день. Фундамент — винтовые сваи, 45 000 ₽.',
      'Предоплата 30%. Рассрочка на 6 месяцев без процентов.',
      'Гарантия 3 года. Печь Termofor входит в стоимость.',
    ].join('\n'),
  }];
  return w;
}

const log = s => console.log(s);

/* На бесплатном ключе Groq лимит 8000 токенов в минуту, а один ответ с полным
 * промптом стоит около трёх тысяч. Без пауз прогон упирается в лимит на
 * четвёртом сообщении и дальше показывает не работу бота, а отказы. */
const PAUSE = Number(process.env.SMOKE_PAUSE_MS) || 25000;
const breathe = () => new Promise(r => setTimeout(r, PAUSE));
const head = s => log('\n\x1b[1m' + s + '\x1b[0m');
const MIN = 60000;

async function run() {
  if (!groq.enabled()) {
    console.error('Нужен рабочий GROQ_API_KEY в .env или в окружении.');
    process.exit(1);
  }
  log('модель: ' + (await groq.model() || '—'));

  const w = workspace();
  const d = { id: '1', chatId: 1, status: 'ai', msgs: [], followedUp: 0 };
  const say = (r, t) => d.msgs.push({ r, t, ts: Date.now() });

  head('ПРОДАЖА: от вопроса к следующему шагу');
  for (const q of ['привет, сколько стоит баня?', 'нас двое, париться вдвоём',
                   'дороговато честно говоря', 'а сколько ждать?']) {
    say('user', q);
    log('\nКлиент: ' + q);
    await breathe();
    const r = await ai.reply(w, d, q);
    say('ai', r.reply);
    log('Бот: ' + r.reply.replace(/\n+/g, '\n     '));
    log('     · передать человеку: ' + (r.handoff ? 'да — ' + r.reason : 'нет') +
        ' · стадия: ' + (r.stage || '—') + ' · температура: ' + (r.temperature || '—') +
        ' · возражение: ' + (r.objection || '—') + ' · следующий шаг: ' + (r.nextStep || '—'));
  }

  head('«А вы человек?» — врать нельзя, но и оправдываться незачем');
  say('user', 'слушайте, а вы живой человек или бот?');
  const r1 = await ai.reply(w, d, 'слушайте, а вы живой человек или бот?');
  say('ai', r1.reply);
  log('Бот: ' + r1.reply);

  head('ВОЗВРАТ ЗАМОЛЧАВШЕГО: клиент сказал «подумаю» и пропал на час');
  say('user', 'ладно, я подумаю');
  await breathe();
  const r2 = await ai.reply(w, d, 'ладно, я подумаю');
  say('ai', r2.reply);
  log('Бот: ' + r2.reply);
  // Переносим разговор в середину рабочего дня: иначе прогон вечером упрётся
  // в тихие часы и мы не увидим, что бот вообще пишет.
  const noon = Date.parse(new Date().toISOString().slice(0, 10) + 'T09:00:00Z');   // 12:00 по Москве
  d.msgs.forEach((m, i) => { m.ts = noon - (d.msgs.length - i) * MIN; });
  const v = followup.shouldFollowUp(w, d, noon + 60 * MIN);
  log('решение: ' + (v.ok ? 'напомнить через ' + v.minutes + ' мин' : 'молчим — ' + v.why));
  if (v.ok) log('Через час: ' + (await followup.compose(w, d, v)).text);

  head('БЕЗ БАЗЫ ЗНАНИЙ: должен звать человека, а не переспрашивать по кругу');
  const w2 = workspace(); w2.knowledge = [];
  const d2 = { id: '2', chatId: 2, status: 'ai', msgs: [], followedUp: 0 };
  for (const q of ['какие бани есть?', 'ну а какие размеры?']) {
    d2.msgs.push({ r: 'user', t: q, ts: Date.now() });
  await breathe();
    const r = await ai.reply(w2, d2, q);
    d2.msgs.push({ r: 'ai', t: r.reply, ts: Date.now() });
    log('Клиент: ' + q + '\nБот: ' + r.reply + '\n     · передать человеку: ' + (r.handoff ? 'да' : 'НЕТ — проверьте'));
  }

  head('ТРЕНИРОВКА СТИЛЯ: модель играет покупателя, потом разбирает манеру владельца');
  const hist = [], own = ['Есть, 4х6 за 320 тыс', 'От трёх штук сделаю 5%', 'Ок, посчитаю доставку'];
  for (let i = 0; i < own.length; i++) {
  await breathe();
    const c = await ai.customerMessage(w, hist, ai.SCENARIOS[0].id);
    log('Покупатель: ' + c.message + (c.done ? '   [разговор закончен]' : ''));
    hist.push({ r: 'client', t: c.message });
    hist.push({ r: 'owner', t: own[i] });
    log('Владелец: ' + own[i]);
    if (c.done) break;
  }
  await breathe();
  const st = await ai.analyzeStyle(w, own);
  log('\nразбор манеры:');
  log('  ' + (st.summary || '—'));
  log('  черты: ' + (st.traits || []).join(', '));
  log('  инструкция боту: ' + (st.instructions || '—'));

  head('КАНАЛ: пост по материалам базы');
  await breathe();
  const post = await ai.channelPost(w, 'бани для двоих');
  log((post.text || '').replace(/\n/g, '\n  '));

  log('\nГотово. Смотрите глазами: цифры должны совпадать с прайсом выше.\n');
}

run().catch(e => { console.error('\nСБОЙ: ' + (e.message || e)); process.exit(1); });
