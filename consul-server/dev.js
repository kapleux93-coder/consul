'use strict';
/* ============================================================================
 * Локальный запуск одной командой:  npm run dev
 *
 * Разбирается сам:
 *   • нет BOT_TOKEN  → включает ALLOW_INSECURE_AUTH, чтобы мини-апп открылся
 *                      в обычном браузере без Telegram;
 *   • нет GROQ_API_KEY → поднимает заглушку модели прямо в этом процессе
 *                      и направляет сервер на неё.
 * Если ключи заданы в .env — ничего не подменяет и работает с настоящими API.
 *
 * В продакшене этот файл не используется: там запускается server.js.
 * ========================================================================== */

const path = require('path');
const cfg = require('./config');   // подхватит .env, если он есть

const banner = [];

if (!cfg.botToken) {
  process.env.ALLOW_INSECURE_AUTH = '1';
  banner.push('BOT_TOKEN не задан — вход без проверки подписи Telegram (только локально)');
}

if (!cfg.groqKey) {
  const PORT = Number(process.env.MOCK_GROQ_PORT) || 8099;
  process.env.GROQ_API_KEY = 'dev';
  process.env.GROQ_BASE_URL = 'http://127.0.0.1:' + PORT + '/v1';
  process.env.MOCK_GROQ_PORT = String(PORT);
  require('./mock-groq');          // слушает сам при загрузке
  banner.push('GROQ_API_KEY не задан — отвечает заглушка на правилах, не настоящая модель');
}

if (banner.length) {
  console.log('\nРежим разработки');
  banner.forEach(b => console.log('  ! ' + b));
}

/* config.js уже прочитан с прежними значениями — перечитываем с подменёнными. */
delete require.cache[require.resolve('./config')];
delete require.cache[require.resolve('./groq')];

const server = require('./server');
server.boot();
