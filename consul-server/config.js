'use strict';
/* ============================================================================
 * Конфигурация в одном месте: читает .env, подхватывает адрес хостинга и
 * говорит при старте, что настроено, а что нет.
 *
 * Приоритет: переменные окружения → .env → значения по умолчанию.
 * Переменные из окружения всегда выигрывают, поэтому .env безопасно коммитить
 * не надо, но и в проде он ничего не сломает.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ .env */

function loadEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) { process.env[key] = val; n++; }
  }
  return n;
}

const ENV_FILE = process.env.CONSUL_ENV_FILE || path.join(__dirname, '.env');
const envLoaded = loadEnvFile(ENV_FILE);

/* ------------------------------------------------------------ значения */

const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; };
const trimUrl = u => String(u || '').trim().replace(/\/+$/, '');

/** Render, Railway и Fly сами дают публичный адрес — используем его, если PUBLIC_URL не задан. */
function detectPublicUrl() {
  const explicit = trimUrl(process.env.PUBLIC_URL);
  if (explicit) return explicit;
  if (process.env.RENDER_EXTERNAL_URL) return trimUrl(process.env.RENDER_EXTERNAL_URL);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + trimUrl(process.env.RAILWAY_PUBLIC_DOMAIN);
  if (process.env.FLY_APP_NAME) return 'https://' + process.env.FLY_APP_NAME + '.fly.dev';
  return '';
}

const cfg = {
  port: num(process.env.PORT, 8080),
  // Читаем при обращении: адрес хостинга подставляется в окружение до старта,
  // но в тестах его меняют на лету, а зафиксированное на загрузке значение
  // молча остаётся старым.
  get publicUrl() { return detectPublicUrl(); },
  botToken: (process.env.BOT_TOKEN || '').trim(),
  botUsername: (process.env.BOT_USERNAME || '').trim().replace('@', ''),
  groqKey: (process.env.GROQ_API_KEY || '').trim(),
  allowInsecureAuth: process.env.ALLOW_INSECURE_AUTH === '1',
  // Публичный адрес есть, но сообщения всё равно забираем опросом. Нужно, когда
  // сервер живёт за туннелем на ноутбуке: после сна вебхуки теряются навсегда,
  // а опрос восстанавливается сам.
  forcePolling: process.env.FORCE_POLLING === '1',
  // Человеческое поведение во времени: паузы, живой индикатор «печатает»,
  // ответ на очередь сообщений разом. Выключается в тестах и там, где нужна
  // машинная скорость.
  get humanize() { return process.env.HUMANIZE !== '0'; },
  // Адрес, на котором слушаем. Без проверки подписи Telegram пускаем только
  // с этой же машины: иначе панель со всеми диалогами открыл бы любой,
  // кто оказался с вами в одной сети.
  get host() {
    if (process.env.HOST) return process.env.HOST;
    return this.allowInsecureAuth ? '127.0.0.1' : '0.0.0.0';
  },
  // Читаем при обращении, а не при загрузке: иначе переменную нельзя
  // ни поменять на лету, ни подставить в тесте.
  get adminIds() {
    return String(process.env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  },

  /* Лимиты — защита вашего ключа Groq от одного слишком активного кабинета. */
  limits: {
    dailyPerWorkspace: num(process.env.LIMIT_DAILY_AI, 300),   // ответов AI в сутки на кабинет
    dailyGlobal: num(process.env.LIMIT_DAILY_GLOBAL, 5000),    // ответов AI в сутки на весь сервис
    perChatPerMinute: num(process.env.LIMIT_CHAT_PER_MIN, 6),  // сообщений от одного клиента в минуту
    apiPerMinute: num(process.env.LIMIT_API_PER_MIN, 120),     // запросов мини-аппа в минуту
    knowledgeChars: num(process.env.LIMIT_KB_CHARS, 300000),   // общий объём базы знаний на кабинет
    maxWorkspaces: num(process.env.LIMIT_WORKSPACES, 0),       // 0 = без ограничения
  },

  /* Политику и условия сервер отдаёт сам на /privacy и /terms. Ссылку на них
   * показываем только когда указан оператор: документ, из которого непонятно,
   * кто отвечает за сервис и куда писать, хуже, чем его отсутствие.
   * PRIVACY_URL и TERMS_URL перекрывают встроенные страницы, если у вас свои. */
  get urls() {
    const own = require('./legal').ready();   // оператор указан — документ имеет силу
    const base = this.publicUrl || '';
    return {
      privacy: (process.env.PRIVACY_URL || '').trim() || (own && base ? base + '/privacy' : ''),
      terms: (process.env.TERMS_URL || '').trim() || (own && base ? base + '/terms' : ''),
      support: (process.env.SUPPORT_URL || '').trim(),
    };
  },
};

/* ------------------------------------------------------------ самопроверка */

/** Что мешает пустить людей: список проблем и предупреждений. */
function check() {
  const blocking = [], warnings = [], fatal = [];

  if (!cfg.botToken) {
    if (cfg.allowInsecureAuth) warnings.push('BOT_TOKEN не задан — работает режим разработки без проверки подписи Telegram');
    else blocking.push('BOT_TOKEN не задан: мини-апп не сможет авторизовать ни одного пользователя');
  }
  if (!cfg.groqKey) blocking.push('GROQ_API_KEY не задан: бот не сможет отвечать, все диалоги уйдут менеджеру');
  if (!cfg.publicUrl) warnings.push('PUBLIC_URL не задан — приём сообщений через long polling. Для продакшена укажите публичный https-адрес');
  else if (cfg.forcePolling) warnings.push('FORCE_POLLING=1 — адрес есть, но сообщения забираем опросом. Так надёжнее там, где сервис может уснуть: сообщения подождут в очереди Telegram');
  else if (!/^https:\/\//.test(cfg.publicUrl)) blocking.push('PUBLIC_URL должен начинаться с https:// — Telegram не примет вебхук по http');
  if (cfg.botToken && !cfg.botUsername) warnings.push('BOT_USERNAME не задан — не сможем выдавать ссылки-приглашения менеджерам');
  const hasRedisKv = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
                        (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
  if (!process.env.CONSUL_ENC_KEY) {
    const dir = process.env.CONSUL_DATA_DIR || '';
    const keyOnDisk = /^\/(var\/data|data|mnt|var\/lib)/.test(dir);
    if (hasRedisKv && !keyOnDisk) {
      // База во внешнем Redis, а ключ — во временной файловой системе. При
      // перезапуске ключ создастся заново, и токены ботов в Redis станет
      // нечем расшифровать: боты замолчат, и никто не поймёт почему.
      blocking.push('CONSUL_ENC_KEY не задан, а диска нет: после перезапуска токены ботов в Redis ' +
        'станет нечем расшифровать и боты замолчат. Сгенерируйте ключ (openssl rand -hex 32) ' +
        'и задайте его в переменных окружения.');
    } else {
      warnings.push('CONSUL_ENC_KEY не задан — ключ шифрования хранится в data/.enc-key рядом с базой');
    }
  }

  // На хостинге без диска и без внешней базы данные живут до перезапуска.
  // Молчать об этом нельзя: владельцы потеряют подключённых ботов.
  const onHost = !!(process.env.RENDER || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME);
  const hasRedis = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
                      (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
  const dataDir = process.env.CONSUL_DATA_DIR || '';
  const onDisk = /^\/(var\/data|data|mnt|var\/lib)/.test(dataDir);
  if (onHost && !hasRedis && !onDisk) {
    blocking.push('Данные негде хранить: нет ни диска, ни Redis. При перезапуске пропадут ' +
      'подключённые боты, база знаний и диалоги. Заведите бесплатную базу на upstash.com ' +
      'и задайте UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN.');
  }
  // Люди отдают сервису токены своих ботов и переписку своих клиентов. Пока не
  // сказано, кто за это отвечает и куда писать, показывать им политику не на что.
  if (!cfg.urls.privacy) {
    warnings.push('OPERATOR_NAME и OPERATOR_EMAIL не заданы — политика данных и условия ' +
      'открываются на /privacy и /terms, но ссылки на них в приложении скрыты: ' +
      'в документе не указано, кто отвечает за сервис');
  }

  // Это не предупреждение, а дыра: без проверки подписи любой запрос с чужим
  // user.id открывает чужой кабинет. На публичном адресе — только отказ старта.
  if (cfg.allowInsecureAuth && cfg.publicUrl) {
    fatal.push('ALLOW_INSECURE_AUTH=1 вместе с публичным адресом ' + cfg.publicUrl +
      ': проверка подписи Telegram отключена, любой сможет открыть чужой кабинет. Уберите переменную.');
  }

  return { blocking: blocking.concat(fatal), warnings, fatal, ready: blocking.length === 0 && fatal.length === 0 };
}

/** Печатает состояние конфигурации при старте. */
function report() {
  const r = check();
  const line = s => console.log('  ' + s);
  console.log('\nConsul — проверка конфигурации');
  if (envLoaded) line('· .env: подхвачено переменных — ' + envLoaded);
  line((cfg.groqKey ? '✓' : '✗') + ' Groq: ' + (cfg.groqKey ? 'ключ задан' : 'ключа нет'));
  line((cfg.botToken ? '✓' : '✗') + ' Бот Consul: ' + (cfg.botToken ? '@' + (cfg.botUsername || 'токен задан') : 'токена нет'));
  line((cfg.publicUrl ? '✓' : '·') + ' Адрес: ' + (cfg.publicUrl || 'не задан') +
    ' · приём сообщений: ' + (cfg.publicUrl && !cfg.forcePolling ? 'вебхук' : 'опрос'));
  if (cfg.host === '127.0.0.1') line('· Панель доступна только с этого компьютера');
  const redisOn = !!((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
                     (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
  line('· Хранилище: ' + (redisOn ? 'Upstash Redis' : 'файл ' + (process.env.CONSUL_DATA_DIR || 'data/')));
  line('· Лимиты: ' + cfg.limits.dailyPerWorkspace + ' ответов AI в сутки на кабинет, ' + cfg.limits.dailyGlobal + ' на сервис');
  r.warnings.forEach(w => console.warn('  ! ' + w));
  r.blocking.forEach(b => console.error('  ✗ ' + b));
  if (r.ready) console.log('  Готово к работе.\n');
  else if (r.fatal.length) console.error('  Запуск невозможен.\n');
  else console.error('  Не готово: пользователи столкнутся с проблемами выше.\n');
  return r;
}

module.exports = Object.assign(cfg, { check, report, envFile: ENV_FILE, loadEnvFile });
