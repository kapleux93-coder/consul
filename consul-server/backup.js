'use strict';
/* ============================================================================
 * Резервные копии хранилища.
 *
 * Данные лежат в одном JSON-файле, и потерять его — значит заставить всех
 * владельцев подключать ботов заново. Поэтому раз в сутки (и при старте)
 * делаем копию рядом, храним последние N штук.
 *
 * Копия пишется только если файл читается как валидный JSON: испорченный
 * стор не должен вытеснить последнюю хорошую копию.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const KEEP = Number(process.env.BACKUP_KEEP) || 7;
const EVERY_MS = (Number(process.env.BACKUP_EVERY_HOURS) || 24) * 3600 * 1000;

function backupDir(dataDir) { return path.join(dataDir, 'backups'); }

/**
 * Делает копию файла стора.
 * @returns {{ok:boolean, file?:string, reason?:string}}
 */
function makeBackup(storeFile) {
  let raw;
  try { raw = fs.readFileSync(storeFile, 'utf8'); }
  catch (e) { return { ok: false, reason: 'нечего копировать' }; }

  try { JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'стор повреждён — копию не делаю, чтобы не затереть хорошую' }; }

  const dir = backupDir(path.dirname(storeFile));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, reason: e.message }; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, 'store-' + stamp + '.json');
  try { fs.writeFileSync(file, raw); } catch (e) { return { ok: false, reason: e.message }; }

  prune(dir);
  return { ok: true, file, bytes: raw.length };
}

/** Оставляет только последние KEEP копий. */
function prune(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^store-.*\.json$/.test(f)).sort(); }
  catch (e) { return []; }
  const extra = files.slice(0, Math.max(0, files.length - KEEP));
  for (const f of extra) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
  return extra;
}

function listBackups(storeFile) {
  const dir = backupDir(path.dirname(storeFile));
  try {
    return fs.readdirSync(dir)
      .filter(f => /^store-.*\.json$/.test(f))
      .sort().reverse()
      .map(f => { const st = fs.statSync(path.join(dir, f)); return { file: f, bytes: st.size, at: st.mtime.toISOString() }; });
  } catch (e) { return []; }
}

const FIRST_MS = (Number(process.env.BACKUP_FIRST_MINUTES) || 10) * 60 * 1000;

/**
 * Запускает периодические копии. Возвращает функцию остановки.
 *
 * Кроме суточного цикла делает раннюю копию через FIRST_MS: на свежей
 * установке при старте файла стора ещё нет, и без этого первая резервная
 * копия появилась бы только через сутки работы.
 */
function schedule(storeFile) {
  const run = quiet => {
    const r = makeBackup(storeFile);
    if (r.ok) console.log('[backup] копия: ' + path.basename(r.file) + ' (' + Math.round(r.bytes / 1024) + ' КБ)');
    else if (r.reason !== 'нечего копировать') console.warn('[backup] ' + r.reason);
    else if (!quiet) console.log('[backup] стор пока пуст, первая копия — через ' + Math.round(FIRST_MS / 60000) + ' мин');
    return r;
  };

  const first = run(false);
  const timers = [];
  if (!first.ok) {
    const early = setTimeout(() => run(true), FIRST_MS);
    if (early.unref) early.unref();
    timers.push(early);
  }
  const timer = setInterval(() => run(true), EVERY_MS);
  if (timer.unref) timer.unref();
  timers.push(timer);

  return () => timers.forEach(t => { clearTimeout(t); clearInterval(t); });
}

module.exports = { makeBackup, listBackups, schedule, prune, backupDir, KEEP };
