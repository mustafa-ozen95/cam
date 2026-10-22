/**
 * Goc testi: JSON donemindeki veri/*.json dosyalarinin ESKI bicimleri (guvenlik duzeltmelerinden onceki) acilista veritabanina aktarilir ve calismaya devam eder.
 * Eski bicimde YOK olan alanlar: uye.sessionVersion, merkez-baglari userStamp, cihazlar.blockLimit, anahtar sahibi dogrulamasi.
 * Tek kasitli kesinti: eski oturum cerezleri (etiketsiz imza) bir kez gecersiz olur; kullanici yeniden giris yapar.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../src/models/device.mjs';
import { openApp } from './helpers.mjs';

const SUB_ADMIN = '5a0d0000-0000-7000-8000-000000000001', SUB_CLOSED = '5a0d0000-0000-7000-8000-000000000002', SUB_DEAD = '5a0d0000-0000-7000-8000-000000000003';
let directory, t, secret, LEGACY;
const write = (name, o) => writeFileSync(join(directory, name), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const query = (sql, p) => t.services.db.query(sql, p);
const member = (name, role, extra = {}) => { const salt = randomBytes(16); return { name, role, salt: salt.toString('hex'), hash: scryptSync('eskiparola1', salt, 32).toString('hex'), scope: null, expiresAt: null, ips: [], ...extra }; };

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cam-legacy-'));
  secret = randomBytes(32); writeFileSync(join(directory, 'gizli.anahtar'), secret);
  // kullanicilar.json: ESKI bicim (sessionVersion yok); 'eskiuye' olusturma damgasi da yok (cok eski kayit)
  write('kullanicilar.json', [member('admin', 'admin', { createdAt: '2026-10-01T08:00:00.000Z' }), member('kapali', 'admin', { createdAt: '2026-10-02T08:00:00.000Z' }), member('eskiuye', 'admin')]);
  // merkez-baglari.json: ESKI bicim (userStamp yok); biri kapali, biri silinmis uyeye ait
  const link = (name, canLogin) => ({ name, email: `${name}@ornek.test`, role: 'admin', canLogin, check: '2026-10-12T10:00:00.000Z', lastLogin: '2026-10-12T10:00:00.000Z' });
  write('merkez-baglari.json', { [SUB_ADMIN]: link('admin', true), [SUB_CLOSED]: link('kapali', false), [SUB_DEAD]: link('silinmis', true) });
  // cihazlar.json: ESKI bicim (blockLimit yok); parolalar bu kurulumun gizli anahtariyla sifreli
  const repo = new DeviceStore(null, secret);
  const device = (id, name, host, startIndex) => ({ id, name, type: 'mock', host, username: 'a', password: repo.encrypt('b'), label: id.slice(0, 1).toUpperCase(), channelCount: 4, startIndex, createdAt: '2026-10-01T08:00:00.000Z' });
  write('cihazlar.json', { version: 1, devices: [device('aaaa1111', 'Eski A', '127.0.0.31', 0), device('bbbb2222', 'Eski B', '127.0.0.32', 4)] });
  // yetki.json: ESKI bicim; sahibi uye olan anahtar ve sahibi uye olmayan entegrasyon anahtari
  const keyRecord = (id, name, secretText, owner) => ({ id, name, prefix: `kp_${id}_xxxx…`, hash: createHmac('sha256', createHmac('sha256', secret).update('kamera2/api-anahtar').digest()).update(secretText).digest('hex'),
    role: null, permissions: ['live.view'], scope: null, expiresAt: null, ips: [], rateLimit: 120, concurrentStreams: 4, owner, createdBy: 'admin', createdAt: '2026-10-05T08:00:00.000Z', lastUsed: null, counter: 0, revoked: null, notes: '' });
  LEGACY = { memberKey: `kp_aaaaaaaa_${'A'.repeat(43)}`, labelKey: `kp_bbbbbbbb_${'B'.repeat(43)}` };
  write('yetki.json', { version: 1, roles: {}, builtinPermissions: {}, keys: [keyRecord('aaaaaaaa', 'uye-anahtari', 'A'.repeat(43), 'admin'), keyRecord('bbbbbbbb', 'entegrasyon', 'B'.repeat(43), 'muhasebe-entegrasyonu')] });
  t = await openApp({ data: directory });
});
after(async () => { await t.close(); rmSync(directory, { recursive: true, force: true }); });

test('eski kullanicilar.json: parola girisi calisir, oturum surumu tembel eklenir, damgasiz kayit damga alir', async () => {
  const r = await t.login('admin', 'eskiparola1');
  assert.equal(r.json.role, 'admin');
  assert.equal((await t.req('/api/me')).json.name, 'admin');
  const k = await query('SELECT name, created_at FROM users');
  assert.equal(k.length, 3);
  assert.ok(k.every((u) => u.created_at), 'damgasiz kayda damga verilip yazilmis olmali');
  assert.equal(k.find((u) => u.name === 'admin').created_at, '2026-10-01T08:00:00.000Z', 'var olan damga degismez');
  await t.login('eskiuye', 'eskiparola1');
  // cikis: surum undefined -> 1 olur, eski cerez gecersiz
  const c = t.cookies.get('eskiuye');
  assert.equal((await t.req('/api/logout', { method: 'POST', cookie: c })).status, 200);
  assert.equal((await t.req('/api/me', { cookie: c })).status, 401);
});

test('eski oturum cerezi (etiketsiz imza) bir kez gecersiz olur; yeniden giris calisir', async () => {
  const payload = Buffer.from(JSON.stringify({ a: 'admin', e: Date.now() + 1e9 })).toString('base64url');
  const legacyCookie = `cam_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  assert.equal((await t.req('/api/me', { cookie: legacyCookie })).status, 401);
  assert.equal((await t.login('admin', 'eskiparola1')).status, 200);
});

test('eski merkez-baglari.json: bag mevcut uyenin damgasini alir, calismaya devam eder; uyesiz bag atilir', async () => {
  const members = t.services.members, links = t.services.links;
  const file = Object.fromEntries((await query('SELECT * FROM hub_links')).map((r) => [r.sub, r]));
  assert.equal(file[SUB_ADMIN].user_stamp, members.find('admin').createdAt);
  assert.equal(file[SUB_CLOSED].user_stamp, members.find('kapali').createdAt);
  assert.equal(file[SUB_DEAD], undefined, 'uyesi olmayan eski bag atilmali');
  assert.equal(links.byName('admin')?.sub, SUB_ADMIN);
  assert.equal(file[SUB_ADMIN].email, 'admin@ornek.test', 'bagin diger alanlari korunur');
  // bag hala islevsel: merkezde erisimi kapali uye cerezle giremez, acik olan girer
  assert.equal((await t.login('admin', 'eskiparola1')).status, 200);
  assert.equal((await t.req('/api/me')).status, 200);
  await t.login('kapali', 'eskiparola1');
  const closed = await t.req('/api/me', { who: 'kapali' });
  assert.equal(closed.status, 401); assert.equal(closed.json.code, 'HUB_ACCESS');
  // ayni adla yeniden olusturulan uye bagi devralamaz
  await t.req('/api/members/kapali', { method: 'DELETE' });
  assert.equal(links.byName('kapali'), null);
  assert.equal((await query('SELECT sub FROM hub_links WHERE sub = ?', [SUB_CLOSED])).length, 0);
});

test('eski cihazlar.json: cihazlar yuklenir; ust sinir eski bloklardan baslar, silme sonrasi blok yeniden verilmez', async () => {
  const list = (await t.req('/api/devices')).json.devices;
  assert.deepEqual(list.map((c) => [c.name, c.startIndex]), [['Eski A', 0], ['Eski B', 4]]);
  assert.equal((await t.req('/api/v1/cameras')).json.cameras.length, 8);
  const add = async (name, host) => (await t.req('/api/devices', { method: 'POST', body: { name, type: 'mock', host, username: 'u', password: 'p1234567', label: 'N' } })).json.id;
  const n1 = await add('Yeni 1', '127.0.0.41');
  assert.equal((await t.req('/api/devices')).json.devices.find((c) => c.id === n1).startIndex, 8, 'bugunku davranis: ilk bos blok');
  assert.equal(JSON.parse((await query("SELECT value FROM settings WHERE name = 'device-block-limit'"))[0].value), 12);
  await t.req(`/api/devices/${n1}`, { method: 'DELETE' });
  const n2 = await add('Yeni 2', '127.0.0.42');
  assert.equal((await t.req('/api/devices')).json.devices.find((c) => c.id === n2).startIndex, 12);
});

test('eski yetki.json: sahibi uye olan anahtar ve entegrasyon etiketli anahtar Bearer ile calismaya devam eder', async () => {
  const a = await t.req('/api/v1/me', { bearer: LEGACY.memberKey });
  assert.equal(a.status, 200, a.text); assert.equal(a.json.type, 'key'); assert.deepEqual(a.json.permissions, ['live.view']);
  assert.equal((await t.req('/api/v1/me', { bearer: LEGACY.labelKey })).status, 200, 'sahibi uye olmayan entegrasyon anahtari kendi haklariyla calisir');
  assert.equal((await t.req('/api/v1/me', { bearer: LEGACY.memberKey })).status, 200);
});
