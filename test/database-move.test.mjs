/**
 * Veritabani sekmesi: uzak sunucuya TASI ya da mevcut veritabanina BAGLAN. Gercek MariaDB ile (gecici veritabanlari).
 * Asil kurallar: tasima yalniz bos hedefe ve satir sayilari tutunca; baglanma yalniz bu panelin, bu surumden yeni olmayan ve bu
 * anahtarla doldurulmus veritabanina; basarisizlikta ortamin veritabanina donulur, "etkin"den sonra donulmez; parola ne yanitta
 * ne gunlukte; sinanmadan tasinmaz, tasi dugmesi sinamalari yeniden yapar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, openDb, tempDb } from './helpers.mjs';
import { Settings } from '../src/core/tables.mjs';
import { keyFingerprint } from '../src/core/crypto-labels.mjs';
import {
  ConnectionFile, allOk, checkConnect, compareMigrations, copyDatabase, openConnection, startupDatabase, testTarget, opened, failed,
} from '../src/services/database-move.mjs';

const secret = randomBytes(32);
const file = () => new ConnectionFile(mkdtempSync(join(tmpdir(), 'cam-vt-')), secret);
const quiet = { log: () => {}, warn: () => {} };
const current = (setting, extra = {}) => ({ source: 'ortam', host: setting.host, port: String(setting.port), database: setting.database, username: setting.username, custom: 0, ...extra });
const names = (items) => Object.fromEntries(items.map((m) => [m.name, m.ok]));
const q = async (setting, sql, p = []) => { const c = await openConnection(setting); try { return (await c.query(sql, p))[0].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v]))); } finally { await c.end(); } };

/** Bu anahtarla doldurulmus, uyesi olan bir panel veritabani. */
async function fullDb(key = secret) {
  const v = await openDb();
  await new Settings(v.db).write('key-fingerprint', keyFingerprint(key));
  await v.db.query("INSERT INTO users (name, role, created_at) VALUES ('eski-uye', 'admin', '2026-01-01T00:00:00Z')");
  return v;
}

test('göç karşılaştırması: ortak, bilinmeyen (daha yeni sürüm), bekleyen', () => {
  assert.deepEqual(compareMigrations([1, 2, 3], [1, 2, 3]), { common: 3, unknown: 0, pending: 0 });
  assert.deepEqual(compareMigrations([1, 2], [1, 2, 3]), { common: 2, unknown: 0, pending: 1 });
  assert.deepEqual(compareMigrations([1, 2, 3, 99], [1, 2, 3]), { common: 3, unknown: 1, pending: 0 });
  assert.deepEqual(compareMigrations([500, 501], [1, 2, 3]), { common: 0, unknown: 2, pending: 3 });
});

test('bağlantı dosyası şifreli; başarısızda silinir; yeni istek eski alanları taşımaz', () => {
  const f = file();
  f.writeConnection({ host: 'db.ornek', port: '3307', database: 'cam', username: 'u', password: 'Gizli-Parola-1', fazla: 'x' });
  assert.deepEqual(f.connection(), { host: 'db.ornek', port: 3307, database: 'cam', username: 'u', password: 'Gizli-Parola-1' });
  f.writeStage('tasinacak', null, { hedef: 'u@db.ornek:3307/cam' });
  f.writeStage('deneniyor', 'özet');
  assert.equal(f.status().hedef, 'u@db.ornek:3307/cam'); assert.equal(f.status().aciklama, 'özet');
  f.writeStage('baglanacak', null, { islem: 'baglan' });
  assert.equal(f.status().hedef, undefined); assert.equal(f.status().aciklama, undefined);
  f.writeStage('basarisiz', 'sebep');
  assert.equal(f.connection(), null);
  assert.throws(() => new ConnectionFile(f.dir, randomBytes(32)).writeStage('yok'), /Bilinmeyen/);
  rmSync(f.dir, { recursive: true, force: true });
});

test('taşı: boş hedefe kopyalar, satırlar tutar; dolu hedefe yazmaz', async () => {
  const src = await fullDb(), dst = await tempDb();
  try {
    const summary = await copyDatabase(src.setting, dst.setting, quiet);
    assert.match(summary, /tablo, \d+ satır kopyalandı; iki tarafta sayılar aynı/);
    assert.equal((await q(dst.setting, "SELECT COUNT(*) AS n FROM users WHERE name = 'eski-uye'"))[0].n, 1);
    await assert.rejects(copyDatabase(src.setting, dst.setting, quiet), /boş değil.*üzerine yazılmaz/);
  } finally { await src.remove(); await dst.remove(); }
});

test('bağlan sınamaları: bu panelin, bu sürümden yeni olmayan, bu anahtarla dolu veritabanı', async () => {
  const good = await fullDb(), otherKey = await fullDb(randomBytes(32)), empty = await tempDb(), newer = await fullDb(), self = await openDb();
  try {
    await newer.db.query("INSERT INTO migrations (version, name) VALUES (999, 'gelecek surum')");
    const run = (target) => testTarget({ target, operation: 'baglan', current: current(self.setting), secret });

    const ok = await run(good.setting);
    assert.ok(allOk(ok), JSON.stringify(ok));
    assert.equal(names(ok)['Şu anki veritabanında yalnızca tablo var'], undefined, 'bağlanmada şu anki veritabanı kopyalanmaz, sorulmaz');

    assert.equal(names(await run(otherKey.setting))['Gizli anahtar aynı'], false);
    assert.equal(names(await run(empty.setting))['Hedef bu panelin dolu veritabanı'], false);
    assert.equal(names(await run(newer.setting))['Hedef bu sürümden yeni değil'], false);

    // Tasi: dolu hedef reddedilir, bos hedef kabul edilir.
    assert.equal(names(await testTarget({ target: good.setting, operation: 'tasi', current: current(self.setting), secret }))['Hedef veritabanı boş'], false);
    assert.ok(allOk(await testTarget({ target: empty.setting, operation: 'tasi', current: current(self.setting), secret })));
    // Kendisi hedef olamaz; ozel nesne varken tasinmaz.
    assert.equal(names(await run(self.setting))['Hedef başka bir veritabanı'], false);
    assert.equal(names(await testTarget({ target: empty.setting, operation: 'tasi', current: current(self.setting, { custom: 2 }), secret }))['Şu anki veritabanında yalnızca tablo var'], false);
  } finally { for (const v of [good, otherKey, empty, newer, self]) await v.remove(); }
});

test('açılış: taşı → kopya → deneniyor → etkin; bağlantı uzak veritabanına geçer', async () => {
  const src = await fullDb(), dst = await tempDb(), f = file();
  try {
    f.writeConnection(dst.setting); f.writeStage('tasinacak', null, { hedef: 'x' });
    const r = await startupDatabase({ setting: src.setting, file: f, ...quiet });
    assert.equal(r.stage, 'deneniyor'); assert.equal(r.setting.database, dst.name);
    assert.match(f.status().aciklama, /satır kopyalandı/);
    opened(f, r.stage, () => {});
    assert.equal(f.stage(), 'etkin');
    // Sonraki aciliş: etkin -> uzak veritabani, kopya yok.
    const again = await startupDatabase({ setting: src.setting, file: f, ...quiet });
    assert.equal(again.stage, 'etkin'); assert.equal(again.setting.database, dst.name);
  } finally { await src.remove(); await dst.remove(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('açılış: bağlan kopyalamaz; boş hedefte başarısız olur ve ortamın veritabanıyla devam eder', async () => {
  const env = await openDb(), old = await fullDb(), empty = await tempDb(), f = file();
  try {
    f.writeConnection(old.setting); f.writeStage('baglanacak', null, { islem: 'baglan' });
    const r = await startupDatabase({ setting: env.setting, file: f, ...quiet });
    assert.equal(r.stage, 'deneniyor'); assert.equal(r.setting.database, old.name);
    assert.match(f.status().aciklama, /bağlanıldı .*kopya yapılmadı/);
    assert.equal((await q(env.setting, "SELECT COUNT(*) AS n FROM users WHERE name = 'eski-uye'"))[0].n, 0, 'ortamın veritabanına yazılmaz');

    // Uzak veritabaniyla ilk acilis olmadi: basarisiz, baglanti dosyasi silinir; sonraki acilis ortamin veritabani.
    assert.equal(failed(f, r.stage, new Error('göç patladı')), true);
    assert.equal(f.stage(), 'basarisiz'); assert.match(f.status().aciklama, /hedefteki veriye dokunmayın/); assert.equal(f.connection(), null);
    const next = await startupDatabase({ setting: env.setting, file: f, ...quiet });
    assert.equal(next.setting.database, env.name);

    f.writeConnection(empty.setting); f.writeStage('baglanacak');
    const bad = await startupDatabase({ setting: env.setting, file: f, ...quiet });
    assert.equal(bad.stage, 'basarisiz'); assert.equal(bad.setting.database, env.name); assert.match(f.status().aciklama, /boş; bağlanacak veri yok/);
    await assert.rejects(checkConnect(empty.setting), /boş/);
  } finally { await env.remove(); await old.remove(); await empty.remove(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('açılış: işlemin ortasında kapanan açılış ortamın veritabanına döner; etkinken dosya yoksa durur', async () => {
  const env = await tempDb(), f = file();
  try {
    f.writeConnection(env.setting); f.writeStage('tasinacak'); f.writeStage('tasiniyor');
    const r = await startupDatabase({ setting: env.setting, file: f, ...quiet });
    assert.equal(r.stage, 'basarisiz'); assert.match(f.status().aciklama, /ortasında kapandı/);
    f.writeStage('tasinacak'); f.writeStage('deneniyor'); f.writeStage('etkin'); f.deleteConnection();
    await assert.rejects(startupDatabase({ setting: env.setting, file: f, ...quiet }), /kendiliğinden ona dönülmez/);
  } finally { await env.remove(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('uçlar: yalnız database.manage; sına sonra bağlan; parola yanıtta ve günlükte yok; panel yeniden başlatılır', async () => {
  const old = await fullDb(), restarts = [];
  // "uzak.test" adresi sinamada gercek test sunucusuna yonlendirilir (konteyner ici adresler reddedildigi icin).
  const connect = (t) => openConnection(t.host === 'uzak.test' ? { ...t, host: old.setting.host, port: old.setting.port } : t);
  const { req, login, services, close } = await openApp({ databaseMove: { restart: () => restarts.push(1), connect } });
  try {
    await login('admin', 'adminparola1');
    // Ayni anahtar: eski veritabani bu panelin anahtariyla doldurulmus olsun.
    await old.db.query("UPDATE settings SET value = ? WHERE name = 'key-fingerprint'", [JSON.stringify(keyFingerprint(services.databaseMove.secret))]);
    const target = { host: 'uzak.test', port: old.setting.port, database: old.name, username: old.setting.username, password: old.setting.password };

    const info = await req('/api/database');
    assert.equal(info.status, 200, info.text); assert.equal(info.json.canStart, true); assert.equal(info.json.current.source, 'ortam');

    const none = await req('/api/database/migrate', { method: 'POST', body: {} });
    assert.equal(none.status, 409); assert.match(none.json.error, /Önce bağlantıyı sınayın/);
    const local = await req('/api/database/test', { method: 'POST', body: { ...target, host: 'localhost' } });
    assert.equal(local.status, 400); assert.match(local.json.error, /konteynerin kendisi/);

    const t = await req('/api/database/test', { method: 'POST', body: { ...target, islem: 'baglan' } });
    assert.equal(t.status, 200, t.text); assert.equal(t.json.ok, true, JSON.stringify(t.json.results));
    assert.equal(t.json.tested.islem, 'baglan'); assert.ok(!t.text.includes(target.password));

    const m = await req('/api/database/migrate', { method: 'POST', body: { reason: 'yeni sunucu' } });
    assert.equal(m.status, 202, m.text); assert.match(m.json.message, /Bağlanma istendi/); assert.ok(!m.text.includes(target.password));
    assert.equal(restarts.length, 1);
    const f = services.databaseMove.file;
    assert.equal(f.stage(), 'baglanacak'); assert.equal(f.status().islem, 'baglan'); assert.equal(f.connection().database, old.name);

    const again = await req('/api/database');
    assert.equal(again.json.canStart, false); assert.equal(again.json.status.durum, 'baglanacak');
    const log = await req('/api/audit-log');
    assert.ok(log.text.includes('database-connect'), log.text.slice(0, 300)); assert.ok(!log.text.includes(target.password));

    // database.manage olmayan goremez.
    const u = await req('/api/members', { method: 'POST', body: { name: 'ali', password: 'aliparola1', role: 'camera' } });
    assert.equal(u.status, 200, u.text);
    await login('ali', 'aliparola1');
    for (const [path, method] of [['/api/database', 'GET'], ['/api/database/test', 'POST'], ['/api/database/migrate', 'POST']]) {
      const y = await req(path, { who: 'ali', method, body: method === 'GET' ? undefined : {} });
      assert.equal(y.status, 403, `${method} ${path}: ${y.text}`); assert.equal(y.json.requiredPermission, 'database.manage');
    }
    assert.ok(existsSync(join(f.dir, 'connection.json')));
  } finally { await close(); await old.remove(); }
});
