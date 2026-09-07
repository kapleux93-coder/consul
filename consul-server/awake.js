'use strict';
/* ============================================================================
 * Не давать бесплатному хостингу усыпить сервис.
 *
 * Render на free-тарифе гасит инстанс через 15 минут без входящих запросов.
 * Спящий сервис не вызывает getUpdates, поэтому сообщения клиентов лежат в
 * очереди Telegram, а бот молчит — для продукта, который обещает мгновенный
 * ответ, это равносильно отсутствию продукта.
 *
 * Лечится тем, что сервис сам стучится на свой публичный адрес: запрос уходит
 * наружу и возвращается через балансировщик хостинга как входящий, а значит
 * счётчик простоя обнуляется.
 *
 * Чего этот приём НЕ делает — не будит уже уснувший инстанс: спящий процесс
 * ничего не отправляет. Разбудить может только запрос снаружи, поэтому внешняя
 * пинговалка (cron-job.org на /health) остаётся правильным решением, а это —
 * страховка на случай, если её забыли включить или она отвалилась.
 *
 * Плата за круглосуточную работу — часы инстанса: 24/7 это ~720 часов в месяц
 * при бесплатных 750. Хватает ровно на один сервис и без запаса, поэтому при
 * старте говорим об этом вслух.
 * ========================================================================== */

const DEFAULT_MINUTES = 10;    // меньше 15, чтобы успеть до засыпания

let timer = null;
let last = { at: 0, ok: false, error: '' };

/** Хостинг, который усыпляет бесплатные инстансы. */
function sleepyHost() {
  return !!process.env.RENDER;
}

/**
 * Нужно ли поддерживать сервис в бодрствующем состоянии.
 * KEEP_AWAKE=0 выключает даже там, где иначе включилось бы само;
 * KEEP_AWAKE=1 включает на любом хостинге.
 */
function wanted(publicUrl) {
  const flag = String(process.env.KEEP_AWAKE || '').trim();
  if (flag === '0' || /^(no|off|false)$/i.test(flag)) return false;
  if (!/^https?:\/\//.test(String(publicUrl || ''))) return false;
  if (flag === '1' || /^(yes|on|true)$/i.test(flag)) return true;
  return sleepyHost();
}

/** Один стук по собственному адресу. Ошибки не важны: важен сам запрос. */
async function ping(publicUrl) {
  try {
    const res = await fetch(publicUrl.replace(/\/+$/, '') + '/health', {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'consul-keep-awake' },
    });
    last = { at: Date.now(), ok: res.ok, error: res.ok ? '' : 'HTTP ' + res.status };
  } catch (e) {
    last = { at: Date.now(), ok: false, error: e.message };
  }
  return last;
}

/**
 * Запускает самопинг, если он нужен.
 * @returns {{on:boolean, minutes?:number, why?:string}}
 */
function start(publicUrl) {
  stop();
  if (!wanted(publicUrl)) {
    return { on: false, why: !publicUrl ? 'нет публичного адреса' : 'выключено' };
  }
  const minutes = Math.max(1, Math.min(14, Number(process.env.KEEP_AWAKE_MINUTES) || DEFAULT_MINUTES));
  timer = setInterval(() => { ping(publicUrl); }, minutes * 60000);
  if (timer.unref) timer.unref();
  return { on: true, minutes };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, ping, wanted, sleepyHost, status: () => last };
