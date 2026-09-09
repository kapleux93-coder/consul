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
 * Плата за круглосуточную работу — часы инстанса: 24/7 это 720 часов в месяц
 * из 750 бесплатных, а в 31-дневном месяце все 744. Хватает ровно на один
 * сервис и почти без запаса, поэтому при старте говорим об этом вслух, а у
 * последней черты перестаём будить себя сами — см. BUDGET_HOURS.
 * ========================================================================== */

const DEFAULT_MINUTES = 10;    // меньше 15, чтобы успеть до засыпания

/* Бесплатных часов на воркспейс Render даёт 750 в месяц, и это жёсткий обрыв:
 * кончились — сервис останавливают до первого числа. Круглосуточная работа
 * съедает 744 часа в 31-дневном месяце, то есть запаса почти нет. Поэтому
 * держим свой счётчик и у последней черты перестаём будить себя сами: пусть
 * сервис засыпает между разговорами, но доживёт до конца месяца. */
const BUDGET_HOURS = Number(process.env.KEEP_AWAKE_BUDGET_HOURS) || 700;

let timer = null;
let last = { at: 0, ok: false, error: '' };
let tickedAt = 0;
let store = null;              // подставляется в start(), чтобы модуль остался автономным
let onBudget = null;           // кого позвать, когда часы на исходе
let budgetHit = false;

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Сколько часов сервис уже проработал в этом месяце. */
function usedHours() {
  if (!store) return 0;
  const h = store.hours();
  return h.month === month() ? h.minutes / 60 : 0;
}

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
function start(publicUrl, opts = {}) {
  stop();
  store = opts.store || null;
  onBudget = typeof opts.onBudget === 'function' ? opts.onBudget : null;
  budgetHit = false;
  if (!wanted(publicUrl)) {
    return { on: false, why: !publicUrl ? 'нет публичного адреса' : 'выключено' };
  }
  const minutes = Math.max(1, Math.min(14, Number(process.env.KEEP_AWAKE_MINUTES) || DEFAULT_MINUTES));
  tickedAt = Date.now();
  timer = setInterval(() => tick(publicUrl, minutes), minutes * 60000);
  if (timer.unref) timer.unref();
  return { on: true, minutes, usedHours: usedHours(), budget: BUDGET_HOURS };
}

/** Один цикл: посчитать проработанное время и, если бюджет цел, стукнуться к себе. */
async function tick(publicUrl, minutes) {
  const now = Date.now();
  // Считаем фактически прошедшее время, но не больше периода с запасом: если
  // процесс всё-таки уснул, это не должно записаться в отработанные часы.
  const elapsed = Math.min((now - tickedAt) / 60000, minutes * 1.5);
  tickedAt = now;
  const used = store ? store.addMinutes(month(now), Math.max(0, elapsed)) / 60 : 0;

  if (store && used >= BUDGET_HOURS) {
    if (!budgetHit) {
      budgetHit = true;
      const left = Math.max(0, Math.round(750 - used));
      console.warn('[awake] бесплатные часы на исходе (' + Math.round(used) + ' ч) — перестаю будить себя');
      if (onBudget) onBudget(Math.round(used), left);
    }
    return;                     // дальше сервис засыпает как обычный бесплатный
  }
  return ping(publicUrl);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, ping, wanted, sleepyHost, tick, usedHours, month,
  BUDGET_HOURS, status: () => last };
