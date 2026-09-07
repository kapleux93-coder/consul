'use strict';
/* Тест самопинга. Проверяем в основном, когда он НЕ должен включаться:
 * лишний фоновой запрос раз в десять минут жжёт бесплатные часы инстанса. */
const assert = require('assert');
const http = require('http');
const awake = require('./awake');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

/** Запускает и восстанавливает переменные окружения вокруг проверки. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

(async () => {
  console.log('awake / когда включаться');

  await t('на Render включается сам', () => {
    withEnv({ RENDER: 'true', KEEP_AWAKE: undefined }, () => {
      assert.strictEqual(awake.wanted('https://consul.example.com'), true);
    });
  });

  await t('на своём сервере не нужен — там никто не засыпает', () => {
    withEnv({ RENDER: undefined, KEEP_AWAKE: undefined }, () => {
      assert.strictEqual(awake.wanted('https://consul.example.com'), false);
    });
  });

  await t('KEEP_AWAKE=0 выключает даже на Render', () => {
    withEnv({ RENDER: 'true', KEEP_AWAKE: '0' }, () => {
      assert.strictEqual(awake.wanted('https://consul.example.com'), false);
    });
  });

  await t('KEEP_AWAKE=1 включает где угодно', () => {
    withEnv({ RENDER: undefined, KEEP_AWAKE: '1' }, () => {
      assert.strictEqual(awake.wanted('https://consul.example.com'), true);
    });
  });

  await t('без публичного адреса стучаться некуда', () => {
    withEnv({ RENDER: 'true', KEEP_AWAKE: '1' }, () => {
      assert.strictEqual(awake.wanted(''), false);
      assert.strictEqual(awake.wanted('localhost:8080'), false, 'нужен полный адрес со схемой');
    });
  });

  console.log('awake / сам стук');

  const hits = [];
  const stub = http.createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers['user-agent'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + stub.address().port;

  await t('стучится именно на /health', async () => {
    const r = await awake.ping(base);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].url, '/health');
    assert.ok(/consul/.test(hits[0].ua), 'по user-agent видно, кто стучится');
  });

  await t('лишний слеш в адресе не ломает путь', async () => {
    hits.length = 0;
    await awake.ping(base + '/');
    assert.strictEqual(hits[0].url, '/health');
  });

  await t('недоступный адрес не роняет сервис', async () => {
    const r = await awake.ping('http://127.0.0.1:1');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, 'причина сохранена для диагностики');
  });

  await t('start возвращает интервал и не оставляет таймер после stop', () => {
    withEnv({ RENDER: 'true', KEEP_AWAKE: undefined, KEEP_AWAKE_MINUTES: '7' }, () => {
      const r = awake.start(base);
      assert.strictEqual(r.on, true);
      assert.strictEqual(r.minutes, 7);
      awake.stop();
    });
  });

  await t('интервал не может стать больше времени засыпания', () => {
    withEnv({ RENDER: 'true', KEEP_AWAKE_MINUTES: '60' }, () => {
      const r = awake.start(base);
      assert.ok(r.minutes <= 14, 'Render засыпает через 15 минут: ' + r.minutes);
      awake.stop();
    });
  });

  await t('выключенный самопинг таймер не заводит', () => {
    withEnv({ RENDER: undefined, KEEP_AWAKE: undefined }, () => {
      const r = awake.start(base);
      assert.strictEqual(r.on, false);
    });
  });

  stub.close();
  console.log('awake: ' + n + ' тестов пройдено\n');
})().catch(e => { console.error('  ✗ ' + (e.stack || e.message)); process.exit(1); });
