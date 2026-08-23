'use strict';
/* Тест резервных копий: делаются, ротируются, и не затирают хорошую копию
 * повреждённым стором. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const DIR = path.join(os.tmpdir(), 'consul-test-backup-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });
process.env.BACKUP_KEEP = '3';

const backup = require('./backup');
const STORE = path.join(DIR, 'store.json');

let n = 0;
const pending = [];
const t = (name, fn) => {
  const r = fn();
  n++;
  if (r && typeof r.then === 'function') pending.push(r.then(() => console.log('  ✓ ' + name)));
  else console.log('  ✓ ' + name);
};

console.log('backup');

t('без файла стора копия не делается и ошибки нет', () => {
  const r = backup.makeBackup(STORE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'нечего копировать');
});

t('делает копию валидного стора', () => {
  fs.writeFileSync(STORE, JSON.stringify({ workspaces: { 1: { ownerId: '1' } } }));
  const r = backup.makeBackup(STORE);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.file));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).workspaces['1'], { ownerId: '1' });
});

t('повреждённый стор не затирает хорошие копии', () => {
  const before = backup.listBackups(STORE).length;
  fs.writeFileSync(STORE, '{это не json');
  const r = backup.makeBackup(STORE);
  assert.strictEqual(r.ok, false);
  assert.ok(/повреждён/.test(r.reason), r.reason);
  assert.strictEqual(backup.listBackups(STORE).length, before, 'число копий не изменилось');
});

t('хранит только последние KEEP копий', () => {
  fs.writeFileSync(STORE, JSON.stringify({ workspaces: {} }));
  const dir = backup.backupDir(DIR);
  // подкладываем заведомо старые копии
  for (const stamp of ['2020-01-01T00-00-00', '2020-01-02T00-00-00', '2020-01-03T00-00-00', '2020-01-04T00-00-00']) {
    fs.writeFileSync(path.join(dir, 'store-' + stamp + '.json'), '{}');
  }
  backup.makeBackup(STORE);
  const list = backup.listBackups(STORE);
  assert.strictEqual(list.length, 3, 'осталось ' + list.length);
  assert.ok(!list.some(b => /2020-01-01/.test(b.file)), 'самая старая удалена');
});

t('список копий отсортирован от новых к старым', () => {
  const list = backup.listBackups(STORE);
  const sorted = [...list].sort((a, b) => b.file.localeCompare(a.file));
  assert.deepStrictEqual(list.map(x => x.file), sorted.map(x => x.file));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

t('на пустой установке планирует раннюю копию, а не ждёт сутки', async () => {
  const dir2 = path.join(DIR, 'fresh');
  fs.mkdirSync(dir2, { recursive: true });
  const store2 = path.join(dir2, 'store.json');
  process.env.BACKUP_FIRST_MINUTES = '0.002';   // ~120 мс
  delete require.cache[require.resolve('./backup')];
  const fresh = require('./backup');

  const stop = fresh.schedule(store2);
  assert.strictEqual(fresh.listBackups(store2).length, 0, 'при старте копировать было нечего');

  fs.writeFileSync(store2, JSON.stringify({ workspaces: { 7: {} } }));
  await sleep(250);
  assert.strictEqual(fresh.listBackups(store2).length, 1, 'ранняя копия сделана без ожидания суток');
  stop();
});

Promise.all(pending).then(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('backup: ' + n + ' тестов пройдено\n');
}).catch(e => { console.error('  ✗ ' + e.message); process.exit(1); });
