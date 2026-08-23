'use strict';
/* Тест проверки Telegram initData и шифрования токена. */
process.env.CONSUL_DATA_DIR = require('path').join(require('os').tmpdir(), 'consul-test-auth-' + process.pid);
process.env.BOT_TOKEN = '123456:TEST-TOKEN-FOR-SIGNATURE-CHECK';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const { verifyInitData } = require('./server');
const secret = require('./secret');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

/** Собирает валидный initData так же, как это делает Telegram. */
function signInitData(user, token, authDate) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate || Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAF_test');
  params.set('user', JSON.stringify(user));
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', key).update(dcs).digest('hex'));
  return params.toString();
}

console.log('auth');
const USER = { id: 4242, first_name: 'Анна', last_name: 'Ковалёва', username: 'anna_k' };

t('принимает корректно подписанный initData', () => {
  const u = verifyInitData(signInitData(USER, process.env.BOT_TOKEN));
  assert.ok(u, 'пользователь распознан');
  assert.strictEqual(u.id, 4242);
  assert.strictEqual(u.username, 'anna_k');
});

t('отклоняет подпись чужим токеном', () => {
  assert.strictEqual(verifyInitData(signInitData(USER, '999:OTHER')), null);
});

t('отклоняет подделку данных при валидной форме', () => {
  const good = signInitData(USER, process.env.BOT_TOKEN);
  const tampered = good.replace('4242', '4243');
  assert.strictEqual(verifyInitData(tampered), null);
});

t('отклоняет пустой ввод и мусор', () => {
  assert.strictEqual(verifyInitData(''), null);
  assert.strictEqual(verifyInitData('hash=abc'), null);
  assert.strictEqual(verifyInitData('user=%7B%7D'), null, 'без hash не принимаем');
});

t('отклоняет протухший initData (старше суток)', () => {
  const old = Math.floor(Date.now() / 1000) - 90000;
  assert.strictEqual(verifyInitData(signInitData(USER, process.env.BOT_TOKEN, old)), null);
});

console.log('secret');

t('шифрует и расшифровывает токен', () => {
  const token = '7284419055:AAF9kZq3vTnLm2xYcRp8QwErTyUiOpAsDfG';
  const enc = secret.encrypt(token);
  assert.notStrictEqual(enc, token, 'на диске не открытый текст');
  assert.ok(!enc.includes('AAF9'), 'фрагменты токена не видны');
  assert.strictEqual(secret.decrypt(enc), token);
});

t('не расшифровывает подделанный шифротекст', () => {
  const enc = secret.encrypt('123:ABC');
  const parts = enc.split('.');
  parts[2] = Buffer.from('подмена').toString('base64');
  assert.strictEqual(secret.decrypt(parts.join('.')), '', 'GCM ловит подмену');
});

t('маскирует токен для логов', () => {
  const m = secret.mask('7284419055:AAF9kZq3vTnLm2xYcRp8QwErTyUiOpAsDfG');
  assert.ok(m.startsWith('7284') && m.endsWith('sDfG') && m.includes('••••'));
  assert.ok(!m.includes('kZq3'), 'середина скрыта');
});

try { fs.rmSync(process.env.CONSUL_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
console.log('auth: ' + n + ' тестов пройдено\n');
