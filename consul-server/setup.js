'use strict';
/* ============================================================================
 * Настройка платформенного бота Consul одной командой.
 *
 *   node setup.js
 *
 * Берёт BOT_TOKEN и PUBLIC_URL из окружения или .env и делает всё, что иначе
 * пришлось бы кликать в @BotFather:
 *   • узнаёт username бота и дописывает его в .env;
 *   • ставит кнопку меню, открывающую мини-апп;
 *   • ставит команды, описание и текст «о боте»;
 *   • ставит вебхук (если есть публичный адрес) или снимает его.
 *
 * Скрипт идемпотентный: можно запускать после каждого деплоя.
 * ========================================================================== */

const fs = require('fs');
const cfg = require('./config');
const tg = require('./telegram');

const args = process.argv.slice(2);
const has = f => args.includes(f);

const say = s => console.log('  ' + s);
const okMark = s => console.log('  ✓ ' + s);
const failMark = s => console.error('  ✗ ' + s);

const DESCRIPTION =
  'Consul превращает вашего Telegram-бота в AI-менеджера: он сам отвечает клиентам ' +
  'о товарах, ценах и доставке, собирает контакты и передаёт сложные диалоги живому менеджеру.';
const SHORT_DESCRIPTION = 'AI-менеджер для вашего Telegram-бота. Отвечает клиентам, передаёт сложное человеку.';

const COMMANDS = [
  { command: 'start', description: 'Открыть Consul' },
  { command: 'app', description: 'Кабинет: диалоги, клиенты, настройки' },
  { command: 'help', description: 'Как это работает' },
];

/** Дописывает переменную в .env, не трогая остальное. */
function writeEnv(key, value) {
  let raw = '';
  try { raw = fs.readFileSync(cfg.envFile, 'utf8'); } catch (e) {}
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  const next = re.test(raw) ? raw.replace(re, line) : (raw ? raw.replace(/\n*$/, '\n') : '') + line + '\n';
  fs.writeFileSync(cfg.envFile, next, { mode: 0o600 });
}

async function main() {
  console.log('\nConsul — настройка бота\n');

  const token = cfg.botToken;
  if (!token) {
    failMark('BOT_TOKEN не задан.');
    console.log('\n  Что сделать:');
    console.log('   1. В Telegram откройте @BotFather → /newbot → придумайте имя и username.');
    console.log('   2. Скопируйте токен и запустите:');
    console.log('      echo "BOT_TOKEN=сюда_токен" >> ' + cfg.envFile);
    console.log('   3. Повторите: node setup.js\n');
    process.exit(1);
  }

  /* --- кто мы --- */
  let me;
  try { me = await tg.getMe(token); }
  catch (e) {
    failMark('Telegram не принял BOT_TOKEN: ' + e.message);
    console.log('  Проверьте, что скопировали токен целиком.\n');
    process.exit(1);
  }
  okMark('Бот: @' + me.username + ' (' + me.first_name + ')');

  if (cfg.botUsername !== me.username) {
    // На хостинге файловая система эфемерная: .env переживёт запуск, но не
    // следующий деплой. Поэтому там просим задать переменную в панели.
    const ephemeral = !!(process.env.RENDER || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME);
    if (ephemeral) {
      say('! Задайте переменную окружения в панели хостинга:');
      say('    BOT_USERNAME=' + me.username);
      say('  Без неё не будут работать ссылки-приглашения менеджерам.');
    } else {
      try { writeEnv('BOT_USERNAME', me.username); okMark('BOT_USERNAME записан в .env'); }
      catch (e) { say('! не смог записать BOT_USERNAME в .env: ' + e.message + ' — задайте вручную: BOT_USERNAME=' + me.username); }
    }
  }

  const url = cfg.publicUrl;

  /* --- кнопка меню открывает мини-апп --- */
  if (url) {
    try {
      await tg.call(token, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Открыть Consul', web_app: { url } },
      });
      okMark('Кнопка меню открывает ' + url);
    } catch (e) { failMark('Кнопка меню: ' + e.message); }
  } else {
    say('! PUBLIC_URL не задан — кнопку меню не ставлю (мини-апп открывать неоткуда)');
  }

  /* --- команды и описания --- */
  try { await tg.call(token, 'setMyCommands', { commands: COMMANDS }); okMark('Команды бота обновлены'); }
  catch (e) { failMark('Команды: ' + e.message); }

  try {
    await tg.call(token, 'setMyDescription', { description: DESCRIPTION });
    await tg.call(token, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION });
    okMark('Описание бота обновлено');
  } catch (e) { say('! описание: ' + e.message); }

  /* --- вебхук платформенного бота --- */
  if (url && process.env.PLATFORM_WEBHOOK_SECRET) {
    try {
      await tg.setWebhook(token, url + '/tg-platform/' + process.env.PLATFORM_WEBHOOK_SECRET, process.env.PLATFORM_WEBHOOK_SECRET);
      okMark('Вебхук платформенного бота установлен');
    } catch (e) { failMark('Вебхук: ' + e.message); }
  } else if (url) {
    const ephemeral = !!(process.env.RENDER || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME);
    if (ephemeral) {
      say('! PLATFORM_WEBHOOK_SECRET не задан. Добавьте любую случайную строку');
      say('  в переменные окружения панели и запустите setup ещё раз —');
      say('  иначе приглашения менеджеров будут работать только через опрос.');
    } else {
      const gen = require('crypto').randomBytes(16).toString('hex');
      try {
        writeEnv('PLATFORM_WEBHOOK_SECRET', gen);
        await tg.setWebhook(token, url + '/tg-platform/' + gen, gen);
        okMark('PLATFORM_WEBHOOK_SECRET создан и вебхук установлен');
      } catch (e) { say('! вебхук платформенного бота: ' + e.message + ' — будет long polling'); }
    }
  } else {
    await tg.deleteWebhook(token);
    say('· Вебхук снят: без PUBLIC_URL бот работает через long polling');
  }

  /* --- итог --- */
  const health = cfg.check();
  console.log('');
  if (!cfg.groqKey) {
    failMark('Осталось одно: ключ Groq.');
    console.log('      1. Возьмите ключ на https://console.groq.com/keys');
    console.log('      2. echo "GROQ_API_KEY=gsk_..." >> ' + cfg.envFile);
    console.log('      3. Перезапустите сервер: npm start\n');
  } else if (health.ready) {
    okMark('Всё настроено. Запускайте: npm start');
    if (url) console.log('      Мини-апп: ' + url + '\n');
    else console.log('');
  } else {
    health.blocking.forEach(b => failMark(b));
    console.log('');
  }
}

if (require.main === module) {
  main().catch(e => { console.error('\n  Ошибка: ' + e.message + '\n'); process.exit(1); });
}
module.exports = { main, writeEnv, COMMANDS, DESCRIPTION };
