/**
 * Veritabani katmani: goclerin tekrar kosmasi, gizli anahtar kurallari, bir kerelik JSON aktarimi (basari, tekrar, dolu tablo, bozuk dosya,
 * bozuk zincir), yazma hatasinda bellegin degismemesi, saglik yoklamasi, yeniden aciliste kalicilik, gunluk sirasi.
 * Gercek MariaDB gerekir (test/helpers.mjs: DB_HOST, DB_USERNAME, DB_PASSWORD).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/models/device.mjs';
import { Database } from '../src/core/database.mjs';
import { resolveSecretKey } from '../src/core/secret-key.mjs';
import { MIGRATIONS } from '../src/database/migrations.mjs';
import { tempDb, openApp, openDb } from './helpers.mjs';

const newFolder = () => mkdtempSync(join(tmpdir(), 'cam-db-'));
const remove = (k) => rmSync(k, { recursive: true, force: true });
const write = (k, name, o) => writeFileSync(join(k, name), typeof o === 'string' ? o : JSON.stringify(o, null, 2));

/** Gecerli imza zincirli bir gunluk.jsonl metni. */
function chain(secret, n = 3, current = false) {
  const names = current
    ? { time: 'time', local: 'localTime', event: 'event', user: 'username', previous: 'previous', signature: 'signature' }
    : { time: 'z', local: 'yerel', event: 'olay', user: 'kullanici', previous: 'onceki', signature: 'imza' };   // JSON-era (Turkish) record keys
  let previous = '', rows = [];
  for (let i = 0; i < n; i++) {
    const k = { [names.time]: `2026-10-0${i + 1}T08:00:00.000Z`, [names.local]: `2026-10-0${i + 1} 11:00:00 Europe/Istanbul`, [names.event]: i ? 'cikis' : 'giris', [names.user]: 'admin', ip: '192.0.2.1', port: 1, ua: 'x', [names.previous]: previous };
    k[names.signature] = createHmac('sha256', secret).update(previous + JSON.stringify(k)).digest('hex');
    previous = k[names.signature]; rows.push(JSON.stringify(k));
  }
  return rows.join('\n') + '\n';
}

/** Eski bicimde tam bir veri klasoru kurar (gizli.anahtar dahil). */
function legacyFolder(secret) {
  const k = newFolder();
  writeFileSync(join(k, 'gizli.anahtar'), secret);
  const salt = randomBytes(16);
  write(k, 'kullanicilar.json', [{ name: 'admin', role: 'admin', salt: salt.toString('hex'), hash: scryptSync('eskiparola1', salt, 32).toString('hex'), createdAt: '2026-10-01T08:00:00.000Z', sessionVersion: 0, scope: null, expiresAt: null, ips: [] }]);
  const repo = new DeviceStore(null, secret);
  write(k, 'cihazlar.json', { version: 1, blockLimit: 8, devices: [{ id: 'aaaa1111', name: 'Eski A', type: 'mock', host: '127.0.0.31', username: 'a', password: repo.encrypt('b'), label: 'A', channelCount: 4, startIndex: 0, createdAt: '2026-10-01T08:00:00.000Z' }] });
  write(k, 'yetki.json', { version: 1, roles: { viewer: { name: 'İzleyici', description: '', permissions: ['live.view'], createdBy: 'admin', createdAt: '2026-10-02T08:00:00.000Z' } }, builtinPermissions: {}, keys: [] });
  write(k, 'kanallar.json', { 0: { name: 'Kapı', view: 'auto' } });
  write(k, 'live-duzen.json', { column: 3, paths: ['k0'], savedBy: 'admin', time: '2026-10-03T08:00:00.000Z' });
  write(k, 'guncelleme.json', { status: 'current', running: 'a'.repeat(40) });
  write(k, 'merkez-baglari.json', { '5a0d0000-0000-7000-8000-000000000001': { name: 'admin', email: 'admin@ornek.test', role: 'admin', canLogin: true, check: null, lastLogin: null } });
  write(k, 'gunluk.jsonl', chain(secret));
  return k;
}
const LEGACY = ['kullanicilar.json', 'yetki.json', 'cihazlar.json', 'kanallar.json', 'gunluk.jsonl', 'merkez-baglari.json', 'guncelleme.json', 'live-duzen.json'];
const count = async (t, table) => Number((await t.services.db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);

test('goc: sema kurulur, tekrar kosunca bir sey yapmaz, surum tablosu dolu', async () => {
  const v = await openDb();
  try {
    assert.deepEqual(await v.db.runMigrations(), [], 'vtAc zaten kosturdu; ikinci kosu bos olmali');
    const rows = await v.db.query('SELECT version FROM migrations ORDER BY version');
    assert.deepEqual(rows.map((s) => s.version), MIGRATIONS.map((m) => m.version));
    const tables = (await v.db.query('SHOW TABLES')).map((r) => Object.values(r)[0]).sort();
    assert.deepEqual(tables, ['api_keys', 'audit_log', 'builtin_role_permissions', 'devices', 'hub_links', 'migrations', 'roles', 'settings', 'users']);
  } finally { await v.remove(); }
});

test('gecici ariza: ulasilamayan veritabani sure dolunca anlasilir hatayla biter', async () => {
  const db = new Database({ host: '127.0.0.1', port: 1, database: 'x', username: 'x', password: '', waitingSec: 1 });
  await assert.rejects(() => db.connect({ waitingSec: 1, rangeMs: 200 }), /Veritabanına bağlanılamadı/);
});

test('gizli anahtar: ortamdan, dosyadan; farkliysa ya da bozuksa acilis durur', () => {
  const k = newFolder(), file = join(k, 'secret.key');
  try {
    const a = resolveSecretKey({ env: '', file });
    assert.equal(a.length, 32); assert.ok(existsSync(file));
    assert.deepEqual(resolveSecretKey({ env: '', file }), a, 'dosya varsa ayni anahtar');
    assert.deepEqual(resolveSecretKey({ env: a.toString('base64'), file }), a, 'ortam dosyayla ayniysa tamam');
    assert.throws(() => resolveSecretKey({ env: randomBytes(32).toString('base64'), file }), /farklı/);
    assert.throws(() => resolveSecretKey({ env: 'kisa', file }), /geçersiz/);
    assert.throws(() => resolveSecretKey({ env: randomBytes(16).toString('base64'), file }), /geçersiz/);
    const newFile = join(k, 'baska.anahtar'), e = randomBytes(32);
    assert.deepEqual(resolveSecretKey({ env: e.toString('base64'), file: newFile }), e);
    assert.ok(!existsSync(newFile), 'ortamdan gelen anahtar dosyaya yazilmaz');
  } finally { remove(k); }
});

test('gizli anahtar: eski ad (gizli.anahtar) secret.key olur, anahtar ayni kalir', () => {
  const k = newFolder(), old = join(k, 'gizli.anahtar'), fresh = join(k, 'secret.key'), a = randomBytes(32);
  try {
    writeFileSync(old, a);
    assert.deepEqual(resolveSecretKey({ env: '', file: fresh }), a);
    assert.ok(existsSync(fresh) && !existsSync(old), 'eski ad yeniden adlandirildi');
    writeFileSync(old, randomBytes(32));
    assert.deepEqual(resolveSecretKey({ env: '', file: fresh }), a, 'yeni ad varsa eskiye dokunulmaz');
    assert.ok(existsSync(old));
  } finally { remove(k); }
});

test('gizli anahtar: veritabanini dolduran anahtardan farkliysa acilis durur (anahtar veritabanina girmez)', async () => {
  const g = await tempDb(), k = newFolder();
  try {
    const key = randomBytes(32).toString('base64');
    const t = await openApp({ data: k, database: g, secretKey: key });
    const stored = JSON.stringify(await t.services.db.query('SELECT * FROM settings'));
    assert.ok(!stored.includes(key), 'anahtarin kendisi veritabaninda yok');
    assert.ok(!existsSync(join(k, 'secret.key')), 'ortamdan gelen anahtar dosyaya yazilmaz');
    await t.close();
    await assert.rejects(() => openApp({ data: newFolder(), database: g, secretKey: randomBytes(32).toString('base64') }), /Gizli anahtar bu veritabanını/);
    const t2 = await openApp({ data: k, database: g, secretKey: key });   // dogru anahtarla yeniden acilir
    await t2.close();
  } finally { remove(k); await g.remove(); }
});

test('aktarim: eski dosyalar tek islemde tablolara gecer, sayilar ve zincir tutar, dosyalar .imported olur, tekrar acilista bir sey yapmaz', async () => {
  const secret = randomBytes(32), k = legacyFolder(secret), g = await tempDb();
  try {
    const t = await openApp({ data: k, database: g });
    assert.equal(await count(t, 'users'), 1); assert.equal(await count(t, 'devices'), 1); assert.equal(await count(t, 'roles'), 1);
    assert.equal(await count(t, 'audit_log'), 3); assert.equal(await count(t, 'hub_links'), 1);
    const setting = (await t.services.db.query('SELECT name FROM settings ORDER BY name')).map((r) => r.name);
    assert.ok(['channels', 'device-block-limit', 'live-layout', 'update-status'].every((a) => setting.includes(a)), setting.join());
    assert.equal(JSON.parse((await t.services.db.query("SELECT value FROM settings WHERE name = 'device-block-limit'"))[0].value), 8);
    for (const d of LEGACY) { assert.ok(!existsSync(join(k, d)), `${d} yeniden adlandirilmali`); assert.ok(existsSync(join(k, `${d}.imported`)), `${d}.imported var olmali`); }
    // giris eski parolayla, gunluk zinciri veritabanindan dogrulanir, cihaz parolasi eski anahtarla cozulur
    await t.login('admin', 'eskiparola1');
    const z = await t.req('/api/audit-log/verify');
    assert.equal(z.json.ok, true); assert.ok(z.json.record >= 3);
    assert.equal(t.services.devices.repo.setting('aaaa1111').password, 'b');
    assert.equal((await t.req('/live/layout.json', { who: null })).status, 404, 'live kapali ama duzen kaydi hizmette');
    assert.deepEqual(t.services.live.layout().paths, ['k0']);
    assert.equal(t.services.devices.channelSetting[0].name, 'Kapı');
    const counts = { u: await count(t, 'users'), d: await count(t, 'devices') };
    await t.close();
    // tekrar acilista aktarim bir sey yapmaz (dosyalar gitti, tablolar dolu)
    const t2 = await openApp({ data: k, database: g, secretKey: '' });
    assert.equal(await count(t2, 'users'), counts.u); assert.equal(await count(t2, 'devices'), counts.d);
    await t2.close();
  } finally { remove(k); await g.remove(); }
});

test('aktarim: tablolar doluysa ve eski dosyalar varsa dokunulmaz (dosyalar yerinde kalir)', async () => {
  const g = await tempDb(), k = newFolder();
  try {
    const t = await openApp({ data: k, database: g });          // bos veritabani: admin olusur
    const secret = readFileSync(join(k, 'secret.key'));
    await t.close();
    write(k, 'kullanicilar.json', [{ name: 'hayalet', role: 'admin', salt: '00', hash: '00', createdAt: '2026-10-01T08:00:00.000Z' }]);
    const t2 = await openApp({ data: k, database: g });
    assert.equal((await t2.services.db.query("SELECT name FROM users WHERE name = 'hayalet'")).length, 0);
    assert.ok(existsSync(join(k, 'kullanicilar.json')), 'dosya yerinde');
    assert.deepEqual(readFileSync(join(k, 'secret.key')), secret);
    await t2.close();
  } finally { remove(k); await g.remove(); }
});

test('aktarim: bozuk dosya ya da bozuk zincirde acilis durur, hicbir sey yazilmaz, dosyalar yerinde kalir', async () => {
  for (const corrupt of [(k) => write(k, 'cihazlar.json', '{bozuk'), (k) => write(k, 'gunluk.jsonl', chain(readFileSync(join(k, 'gizli.anahtar'))).replace('"giris"', '"giriss"'))]) {
    const secret = randomBytes(32), k = legacyFolder(secret), g = await tempDb();
    try {
      corrupt(k);
      await assert.rejects(() => openApp({ data: k, database: g }));
      const db = await new Database(g.setting).connect({ waitingSec: 5 });
      for (const table of ['users', 'devices', 'roles', 'audit_log', 'hub_links']) assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n), 0, `${table} bos kalmali`);
      await db.close();
      for (const d of LEGACY) assert.ok(existsSync(join(k, d)), `${d} yerinde olmali`);
    } finally { remove(k); await g.remove(); }
  }
});

test('aktarim: sayilar tutmazsa (ayni anahtarli iki kayit) islem geri alinir', async () => {
  const secret = randomBytes(32), k = legacyFolder(secret), g = await tempDb();
  try {
    const u = JSON.parse(readFileSync(join(k, 'kullanicilar.json'), 'utf8'));
    write(k, 'kullanicilar.json', [...u, { ...u[0], name: 'ADMIN' }]);       // buyuk/kucuk harf ayni ad: tabloda benzersiz degil
    await assert.rejects(() => openApp({ data: k, database: g }));
    const db = await new Database(g.setting).connect({ waitingSec: 5 });
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM users'))[0].n), 0);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM audit_log'))[0].n), 0, 'zincir de geri alindi');
    await db.close();
    assert.ok(existsSync(join(k, 'gunluk.jsonl')));
  } finally { remove(k); await g.remove(); }
});

test('veritabani yazma hatasi: kullaniciya 500, bellek degismez, basarisiz isten sonra sistem calisir', async () => {
  const t = await openApp();
  try {
    await t.login('admin', 'adminparola1');
    const db = t.services.db, real = db.transaction.bind(db);
    db.transaction = async () => { throw Object.assign(new Error('baglanti koptu'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    const error = console.error; console.error = () => {};
    try {
      const r = await t.req('/api/members', { method: 'POST', body: { name: 'yeni1', password: 'yeniparola1', role: 'admin' } });
      assert.equal(r.status, 500); assert.equal(r.json.code, 'DATABASE');
      assert.ok(!r.text.includes('baglanti koptu'), 'ic ayrinti disari verilmez');
      assert.equal(t.services.members.find('yeni1'), null, 'bellek degismedi');
      const c = await t.req('/api/devices', { method: 'POST', body: { name: 'X', type: 'mock', host: '127.0.0.77', username: 'u', password: 'p1234567', label: 'N' } });
      assert.equal(c.status, 500);
      assert.equal(t.services.devices.list().length, 2, 'cihaz listesi degismedi');
      const role = await t.req('/api/access/roles', { method: 'POST', body: { id: 'deneme', name: 'd', permissions: ['live.view'] } });
      assert.equal(role.status, 500); assert.equal(t.services.permissions.roleVar('deneme'), false);
    } finally { console.error = error; db.transaction = real; }
    const r2 = await t.req('/api/members', { method: 'POST', body: { name: 'yeni1', password: 'yeniparola1', role: 'admin' } });
    assert.equal(r2.status, 200, r2.text);
    assert.ok(t.services.members.find('yeni1'));
    assert.equal((await t.services.db.query("SELECT name FROM users WHERE name = 'yeni1'")).length, 1, 'veritabanina da yazildi');
  } finally { await t.close(); }
});

test('saglik yoklamasi: veritabanina ulasilamiyorsa 503', async () => {
  const t = await openApp();
  try {
    assert.equal((await t.req('/api/v1/health', { who: null })).status, 200);
    const db = t.services.db, real = db.healthy.bind(db);
    db.healthy = async () => false;
    try { assert.equal((await t.req('/api/v1/health', { who: null })).status, 503); } finally { db.healthy = real; }
  } finally { await t.close(); }
});

test('kalicilik: kapatip ayni veritabaniyla acinca uye, cihaz, rol ve anahtar yerinde; ilk admin yeniden olusmaz', async () => {
  const g = await tempDb(), k = newFolder();
  try {
    const t = await openApp({ data: k, database: g });
    await t.login('admin', 'adminparola1');
    assert.equal((await t.req('/api/members', { method: 'POST', body: { name: 'kalici1', password: 'kaliciparola1', role: 'admin' } })).status, 200);
    assert.equal((await t.req('/api/access/roles', { method: 'POST', body: { id: 'rol1', name: 'R', permissions: ['live.view'] } })).status, 200);
    const ak = await t.req('/api/access/keys', { method: 'POST', body: { name: 'k1', role: 'rol1' } });
    assert.equal(ak.status, 200, ak.text);
    assert.equal((await t.req('/api/devices', { method: 'POST', body: { name: 'Yeni', type: 'mock', host: '127.0.0.78', username: 'u', password: 'p1234567', label: 'N' } })).status, 200);
    await t.close();
    const t2 = await openApp({ data: k, database: g });
    assert.equal((await t2.services.db.query('SELECT name FROM users')).length, 2);
    await t2.login('kalici1', 'kaliciparola1');
    assert.ok(t2.services.permissions.roleVar('rol1'));
    assert.equal((await t2.req('/api/v1/me', { bearer: ak.json.key })).status, 200, 'API anahtari yeniden acilista gecerli');
    assert.equal(t2.services.devices.list().length, 3);
    await t2.close();
  } finally { remove(k); await g.remove(); }
});

test('gunluk: es zamanli yazimlar sirayla eklenir, zincir bozulmaz', async () => {
  const t = await openApp();
  try {
    await t.login('admin', 'adminparola1');
    await Promise.all(Array.from({ length: 40 }, (_, i) => t.services.auditLog.write('deneme', 'system', null, { i })));
    const d = await t.req('/api/audit-log/verify');
    assert.equal(d.json.ok, true); assert.ok(d.json.record >= 41);
    const l = await t.req('/api/audit-log?event=deneme&size=200');
    assert.equal(l.json.total, 40);
    assert.deepEqual(l.json.records.map((x) => x.i), Array.from({ length: 40 }, (_, i) => 39 - i), 'en yeni ustte, ekleme sirasi korunur');
    // LIKE ozel karakterleri suzgecte duz metin sayilir
    assert.equal((await t.req('/api/audit-log?username=%25')).json.total, 0);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------- goc v2 (Turkce donem adlari -> Ingilizce)
const sealed = (o) => JSON.stringify(o);
/** Surum 1 semasini kurar ve Turkce donem degerleriyle doldurur. */
async function v1Database() {
  const g = await tempDb(), db = await new Database(g.setting).connect({ waitingSec: 5 });
  for (const sql of MIGRATIONS[0].sql) await db.pool.query(sql);
  await db.pool.query('CREATE TABLE migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  await db.pool.query("INSERT INTO migrations (version, name) VALUES (1, 'initial schema')");
  const q = (sql, p) => db.pool.query(sql, p);
  await q('INSERT INTO users (name, role, scope, preferences) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', ['teknisyen', 'teknik', sealed({ cihazlar: ['a'], kanallar: ['0'] }), sealed({ hepsiSayi: 4, izgaraAkis: 'alt' }), 'ozel', 'ozelrol', null, null]);
  await q('INSERT INTO devices (id, name, type, host, template, password, channel_count) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
    ['d1', 'A', 'kamera', '192.0.2.1', 'ozel', sealed({ iv: 'aa', etiket: 'bb', veri: 'cc' }), 4, 'd2', 'B', 'sahte', '192.0.2.2', 'hik', sealed({ iv: 'aa', tag: 'bb', data: 'cc' }), 4]);
  await q('INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?)', ['r1', 'Izleyici', sealed(['canli.izle', 'kayit.*', 'live.view'])]);
  await q('INSERT INTO builtin_role_permissions (role, permissions) VALUES (?, ?)', ['muhasebe', sealed(['gunluk.oku'])]);
  await q('INSERT INTO api_keys (id, name, role, permissions, scope, last_used, revoked) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['k1', 'K', 'kamera', sealed(['cihaz.oku']), sealed({ cihazlar: ['a'] }), sealed({ z: '2026-10-01', ip: '192.0.2.1' }), sealed({ z: '2026-10-02', kim: 'admin' })]);
  await q('INSERT INTO hub_links (sub, username, role) VALUES (?, ?, ?)', ['s1', 'x', 'teknik']);
  await q('INSERT INTO settings (name, value) VALUES (?, ?), (?, ?), (?, ?)', ['channels', sealed({ 0: { ad: 'Kapi', gorunum: 'gizle' } }), 'live-layout', sealed({ sutun: 3, yollar: ['k0'], kaydeden: 'admin', zaman: 't' }), 'update-status', sealed({ durum: 'guncel', calisan: 'abc', commitler: [{ baslik: 'x', tarih: 'y' }] })]);
  return { g, db, q, remove: async () => { await db.close(); await g.remove(); } };
}
const snapshot = async (q) => {
  const out = {};
  for (const t of ['users', 'devices', 'roles', 'builtin_role_permissions', 'api_keys', 'hub_links', 'settings']) out[t] = (await q(`SELECT * FROM ${t} ORDER BY 1`))[0];
  return JSON.parse(JSON.stringify(out));
};

test('goc v2: Turkce donem degerleri Ingilizceye cevrilir, tekrar kosunca degismez, cevrilmis veri aynen kalir', async () => {
  const v = await v1Database();
  try {
    assert.deepEqual(await v.db.runMigrations(), [2]);
    const s = await snapshot(v.q);
    const u = s.users.find((x) => x.name === 'teknisyen');
    assert.equal(u.role, 'technical'); assert.deepEqual(JSON.parse(u.scope), { devices: ['a'], channels: ['0'] }); assert.deepEqual(JSON.parse(u.preferences), { allCount: 4, gridStream: 'sub' });
    assert.equal(s.users.find((x) => x.name === 'ozel').role, 'ozelrol', 'ozel rol kimligi veridir, degismez');
    const d1 = s.devices.find((x) => x.id === 'd1'), d2 = s.devices.find((x) => x.id === 'd2');
    assert.equal(d1.type, 'camera'); assert.equal(d1.template, 'custom'); assert.deepEqual(JSON.parse(d1.password), { iv: 'aa', tag: 'bb', data: 'cc' });
    assert.equal(d2.type, 'mock'); assert.equal(d2.template, 'hik'); assert.equal(d2.password, sealed({ iv: 'aa', tag: 'bb', data: 'cc' }), 'cevrilmis olan metin aynen kalir');
    assert.deepEqual(JSON.parse(s.roles[0].permissions), ['live.view', 'recording.*']);
    assert.equal(s.builtin_role_permissions[0].role, 'accounting'); assert.deepEqual(JSON.parse(s.builtin_role_permissions[0].permissions), ['audit.read']);
    const k = s.api_keys[0];
    assert.equal(k.role, 'camera'); assert.deepEqual(JSON.parse(k.permissions), ['device.read']); assert.deepEqual(JSON.parse(k.scope), { devices: ['a'] });
    assert.deepEqual(JSON.parse(k.last_used), { at: '2026-10-01', ip: '192.0.2.1' }); assert.deepEqual(JSON.parse(k.revoked), { at: '2026-10-02', by: 'admin' });
    assert.equal(s.hub_links[0].role, 'technical');
    const doc = (n) => JSON.parse(s.settings.find((x) => x.name === n).value);
    assert.deepEqual(doc('channels'), { 0: { name: 'Kapi', view: 'hide' } });
    assert.deepEqual(doc('live-layout'), { column: 3, paths: ['k0'], savedBy: 'admin', time: 't' });
    assert.deepEqual(doc('update-status'), { status: 'current', running: 'abc', commitList: [{ header: 'x', date: 'y' }] });
    // idempotent: ikinci kosu bir sey yapmaz; veri elle geri 1. surume alinip tekrar kosulsa da sonuc ayni
    assert.deepEqual(await v.db.runMigrations(), []);
    await v.q('DELETE FROM migrations WHERE version = 2');
    assert.deepEqual(await v.db.runMigrations(), [2]);
    assert.deepEqual(await snapshot(v.q), s);
  } finally { await v.remove(); }
});

test('goc v2: hata olursa tek islemde geri alinir (veri ve surum satiri degismez), kilit birakilir', async () => {
  const v = await v1Database();
  const failing = { version: 99, name: 'fails', run: async (c) => { await c.query("UPDATE users SET role = 'x'"); throw new Error('bilerek'); } };
  const before = await snapshot(v.q);
  const original = MIGRATIONS.slice();
  try {
    MIGRATIONS.length = 0; MIGRATIONS.push(original[0], failing, original[1]);
    await assert.rejects(() => v.db.runMigrations(), /bilerek/);
    assert.deepEqual(await snapshot(v.q), before, 'hicbir satir degismemeli');
    assert.deepEqual((await v.q('SELECT version FROM migrations'))[0].map((r) => r.version), [1]);
    MIGRATIONS.length = 0; MIGRATIONS.push(...original);   // hata giderilince ayni veritabaninda goc basariyla biter (kilit birakilmisti)
    assert.deepEqual(await v.db.runMigrations(), [2]);
  } finally { MIGRATIONS.length = 0; MIGRATIONS.push(...original); await v.remove(); }
});

test('gunluk: eski (Turkce alan adli) kayitlar yeni kayitlarla ayni zincirde dogrulanir, olay suzgeci eski ve yeni adi bulur, gorunum yeni alan adlarini verir', async () => {
  const t = await openApp();
  try {
    await t.login('admin', 'adminparola1');
    const sign = t.services.auditLog.sign;
    await t.services.db.query('DELETE FROM audit_log');
    let previous = '';
    for (const [i, olay] of ['giris', 'cikis'].entries()) {
      const k = { z: `2026-10-0${i + 1}T08:00:00.000Z`, yerel: `2026-10-0${i + 1} 11:00:00 Europe/Istanbul`, olay, kullanici: 'admin', ip: '192.0.2.1', port: 1, ua: 'x', onceki: previous };
      k.imza = sign(previous + JSON.stringify(k)); previous = k.imza;
      await t.services.db.query('INSERT INTO audit_log (ts, local_time, event, username, ip, previous_signature, signature, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [k.z, k.yerel, k.olay, k.kullanici, k.ip, k.onceki, k.imza, JSON.stringify(k)]);
    }
    t.services.auditLog.lastSignature = previous;
    await t.services.auditLog.write('login', 'admin', null);        // yeni ad ve yeni alan adlariyla
    await t.services.auditLog.wait();
    const v = await t.req('/api/audit-log/verify');
    assert.deepEqual({ ok: v.json.ok, record: v.json.record }, { ok: true, record: 3 });
    for (const name of ['login', 'giris']) assert.equal((await t.req(`/api/audit-log?event=${name}`)).json.total, 2, name);
    const list = (await t.req('/api/audit-log?size=10')).json.records;
    assert.deepEqual(list.map((r) => r.event), ['login', 'logout', 'login']);
    assert.ok(list.every((r) => r.time && r.username === 'admin' && r.signature), 'eski kayit da yeni alan adlariyla gorunur');
    // bozulmus eski kayit zinciri keser
    await t.services.db.query("UPDATE audit_log SET record = REPLACE(record, 'cikis', 'cikiss') WHERE event = 'cikis'");
    assert.equal((await t.req('/api/audit-log/verify')).json.ok, false);
  } finally { await t.close(); }
});

test('aktarim: tamamen Turkce alan adli JSON donemi dosyalari ve eski gunluk zinciri aktarilir', async () => {
  const secret = randomBytes(32), k = newFolder(), g = await tempDb();
  try {
    writeFileSync(join(k, 'gizli.anahtar'), secret);
    const salt = randomBytes(16);
    write(k, 'kullanicilar.json', [{ ad: 'admin', rol: 'admin', tuz: salt.toString('hex'), karma: scryptSync('eskiparola1', salt, 32).toString('hex'), olusturma: '2026-10-01T08:00:00.000Z', oturumSurum: 0, kapsam: null, bitis: null, ipler: [], tercih: { hepsiSayi: 4 } },
      { ad: 'tekno', rol: 'teknik', tuz: salt.toString('hex'), karma: 'ab', olusturma: '2026-10-01T08:00:00.000Z', kapsam: { cihazlar: ['aaaa1111'] } }]);
    write(k, 'cihazlar.json', { surum: 1, ustSinir: 8, cihazlar: [{ id: 'aaaa1111', ad: 'Eski A', tur: 'sahte', ana: '127.0.0.31', kullanici: 'a', parola: (({ iv, tag, data }) => ({ iv, etiket: tag, veri: data }))(new DeviceStore(null, secret).encrypt('b')), etiket: 'A', kanalSayisi: 4, baslangic: 0, olusturma: '2026-10-01T08:00:00.000Z' }] });
    write(k, 'yetki.json', { surum: 1, roller: { izle: { ad: 'Izleyici', aciklama: '', izinler: ['canli.izle', 'kayit.*'], olusturan: 'admin', olusturma: '2026-10-02T08:00:00.000Z' } }, yerlesikIzinler: { kamera: ['canli.izle'] },
      anahtarlar: [{ id: 'k1', ad: 'K', onek: 'ab', karma: 'cd', rol: 'kamera', izinler: ['cihaz.oku'], kapsam: null, bitis: null, ipler: [], hizLimiti: 60, eszamanliAkis: 2, sahip: null, olusturan: 'admin', olusturma: '2026-10-02T08:00:00.000Z', sonKullanim: { z: 't', ip: '192.0.2.1' }, sayac: 1, iptal: null, notlar: '', surum: 1 }] });
    write(k, 'merkez-baglari.json', { '5a0d0000-0000-7000-8000-000000000001': { ad: 'admin', eposta: 'a@ornek.test', rol: 'teknik', girebilir: true, kontrol: null, sonGiris: null } });
    write(k, 'kanallar.json', { 0: { ad: 'Kapi', gorunum: 'goster' } });
    write(k, 'guncelleme.json', { durum: 'guncel' });
    write(k, 'live-duzen.json', { sutun: 3, yollar: ['k0'], kaydeden: 'admin', zaman: 't' });
    write(k, 'gunluk.jsonl', chain(secret));
    const t = await openApp({ data: k, database: g });
    assert.equal(await count(t, 'users'), 2); assert.equal(await count(t, 'devices'), 1); assert.equal(await count(t, 'audit_log'), 3);
    await t.login('admin', 'eskiparola1');
    assert.equal((await t.req('/api/audit-log/verify')).json.ok, true);
    const row = (await t.services.db.query("SELECT role, scope, preferences FROM users WHERE name = 'tekno'"))[0];
    assert.equal(row.role, 'technical'); assert.deepEqual(JSON.parse(row.scope), { devices: ['aaaa1111'] });
    assert.equal((await t.services.db.query("SELECT type FROM devices"))[0].type, 'mock');
    assert.equal((await t.services.db.query('SELECT role FROM api_keys'))[0].role, 'camera');
    assert.deepEqual(JSON.parse((await t.services.db.query("SELECT value FROM settings WHERE name = 'live-layout'"))[0].value), { column: 3, paths: ['k0'], savedBy: 'admin', time: 't' });
    await t.close();
  } finally { remove(k); await g.remove(); }
});
