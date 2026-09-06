'use strict';
/* Тест клиента Groq против локальной заглушки, отвечающей как OpenAI-совместимый API.
 * Проверяем то, что ломается на практике: выбор модели, JSON-режим, ретраи, разбор ответа. */
const http = require('http');
const assert = require('assert');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

/* ---- заглушка Groq ---- */
const seen = [];
let models = ['whisper-large-v3', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
let nextStatus = 200, nextBody = null, rejectJsonMode = false, failTimes = 0;

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: models.map(id => ({ id })) }));
    }
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ body, auth });
    if (rejectJsonMode && body.response_format) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'response_format json_object is not supported by this model' } }));
    }
    if (failTimes > 0) { failTimes--; res.writeHead(429, { 'retry-after': '0' }); return res.end('rate limited'); }
    if (nextStatus !== 200) { res.writeHead(nextStatus); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nextBody || {
      choices: [{ message: { content: '{"reply":"Торшер Lumen Arc — 12 400 ₽.","handoff":false}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
      model: body.model,
    }));
  });
});

(async () => {
  await new Promise(r => stub.listen(0, r));
  process.env.GROQ_BASE_URL = 'http://127.0.0.1:' + stub.address().port;
  process.env.GROQ_API_KEY = 'gsk_test_key';
  const groq = require('./groq');

  console.log('groq');

  await t('без ключа клиент считается выключенным', () => {
    delete require.cache[require.resolve('./groq')];
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const fresh = require('./groq');
    assert.strictEqual(fresh.enabled(), false);
    process.env.GROQ_API_KEY = saved;
    delete require.cache[require.resolve('./groq')];
  });

  const g = require('./groq');

  await t('выбирает модель из списка доступных, а не аудио-модель', async () => {
    const m = await g.model();
    assert.strictEqual(m, 'llama-3.3-70b-versatile');
  });

  await t('шлёт ключ, системный промпт и JSON-режим', async () => {
    seen.length = 0;
    await g.chat({ system: 'ты менеджер', messages: [{ role: 'user', content: 'есть торшер?' }], json: true });
    const req = seen[0];
    assert.strictEqual(req.auth, 'Bearer gsk_test_key');
    assert.strictEqual(req.body.messages[0].role, 'system');
    assert.strictEqual(req.body.messages[0].content, 'ты менеджер');
    assert.strictEqual(req.body.messages[1].content, 'есть торшер?');
    assert.deepStrictEqual(req.body.response_format, { type: 'json_object' });
  });

  await t('возвращает текст, расход токенов и имя модели', async () => {
    const r = await g.chat({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.ok(/Lumen Arc/.test(r.text));
    assert.strictEqual(r.usage.prompt_tokens, 120);
    assert.strictEqual(r.model, 'llama-3.3-70b-versatile');
  });

  await t('повторяет запрос после 429 и доводит до успеха', async () => {
    failTimes = 2; seen.length = 0;
    const r = await g.chat({ system: 's', messages: [{ role: 'user', content: 'q' }] });
    assert.ok(/Lumen Arc/.test(r.text));
    assert.strictEqual(seen.length, 3, 'две неудачи + успех');
  });

  await t('если модель не умеет json_object — повторяет без него', async () => {
    rejectJsonMode = true; seen.length = 0;
    const r = await g.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], json: true });
    assert.ok(r.text);
    assert.strictEqual(seen.length, 2);
    assert.ok(seen[0].body.response_format, 'первая попытка с json_object');
    assert.ok(!seen[1].body.response_format, 'вторая — без него');
    rejectJsonMode = false;
  });

  await t('пробрасывает ошибку сервера после исчерпания попыток', async () => {
    nextStatus = 500;
    await assert.rejects(() => g.chat({ system: 's', messages: [{ role: 'user', content: 'q' }] }), /groq 500/);
    nextStatus = 200;
  });

  console.log('groq / разбор ответа');

  await t('читает чистый JSON', () => {
    assert.deepStrictEqual(g.extractJson('{"reply":"ок","handoff":false}'), { reply: 'ок', handoff: false });
  });
  await t('читает JSON в ```-блоке', () => {
    assert.strictEqual(g.extractJson('```json\n{"reply":"ок"}\n```').reply, 'ок');
  });
  await t('вытаскивает JSON из болтовни модели', () => {
    assert.strictEqual(g.extractJson('Конечно! {"reply":"ок"} Надеюсь, помог.').reply, 'ок');
  });
  await t('на мусоре возвращает null, а не падает', () => {
    assert.strictEqual(g.extractJson('просто текст'), null);
    assert.strictEqual(g.extractJson(''), null);
    assert.strictEqual(g.extractJson('{сломано}'), null);
  });

  await t('ключ читается при вызове, а не при загрузке модуля', () => {
    // Раньше KEY фиксировался константой на загрузке. Любой файл, который
    // подключал groq.js раньше config.js, получал enabled() === false навсегда:
    // сервер молча передавал каждый диалог человеку, как будто ключа нет.
    const saved = process.env.GROQ_API_KEY;
    try {
      delete process.env.GROQ_API_KEY;
      assert.strictEqual(g.enabled(), false, 'без ключа выключен');
      process.env.GROQ_API_KEY = 'появился-позже';
      assert.strictEqual(g.enabled(), true, 'ключ, заданный после загрузки, должен подхватываться');
    } finally {
      if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved;
    }
  });

  stub.close();
  console.log('groq: ' + n + ' тестов пройдено\n');
  process.exit(0);
})().catch(e => { console.error('  ✗ ' + (e.stack || e.message)); process.exit(1); });
