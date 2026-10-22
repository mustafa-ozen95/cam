/**
 * Veritabani katmani: goclerin tekrar kosmasi, gizli anahtar kurallari, kripto etiketi gocu (surum 3), yazma hatasinda bellegin degismemesi, saglik yoklamasi, yeniden aciliste kalicilik, gunluk sirasi.
 * Gercek MariaDB gerekir (test/helpers.mjs: DB_HOST, DB_USERNAME, DB_PASSWORD).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/database.mjs';
import { resolveSecretKey } from '../src/core/secret-key.mjs';
import { MIGRATIONS } from '../src/database/migrations.mjs';
import * as legacyNames from '../src/database/legacy-names.mjs';
import { LABELS, auditSignature, devicePasswordKey, keyFingerprint, unseal } from '../src/core/crypto-labels.mjs';
import { tempDb, openApp, openDb } from './helpers.mjs';

const newFolder = () => mkdtempSync(join(tmpdir(), 'cam-db-'));
const remove = (k) => rmSync(k, { recursive: true, force: true });

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
  const original = MIGRATIONS.slice();
  try {
    MIGRATIONS.length = 2;   // yalniz surum 1-2 (surum 3 gizli anahtar ister, ayri sinanir)
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
  } finally { MIGRATIONS.length = 0; MIGRATIONS.push(...original); await v.remove(); }
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
    MIGRATIONS.length = 0; MIGRATIONS.push(original[0], original[1]);   // hata giderilince ayni veritabaninda goc basariyla biter (kilit birakilmisti)
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

// ---------------------------------------------------------------- goc v3 (kripto etiketleri -> Ingilizce)
/** Surum 2'deki bir veritabani kurar ve ESKI etiketlerle imzali/sifreli sentetik veri koyar (gizli anahtar rastgele; gercek anahtar yok). */
async function v2Database(secret, { chainRecords = 4, fingerprint = true } = {}) {
  const v = await v1Database();
  const original = MIGRATIONS.slice();
  MIGRATIONS.length = 2;
  try { await v.db.runMigrations(); } finally { MIGRATIONS.length = 0; MIGRATIONS.push(...original); }
  await v.q('DELETE FROM api_keys'); await v.q('DELETE FROM devices');
  const oldKey = createHash('sha256').update(`kamera2-cihaz-parola|${secret.toString('hex')}`).digest();
  const oldEnvelope = (text) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', oldKey, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }); };
  await v.q('INSERT INTO devices (id, name, type, host, password) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
    ['d1', 'A', 'mock', '192.0.2.1', oldEnvelope('parola-bir'), 'd2', 'B', 'mock', '192.0.2.2', oldEnvelope('parola-iki'), 'd3', 'C', 'mock', '192.0.2.3', null]);
  const oldSign = (text) => createHmac('sha256', secret).update(text).digest('hex');
  let previous = '';
  for (let i = 0; i < chainRecords; i++) {
    const turkish = i < 2;   // ilk iki kayit Turkce alan adli
    const n = turkish ? { time: 'z', local: 'yerel', event: 'olay', user: 'kullanici', previous: 'onceki', signature: 'imza' } : { time: 'time', local: 'localTime', event: 'event', user: 'username', previous: 'previous', signature: 'signature' };
    const k = { [n.time]: `2026-10-0${i + 1}T08:00:00.000Z`, [n.local]: `2026-10-0${i + 1} 11:00:00 Europe/Istanbul`, [n.event]: turkish ? 'giris' : 'login', [n.user]: 'admin', ip: '192.0.2.1', port: 1, [n.previous]: previous };
    k[n.signature] = oldSign(previous + JSON.stringify(k));
    await v.q('INSERT INTO audit_log (ts, local_time, event, username, ip, previous_signature, signature, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [k[n.time], k[n.local], k[n.event], 'admin', '192.0.2.1', previous, k[n.signature], JSON.stringify(k)]);
    previous = k[n.signature];
  }
  await v.q('INSERT INTO api_keys (id, name, hash, revoked) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)', ['k1', 'bir', 'a'.repeat(64), null, 'k2', 'iki', 'b'.repeat(64), null, 'k3', 'uc', 'c'.repeat(64), JSON.stringify({ at: '2026-10-01', by: 'admin' })]);
  if (fingerprint) await v.q('INSERT INTO settings (name, value) VALUES (?, ?)', ['key-fingerprint', JSON.stringify(createHmac('sha256', secret).update('cam/anahtar-izi').digest('hex'))]);
  return v;
}
const rowsOf = async (q) => (await snapshot(q));
const auditRows = async (q) => (await q('SELECT * FROM audit_log ORDER BY id'))[0];

test('etiketler: hepsi Ingilizce ve cam/ oneklidir, birbirinden farklidir', () => {
  const values = Object.values(LABELS);
  assert.ok(values.every((x) => /^cam\/[a-z-]+$/.test(x)), values.join());
  assert.equal(new Set(values).size, values.length);
});

test('goc v3: eski etiketli cihaz parolasi, gunluk zinciri ve parmak izi yeni etikete gecer; API anahtarlari iptal olur; tekrar kosunca degismez', async () => {
  const secret = randomBytes(32), v = await v2Database(secret), logs = [];
  try {
    const oldAudit = await auditRows(v.q);
    assert.deepEqual(await v.db.runMigrations({ secret, log: (m) => logs.push(m) }), [3]);
    // cihaz parolalari: yeni anahtarla cozulur, bos olan bos kalir
    const key = devicePasswordKey(secret), dev = Object.fromEntries((await v.q('SELECT id, password FROM devices'))[0].map((d) => [d.id, d.password]));
    assert.equal(unseal(key, JSON.parse(dev.d1)), 'parola-bir'); assert.equal(unseal(key, JSON.parse(dev.d2)), 'parola-iki'); assert.equal(dev.d3, null);
    // gunluk zinciri: yeni etiketle dogrulanir, icerik ayni (yalniz onceki/imza degeri), sira ayni, Turkce alan adlari yerinde
    const fresh = await auditRows(v.q);
    assert.equal(fresh.length, oldAudit.length);
    let previous = '';
    for (const [i, r] of fresh.entries()) {
      previous = legacyNames.auditChainStep(JSON.parse(r.record), previous, (t) => auditSignature(secret, t));
      assert.equal(previous, r.signature, `${i + 1}. kayit yeni etiketle dogrulanmali`);
      const was = JSON.parse(oldAudit[i].record), now = JSON.parse(r.record);
      assert.deepEqual(Object.keys(now), Object.keys(was), 'alan sirasi ayni');
      for (const f of Object.keys(was)) if (!['imza', 'signature', 'onceki', 'previous'].includes(f)) assert.deepEqual(now[f], was[f]);
      assert.equal(r.event, oldAudit[i].event); assert.equal(r.ts, oldAudit[i].ts);
    }
    assert.ok('imza' in JSON.parse(fresh[0].record) && 'signature' in JSON.parse(fresh[3].record));
    assert.notEqual(fresh[0].signature, oldAudit[0].signature);
    assert.equal(fresh[1].previous_signature, fresh[0].signature, 'zincir bagli');
    // parmak izi
    assert.equal(JSON.parse((await v.q("SELECT value FROM settings WHERE name = 'key-fingerprint'"))[0][0].value), keyFingerprint(secret));
    // API anahtarlari: etkin olanlar iptal, zaten iptal olan aynen
    const keys = (await v.q('SELECT id, revoked FROM api_keys ORDER BY id'))[0];
    assert.equal(JSON.parse(keys[0].revoked).by, 'migration 3'); assert.equal(JSON.parse(keys[1].revoked).by, 'migration 3');
    assert.deepEqual(JSON.parse(keys[2].revoked), { at: '2026-10-01', by: 'admin' });
    assert.match(logs.join('\n'), /4 günlük kaydı.*2 cihaz parolası.*2 API anahtarı iptal/);
    // idempotent: surum satiri silinip tekrar kosulunca hicbir sey degismez
    const before = await rowsOf(v.q), beforeAudit = await auditRows(v.q);
    await v.q('DELETE FROM migrations WHERE version = 3');
    assert.deepEqual(await v.db.runMigrations({ secret, log: () => {} }), [3]);
    assert.deepEqual(await rowsOf(v.q), before); assert.deepEqual(await auditRows(v.q), beforeAudit);
  } finally { await v.remove(); }
});

test('goc v3: yanlis gizli anahtar, bozuk zincir ya da cozulemeyen parola gocu durdurur; hicbir sey degismez, surum satiri yazilmaz', async () => {
  const secret = randomBytes(32);
  const cases = [
    ['yanlis anahtar (parmak iziyle)', () => v2Database(secret), randomBytes(32), /Gizli anahtar bu veritabanını/],
    ['yanlis anahtar (parmak izi yok)', () => v2Database(secret, { fingerprint: false }), randomBytes(32), /günlük zinciri doğrulanamadı/],
    ['anahtar yok', () => v2Database(secret), undefined, /gizli anahtarı ister/],
    ['bozuk zincir', async () => { const v = await v2Database(secret); await v.q("UPDATE audit_log SET record = REPLACE(record, 'admin', 'admiN') WHERE id = 3"); return v; }, secret, /günlük zinciri doğrulanamadı/],
    ['cozulemeyen cihaz parolasi', async () => { const v = await v2Database(secret, { chainRecords: 0 }); await v.q("UPDATE devices SET password = ? WHERE id = 'd2'", [JSON.stringify({ iv: 'aa', tag: 'bb', data: 'cc' })]); return v; }, secret, /d2 cihazının parolası çözülemedi/],
  ];
  for (const [name, make, key, expected] of cases) {
    const v = await make();
    try {
      const before = await rowsOf(v.q), beforeAudit = await auditRows(v.q);
      await assert.rejects(() => v.db.runMigrations({ secret: key, log: () => {} }), expected, name);
      assert.deepEqual(await rowsOf(v.q), before, name); assert.deepEqual(await auditRows(v.q), beforeAudit, name);
      assert.deepEqual((await v.q('SELECT version FROM migrations'))[0].map((r) => r.version), [1, 2], name);
    } finally { await v.remove(); }
  }
});

test('goc v3: uygulamanin yeni etiketleri goc edilmis veriyle uyumlu (cihaz parolasi cozulur, gunluk dogrulanir, yeni anahtar calisir)', async () => {
  const secret = randomBytes(32), v = await v2Database(secret), k = newFolder();
  try {
    await v.q('DELETE FROM users'); await v.q('DELETE FROM roles'); await v.q('DELETE FROM builtin_role_permissions'); await v.q('DELETE FROM hub_links'); await v.q('DELETE FROM settings WHERE name <> ?', ['key-fingerprint']);
    await v.q("DELETE FROM devices WHERE password IS NULL");
    const t = await openApp({ data: k, database: v.g, secretKey: secret.toString('base64'), devices: [] });
    try {
      await t.login('admin', 'adminparola1');
      assert.equal(t.services.devices.repo.setting('d1').password, 'parola-bir');
      const z = await t.req('/api/audit-log/verify');
      assert.equal(z.json.ok, true); assert.ok(z.json.record >= 4);
      const made = await t.req('/api/access/keys', { method: 'POST', body: { name: 'yeni', role: 'admin' } });
      assert.equal(made.status, 200, made.text);
      assert.equal((await t.req('/api/v1/me', { bearer: made.json.key, who: null })).status, 200, 'yeni anahtar yeni etiketle dogrulanir');
      assert.equal((await t.services.db.query("SELECT COUNT(*) AS n FROM api_keys WHERE revoked IS NULL"))[0].n, 1, 'eski anahtarlar iptal, yalniz yenisi etkin');
    } finally { await t.close(); }
  } finally { remove(k); await v.remove(); }
});
