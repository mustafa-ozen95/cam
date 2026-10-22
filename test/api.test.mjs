/**
 * API + guvenlik entegrasyon testleri: uygulama sahte cihazla, gecici veri klasorunde, rastgele portta kurulur.
 * Kapsam: CSRF, oturum, roller/izinler (403), kapsam disi kanal (403), API anahtari (olusturma/IP/sure/iptal/yenileme/hiz siniri/kaba kuvvet),
 * yol gecisi, govde siniri, guvenlik basliklari, gunluk zinciri.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/bootstrap.mjs';
import { config as base } from '../config/app.mjs';
import { tempDb } from './helpers.mjs';

let server, app, B, data, gv;
const cookies = new Map();
const req = async (path, { method = 'GET', body, who = 'admin', bearer, headers = {}, csrf = true, raw = false } = {}) => {
  const h = { ...headers };
  if (body !== undefined) { h['Content-Type'] = 'application/json'; }
  if (csrf && !bearer) h['X-Cam'] = '1';
  if (bearer) h.Authorization = `Bearer ${bearer}`; else if (who && cookies.get(who)) h.Cookie = cookies.get(who);
  const r = await fetch(B + path, { method: method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie && who) cookies.set(who, setCookie.split(';')[0]);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const login = async (name, password) => { const r = await req('/api/login', { method: 'POST', body: { name, password }, who: name }); assert.equal(r.status, 200, r.text); return r; };

before(async () => {
  data = mkdtempSync(join(tmpdir(), 'cam-api-'));
  gv = await tempDb();
  const y = { ...base, dataDir: data, database: gv.setting, server: { ...base.server, port: 0, address: '127.0.0.1' }, device: { ...base.device, test: true, seed: JSON.stringify([{ name: 'Sahte A', type: 'mock', host: '127.0.0.1', username: 'a', password: 'b', label: 'A' }, { name: 'Sahte B', type: 'mock', host: '127.0.0.2', username: 'a', password: 'b', label: 'B' }]) }, permissions: { ...base.permissions, initialAdminPassword: 'adminparola1' } };
  app = await createApp(y);
  server = app.listen();
  await new Promise((r) => server.once('listening', r));
  B = `http://127.0.0.1:${server.address().port}`;
  await login('admin', 'adminparola1');
  // Eski yerlesik roller artik ozel rol: sinamalarin kullandigi izin kumeleri burada kurulur.
  for (const [id, permissions] of [['user', ['live.view', 'recording.list', 'recording.play', 'recording.download']], ['viewer', ['live.view']], ['operator', ['live.view', 'recording.list', 'recording.play', 'recording.download', 'device.read', 'device.clock', 'channel.manage']]]) {
    const r = await req('/api/access/roles', { method: 'POST', body: { id, name: id, permissions } }); assert.equal(r.status, 200, r.text);
  }
});
after(async () => { server.close(); await app.close(); await gv.remove(); rmSync(data, { recursive: true, force: true }); });

test('güvenlik başlıkları her yanıtta', async () => {
  const r = await req('/api/v1/health', { who: null });
  assert.equal(r.status, 200);
  for (const b of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) assert.ok(r.headers.get(b), b);
});

test('CSRF: çerezli POST X-Cam başlığı olmadan reddedilir; Bearer ile gerekmez', async () => {
  const r = await req('/api/logout', { method: 'POST', csrf: false });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'CSRF');
  const r2 = await req('/api/login', { method: 'POST', body: { name: 'admin', password: 'adminparola1' }, csrf: false, who: null });
  assert.equal(r2.status, 403);
});

test('oturum: kimliksiz 401, yanlış parola 401, kilit', async () => {
  assert.equal((await req('/api/me', { who: null })).status, 401);
  assert.equal((await req('/api/me', { who: null })).json.code, 'LOGIN_REQUIRED');
  const r = await req('/api/login', { method: 'POST', body: { name: 'admin', password: 'yanlis' }, who: null });
  assert.equal(r.status, 401);
  assert.equal((await req('/api/me')).json.name, 'admin');
});

test('rol ve izin: kullanıcı yalnız izler; yönetim uçları 403 ve gerekenIzin döner', async () => {
  const u = await req('/api/members', { method: 'POST', body: { name: 'ali', password: 'aliparola1', role: 'user' } });
  assert.equal(u.status, 200, u.text);
  await login('ali', 'aliparola1');
  assert.equal((await req('/api/info', { who: 'ali' })).status, 200);
  assert.equal((await req('/api/recordings?channel=0&day=2026-10-05', { who: 'ali' })).status, 200);
  for (const [path, method, permission] of [['/api/members', 'GET', 'member.manage'], ['/api/audit-log', 'GET', 'audit.read'], ['/api/devices', 'GET', 'device.read'], ['/api/access/roles', 'POST', 'permission.manage'], ['/api/channels', 'PUT', 'channel.manage'], ['/api/dvr/clock', 'POST', 'device.clock']]) {
    const r = await req(path, { who: 'ali', method, body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 403, `${method} ${path}: ${r.text}`); assert.equal(r.json.code, 'PERMISSION_DENIED'); assert.equal(r.json.requiredPermission, permission);
  }
  // izleyici: kayıt izleyemez
  await req('/api/members', { method: 'POST', body: { name: 'veli', password: 'veliparola1', role: 'viewer' } });
  await login('veli', 'veliparola1');
  assert.equal((await req('/stream/playback?channel=0&from=2026-10-05 10:00:00&to=2026-10-05 10:05:00', { who: 'veli' })).status, 403);
  assert.equal((await req('/api/snapshot?channel=0', { who: 'veli' })).status, 200);
});

test('kapsam: üye yalnız kapsamındaki kameraları görür ve kullanır', async () => {
  const devices = (await req('/api/devices')).json.devices;
  const b = devices.find((c) => c.name === 'Sahte B');
  const r = await req('/api/members', { method: 'POST', body: { name: 'ayse', password: 'ayseparola1', role: 'user', scope: { devices: [b.id] } } });
  assert.equal(r.status, 200, r.text);
  await login('ayse', 'ayseparola1');
  const info = (await req('/api/info', { who: 'ayse' })).json;
  assert.deepEqual(info.channelEmpty.slice(0, 4), [true, true, true, true]);        // A cihazı gizli
  assert.deepEqual(info.channelEmpty.slice(4, 8), [false, false, false, false]);
  assert.equal(info.devices.length, 1);
  const outer = await req('/api/recordings?channel=0&day=2026-10-05', { who: 'ayse' });
  assert.equal(outer.status, 403); assert.equal(outer.json.code, 'OUT_OF_SCOPE');
  assert.equal((await req('/api/recordings?channel=5&day=2026-10-05', { who: 'ayse' })).status, 200);
  assert.equal((await req('/api/snapshot?channel=1', { who: 'ayse' })).status, 403);
  const v1 = (await req('/api/v1/cameras', { who: 'ayse' })).json.cameras;
  assert.ok(v1.every((k) => k.channel >= 4) && v1.length === 4);
});

test('yetki yükseltme: üye yöneten, kendi izninin üstünde rol veremez; kapsamlı yönetici kapsam dışına üye açamaz', async () => {
  await req('/api/access/roles', { method: 'POST', body: { id: 'uyeci', name: 'Üyeci', permissions: ['member.manage', 'live.view'] } });
  await req('/api/members', { method: 'POST', body: { name: 'uyeci1', password: 'uyeciparola1', role: 'uyeci' } });
  await login('uyeci1', 'uyeciparola1');
  const r = await req('/api/members', { who: 'uyeci1', method: 'POST', body: { name: 'yeni1', password: 'yeniparola1', role: 'admin' } });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await req('/api/members', { who: 'uyeci1', method: 'POST', body: { name: 'yeni1', password: 'yeniparola1', role: 'viewer' } })).status, 200);
  assert.equal((await req('/api/members/yeni1', { who: 'uyeci1', method: 'PATCH', body: { role: 'operator' } })).json.code, 'PRIVILEGE_ESCALATION');
  // kapsamlı yönetici
  const a = (await req('/api/devices')).json.devices.find((c) => c.name === 'Sahte A');
  await req('/api/members', { method: 'POST', body: { name: 'uyeci2', password: 'uyeciparola2', role: 'uyeci', scope: { devices: [a.id] } } });
  await login('uyeci2', 'uyeciparola2');
  assert.equal((await req('/api/members', { who: 'uyeci2', method: 'POST', body: { name: 'yeni2', password: 'yeniparola2', role: 'viewer' } })).json.code, 'PRIVILEGE_ESCALATION');       // kapsamsız üye
  assert.equal((await req('/api/members', { who: 'uyeci2', method: 'POST', body: { name: 'yeni2', password: 'yeniparola2', role: 'viewer', scope: { channels: [5] } } })).json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await req('/api/members', { who: 'uyeci2', method: 'POST', body: { name: 'yeni2', password: 'yeniparola2', role: 'viewer', scope: { channels: [1, 2] } } })).status, 200);
  // son admin korunur
  assert.equal((await req('/api/members/admin', { method: 'PATCH', body: { role: 'user' } })).status, 400);
  assert.equal((await req('/api/members/admin', { method: 'DELETE' })).status, 400);
});

let key, keyId;
test('API anahtarı: oluşturma bir kez gösterir, Bearer ile çalışır, dosyada düz metin yok', async () => {
  const r = await req('/api/access/keys', { method: 'POST', body: { name: 'entegrasyon', role: 'user', scope: { channels: [0, 1] }, rateLimit: 50, concurrentStreams: 1 } });
  assert.equal(r.status, 200, r.text);
  key = r.json.key; keyId = r.json.record.id;
  assert.match(key, /^kp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(await app.services.db.query('SELECT * FROM api_keys')).includes(key.slice('kp_12345678_'.length)));
  const me = await req('/api/v1/me', { bearer: key });
  assert.equal(me.status, 200); assert.equal(me.json.type, 'key'); assert.ok(me.json.permissions.includes('recording.download'));
  assert.equal((await req('/api/v1/cameras/0/recordings?day=2026-10-05', { bearer: key })).status, 200);
  assert.equal((await req('/api/v1/cameras/3/recordings?day=2026-10-05', { bearer: key })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await req('/api/v1/members', { bearer: key })).status, 403);
  // listede gizli yok, son kullanım var
  const l = (await req('/api/access/keys')).json.find((a) => a.id === keyId);
  assert.equal(l.hash, undefined); assert.ok(l.lastUsed); assert.ok(l.counter >= 1);
  // yanlış anahtar 401; biçimsiz 401
  assert.equal((await req('/api/v1/me', { bearer: key.slice(0, -2) + 'zz' })).status, 401);
  assert.equal((await req('/api/v1/me', { bearer: 'abc' })).status, 401);
});

test('API anahtarı: api.key izni yalnız kendi anahtarlarını görür/yönetir; yükseltme engeli', async () => {
  await req('/api/access/roles', { method: 'POST', body: { id: 'entegrator', name: 'Entegratör', permissions: ['live.view', 'api.key'] } });
  await req('/api/members', { method: 'POST', body: { name: 'ent', password: 'entparola1', role: 'entegrator' } });
  await login('ent', 'entparola1');
  assert.equal((await req('/api/access/keys', { who: 'ent' })).json.length, 0);                  // admin'in anahtarı görünmez
  assert.equal((await req(`/api/access/keys/${keyId}`, { who: 'ent' })).status, 403);
  const payload = await req('/api/access/keys', { who: 'ent', method: 'POST', body: { name: 'x', role: 'user' } });
  assert.equal(payload.json.code, 'PRIVILEGE_ESCALATION');
  const ok = await req('/api/access/keys', { who: 'ent', method: 'POST', body: { name: 'kendi', permissions: ['live.view'] } });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.record.owner, 'ent');
  assert.equal((await req('/api/access/keys', { who: 'ent' })).json.length, 1);
  assert.equal((await req('/api/access/keys', { who: 'ent', method: 'POST', body: { name: 'baskasi', permissions: ['live.view'], owner: 'admin' } })).json.record.owner, 'ent');
});

test('API anahtarı: IP listesi, bitiş, iptal, yenileme, hız sınırı, eşzamanlı akış', async () => {
  // IP listesi: test istemcisi 127.0.0.1
  const r = await req('/api/access/keys', { method: 'POST', body: { name: 'ipli', role: 'viewer', ips: ['10.9.9.0/24'] } });
  assert.equal((await req('/api/v1/me', { bearer: r.json.key })).json.code, 'IP_BLOCKED');
  await req(`/api/access/keys/${r.json.record.id}`, { method: 'PATCH', body: { ips: ['127.0.0.1'] } });
  assert.equal((await req('/api/v1/me', { bearer: r.json.key })).status, 200);
  // bitiş geçmişte reddedilir
  assert.equal((await req('/api/access/keys', { method: 'POST', body: { name: 'b', role: 'viewer', expiresAt: '2001-01-01' } })).status, 400);
  // yenileme: eski geçersiz
  const y = await req(`/api/access/keys/${r.json.record.id}/rotate`, { method: 'POST' });
  assert.equal((await req('/api/v1/me', { bearer: r.json.key })).status, 401);
  assert.equal((await req('/api/v1/me', { bearer: y.json.key })).status, 200);
  // iptal
  await req(`/api/access/keys/${r.json.record.id}/revoke`, { method: 'POST' });
  assert.equal((await req('/api/v1/me', { bearer: y.json.key })).json.code, 'KEY_REVOKED');
  // hız sınırı: 3 istek/dk
  const h = await req('/api/access/keys', { method: 'POST', body: { name: 'hiz', role: 'viewer', rateLimit: 3, concurrentStreams: 1 } });
  for (let i = 0; i < 3; i++) assert.equal((await req('/api/v1/me', { bearer: h.json.key })).status, 200);
  const limit = await req('/api/v1/me', { bearer: h.json.key });
  assert.equal(limit.status, 429); assert.equal(limit.json.code, 'RATE_LIMIT'); assert.ok(limit.headers.get('retry-after'));
  // eşzamanlı akış: 1 → ikinci akış 429 (ayrı anahtar, sınır 1)
  const e = await req('/api/access/keys', { method: 'POST', body: { name: 'akis', role: 'viewer', concurrentStreams: 1, rateLimit: 100 } });
  const open = new AbortController();
  const primary = fetch(`${B}/api/v1/cameras/0/live?raw=1`, { headers: { Authorization: `Bearer ${e.json.key}` }, signal: open.signal });
  await new Promise((r2) => setTimeout(r2, 300));
  const second = await req('/api/v1/cameras/1/live?raw=1', { bearer: e.json.key });
  assert.equal(second.status, 429); assert.equal(second.json.code, 'STREAM_LIMIT');
  open.abort(); await primary.catch(() => {});
});

test('kaba kuvvet: 10 geçersiz anahtardan sonra IP kilitlenir (doğru anahtar bile 429)', async () => {
  for (let i = 0; i < 10; i++) await req('/api/v1/me', { bearer: 'kp_00000000_' + 'A'.repeat(43) });
  const r = await req('/api/v1/me', { bearer: key });
  assert.equal(r.status, 429); assert.equal(r.json.code, 'TOO_MANY_ATTEMPTS');
  app.services.permissions.error.success('127.0.0.1');        // testin devamı için kilidi aç
  assert.equal((await req('/api/v1/me', { bearer: key })).status, 200);
});

test('jeton kaldırıldı: kj1 Bearer ve ?token= kimlik sayılmaz, uç yok', async () => {
  assert.equal((await req('/api/v1/me', { bearer: 'kj1.e30.abc', who: null })).status, 401);
  assert.equal((await req('/api/v1/me?token=kj1.e30.abc', { who: null })).status, 401);
  assert.equal((await req('/api/v1/jetonlar', { bearer: key, method: 'POST', body: {} })).status, 404);
  assert.equal((await req('/api/access/token', { method: 'POST', body: {} })).status, 404);
});

test('girdi güvenliği: yol geçişi, bozuk JSON, büyük gövde, bilinmeyen rota, yöntem', async () => {
  assert.equal((await req('/css/../../package.json', { who: null })).status, 404);
  assert.equal((await req('/css/..%2F..%2Fpackage.json', { who: null })).status, 404);
  assert.equal((await req('/docs/..%2Fpackage.json', { who: null })).status, 401);       // dokuman oturum ister
  assert.equal((await req('/docs/..%2Fpackage.json')).status, 404);                       // oturumlu da yol gecisi yok
  assert.equal((await req('/api/download?channel=0&file=/../etc/passwd.h264&from=2026-10-05 10:00:00&to=2026-10-05 10:01:00')).status, 400);
  const broken = await req('/api/members', { method: 'POST', body: '{bozuk' });
  assert.equal(broken.status, 400); assert.equal(broken.json.code, 'INVALID_JSON');
  const large = await req('/api/members', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(1_100_000) }) });
  assert.ok([413, 400].includes(large.status));
  assert.equal((await req('/api/missing', { who: null })).status, 404);
  assert.equal((await req('/api/me', { method: 'DELETE' })).status, 405);
  // kanal sınırı
  assert.equal((await req('/api/recordings?channel=999&day=2026-10-05')).status, 400);
});

test('cihaz yönetimi ve günlük: parola sızmaz, zincir doğrulanır, olaylar yazılır', async () => {
  const c = await req('/api/devices', { method: 'POST', body: { name: 'Sahte C', type: 'mock', host: '127.0.0.3', username: 'u', password: 'gizliparola', label: 'C' } });
  assert.equal(c.status, 200, c.text);
  assert.ok(!JSON.stringify((await req('/api/devices')).json).includes('gizliparola'));
  await app.services.auditLog.wait();
  const db = app.services.db;
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM devices')).includes('gizliparola'));
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM audit_log')).includes('gizliparola'));
  // anahtarla yapılan işlem günlüğe anahtar:<id> adıyla yazılır
  const ak = await req('/api/access/keys', { method: 'POST', body: { name: 'otomasyon', permissions: ['api.key'] } });
  const sub = await req('/api/v1/keys', { bearer: ak.json.key, method: 'POST', body: { name: 'alt', permissions: ['api.key'] } });
  assert.equal(sub.status, 200, sub.text);
  const g = (await req('/api/audit-log?size=200')).json;
  const events = new Set(g.records.map((k) => k.event));
  for (const o of ['login', 'login-failed', 'member-add', 'role-add', 'key-create', 'key-revoke', 'device-add']) assert.ok(events.has(o), o);
  assert.ok(g.records.some((k) => k.username === `key:${ak.json.record.id}` && k.event === 'key-create'));
  assert.equal((await req('/api/audit-log/verify')).json.ok, true);
  assert.equal((await req('/api/v1/devices/info')).json.devices.length, 3);
  assert.equal((await req(`/api/devices/${c.json.id}`, { method: 'DELETE' })).status, 200);
});

test('rota listesi: HER rota kimlik ister; kimliksiz yalnız giriş sayfasının ihtiyacı ve açık istisnalar', async () => {
  // /api/identity/refresh: merkezden gelen bildirim; kimligi HMAC imzasi (bkz. merkez.test.mjs), cerez/anahtar degil.
  // /api/v1/saglik: yalniz dongu adresinden yanit verir (HEALTHCHECK). Digerleri giris sayfasi: ana sayfa (oturum yoksa giris formu), css/js/font/simge, merkez ile giris akisi.
  const isOpen = new Set(['/api/login', '/api/logout', '/api/identity/refresh', '/api/identity/logout', '/api/v1/health', '/', '/index.html', '/icon.svg', '/css/:a', '/css/:a/:b', '/css/:a/:b/:c', '/fonts/:a', '/js/:a', '/js/:a/:b', '/js/:a/:b/:c', '/login/hub', '/login/hub/callback',
    // /live: UYELIKSIZ izleme. Yalniz okuma: sayfa, kendi betik/stili, kamera adlari (adres yok), ortak duzen,
    // "admin miyim" sorusu. Duzeni yazmak (/live/duzen, PUT) kimlik ister ve bu listede DEGIL.
    // /live/rtc/:yol/whep: izleme baglantisi (SDP alisverisi); yalniz panelin listeledigi yollar, mediamtx'te okuma izni.
    '/live', '/live/cameras.json', '/live/layout.json', '/live/access', '/live/:file', '/live/rtc/:path/whep']);
  const routes = app.router.list();
  for (const r of routes) {
    if (isOpen.has(r.pattern)) continue;
    assert.ok(r.middlewares.includes('identity'), `${r.pattern} identity ara katmanı yok`);
    if (r.pattern.startsWith('/api') || r.pattern.startsWith('/stream')) assert.ok(r.middlewares.some((a) => a.startsWith('permission:')) || ['/api/me', '/api/v1/me', '/api/v1'].includes(r.pattern), `${r.pattern} izin ara katmanı yok`);
  }
  for (const k of ['/docs', '/docs/:file', '/api/v1']) assert.ok(routes.some((r) => r.pattern === k), k);
});

/**
 * Oynatma yuvalari: (1) ayni kisi ayni kanalda art arda atlarsa eski akis yenisinden once kapanir, 503 olmaz;
 * (2) bir cihaz doluyken obur cihazdan oynatma acilir (kontrol hedef cihaza yapilir).
 */
test('oynatma: hızlı atlama 503 vermez, dolu cihaz öbürünü engellemez', async () => {
  const channels = (await req('/api/v1/cameras')).json.cameras;
  const firstDevice = channels[0].device;
  const a = channels.filter((k) => k.device === firstDevice).map((k) => k.channel).slice(0, 4);
  const b = channels.find((k) => k.device !== firstDevice).channel;
  assert.equal(a.length, 4);
  const cookie = cookies.get('admin');
  const open = (channel, clock) => { const ctrl = new AbortController(); const p = fetch(`${B}/stream/playback?channel=${channel}&from=2026-10-12%2010:${clock}:00&to=2026-10-12%2010:59:59`, { headers: { Cookie: cookie }, signal: ctrl.signal }); return { ctrl, p }; };
  const first = a.map((k) => open(k, '00'));
  const firstResponse = await Promise.all(first.map((x) => x.p));
  assert.deepEqual(firstResponse.map((r) => r.status), [200, 200, 200, 200]);
  // ayni kanallarda hemen yeni istek: eskileri istemci kapatmadan once gelir
  const second = a.map((k) => open(k, '05'));
  const secondResponse = await Promise.all(second.map((x) => x.p));
  assert.deepEqual(secondResponse.map((r) => r.status), [200, 200, 200, 200], 'ayni kanalda atlama 503 vermemeli');
  // A dolu (4/4); B'den oynatma acilabilmeli
  const bResponse = await open(b, '00').p;
  assert.equal(bResponse.status, 200, 'dolu cihaz obur cihazi engellememeli');
  for (const x of [...first, ...second]) x.ctrl.abort();
  try { await bResponse.body?.cancel(); } catch {}
  await new Promise((r) => setTimeout(r, 100));
});
