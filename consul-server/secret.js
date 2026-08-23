'use strict';
/* ============================================================================
 * Шифрование токена бота на диске (AES-256-GCM).
 *
 * Ключ берётся из CONSUL_ENC_KEY (32 байта в hex или base64). Если переменной
 * нет — ключ генерируется один раз в data/.enc-key с правами 0600. Токен бота
 * даёт полный контроль над чужим ботом, поэтому в JSON он попадает только
 * в зашифрованном виде.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CONSUL_DATA_DIR || path.join(__dirname, 'data');
const KEY_FILE = path.join(DATA_DIR, '.enc-key');

let KEY = null;

function parseKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(s)) buf = Buffer.from(s, 'hex');
  else { try { const b = Buffer.from(s, 'base64'); if (b.length === 32) buf = b; } catch (e) {} }
  return buf && buf.length === 32 ? buf : null;
}

function key() {
  if (KEY) return KEY;
  KEY = parseKey(process.env.CONSUL_ENC_KEY);
  if (KEY) return KEY;
  try {
    KEY = parseKey(fs.readFileSync(KEY_FILE, 'utf8'));
    if (KEY) return KEY;
  } catch (e) {}
  KEY = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, KEY.toString('hex'), { mode: 0o600 });
    console.warn('[secret] CONSUL_ENC_KEY не задан — ключ создан в ' + KEY_FILE +
      '. Потеряете файл — придётся заново подключать ботов.');
  } catch (e) {
    console.warn('[secret] ключ только в памяти: ' + e.message);
  }
  return KEY;
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob) {
  if (!blob) return '';
  const parts = String(blob).split('.');
  if (parts.length !== 3) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'base64'));
    d.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

/** Токен в логах и ответах API — только хвост. */
function mask(token) {
  const t = String(token || '');
  if (t.length < 12) return '••••';
  return t.slice(0, 4) + '••••' + t.slice(-4);
}

module.exports = { encrypt, decrypt, mask, _keyFile: KEY_FILE };
