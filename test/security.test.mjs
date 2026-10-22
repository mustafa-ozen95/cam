/**
 * Yetki, oturum ve girdi sinirlari icin guvenlik gerileme testleri.
 * Kendi uygulamasini kurar (api.test.mjs'in paylastigi durumdan bagimsiz). Giris kisiti testi IP'yi kilitler; bu yuzden EN SONDA.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { RtspFeed } from '../src/drivers/rtsp.mjs';
import { openApp } from './helpers.mjs';

let t, req, login, cookies, h;
const P = (name) => `${name}parola1`;
const setupRole = async (id, permissions) => assert.equal((await req('/api/access/roles', { method: 'POST', body: { id, name: id, permissions } })).status, 200);
const setupMember = async (name, role, extra = {}) => { const r = await req('/api/members', { method: 'POST', body: { name, password: P(name), role, ...extra } }); assert.equal(r.status, 200, r.text); await login(name, P(name)); };
const setupKey = async (body, who = 'admin') => { const r = await req('/api/access/keys', { method: 'POST', body, who }); assert.equal(r.status, 200, r.text); return r.json; };
const devices = async () => Object.fromEntries((await req('/api/devices')).json.devices.map((c) => [c.name.slice(-1), c]));

before(async () => {
  t = await openApp({ server: { trustedIpHeader: 'x-real-ip' } });
  ({ req, login, cookies, services: h } = t);
  await login('admin', 'adminparola1');
  await setupRole('uyeci', ['member.manage', 'live.view']);
  await setupRole('entegrator', ['live.view', 'api.key']);
  await setupRole('viewer', ['live.view']);
  await setupRole('operator', ['live.view', 'recording.list', 'device.read', 'device.clock', 'device.manage', 'channel.manage']);
});
after(() => t.close());

// ---- 1 key-principal-display-name-as-owner
test('baska uyenin adini tasiyan kendi anahtari o uyenin anahtarlarini yonetemez/yenileyemez', async () => {
  const management = await setupKey({ name: 'yonetim', role: 'admin' });
  await setupMember('ent1', 'entegrator');
  const own = await setupKey({ name: 'admin', permissions: ['live.view', 'api.key'] }, 'ent1');       // goruntu adi: "admin"
  const b = own.key;
  const list = await req('/api/access/keys', { bearer: b });
  assert.equal(list.status, 200); assert.ok(list.json.every((a) => a.owner === 'ent1'), 'yalniz kendi sahibinin anahtarlari listelenmeli');
  assert.equal((await req(`/api/access/keys/${management.record.id}`, { bearer: b })).status, 403);
  const reload = await req(`/api/access/keys/${management.record.id}/rotate`, { method: 'POST', bearer: b });
  assert.equal(reload.status, 403, reload.text);
  assert.equal((await req('/api/v1/me', { bearer: management.key })).status, 200, 'yonetim anahtari bozulmamali');
  // anahtarla acilan anahtarin sahibi anahtarin adi degil, anahtarin sahibi olan uyedir
  const sub = await req('/api/v1/keys', { method: 'POST', bearer: b, body: { name: 'admin', permissions: ['live.view'] } });
  assert.equal(sub.json.record.owner, 'ent1');
});

// ---- 2 member-update-delete-target-authority-unchecked
test('member.manage sahibi kendinden yetkili uyeyi degistiremez/silemez; kapsamli yonetici kapsamsiz uyeyi degistiremez', async () => {
  await setupMember('mudur1', 'uyeci');
  for (const [method, body] of [['PATCH', { password: 'saldirgan123' }], ['PATCH', { role: 'viewer' }], ['DELETE', undefined]]) {
    const r = await req('/api/members/admin', { who: 'mudur1', method, body });
    assert.equal(r.status, 403, `${method}: ${r.text}`); assert.equal(r.json.code, 'PRIVILEGE_ESCALATION');
  }
  await login('admin', 'adminparola1');                                    // admin parolasi degismedi
  const a = (await devices()).A;
  await setupMember('mudur2', 'uyeci', { scope: { devices: [a.id] } });
  await setupMember('dusuk1', 'viewer');                                      // kapsamsiz, izinleri mudur2'ninkinin alt kumesi
  assert.equal((await req('/api/members/dusuk1', { who: 'mudur2', method: 'PATCH', body: { password: 'saldirgan123' } })).json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await req('/api/members/dusuk1', { who: 'mudur2', method: 'DELETE' })).status, 403);
  await setupMember('dusuk2', 'viewer', { scope: { channels: [1] } });       // kapsami mudur2'ninkinin icinde: serbest
  assert.equal((await req('/api/members/dusuk2', { who: 'mudur2', method: 'PATCH', body: { password: 'yenisifre123' } })).status, 200);
});

// ---- 4 api-key-outlives-owner-revocation
test('anahtar sahibi silinir/dusurulur/suresi dolur/IP disina cikarsa anahtar da islemez; sahip silinince anahtarlari iptal olur', async () => {
  await setupMember('dus1', 'operator');
  const k = await setupKey({ name: 'k', permissions: ['live.view', 'recording.list'], owner: 'dus1' });
  assert.ok((await req('/api/v1/me', { bearer: k.key })).json.permissions.includes('recording.list'));
  assert.equal((await req('/api/members/dus1', { method: 'PATCH', body: { role: 'viewer' } })).status, 200);
  const dropped = (await req('/api/v1/me', { bearer: k.key })).json;
  assert.ok(!dropped.permissions.includes('recording.list') && dropped.permissions.includes('live.view'), 'anahtar sahibinin guncel rolunu asamaz');
  assert.equal((await req('/api/members/dus1', { method: 'DELETE' })).status, 200);
  assert.equal((await req('/api/v1/me', { bearer: k.key })).status, 401);
  await setupMember('dus1', 'operator');                                        // ayni ad yeniden: eski anahtarlari devralamaz
  assert.equal((await req('/api/v1/me', { bearer: k.key })).json.code, 'KEY_REVOKED');
  // suresi dolan sahip
  await setupMember('dus2', 'operator'); const k2 = await setupKey({ name: 'k2', permissions: ['live.view'], owner: 'dus2' });
  h.members.find('dus2').expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await req('/api/v1/me', { bearer: k2.key })).status, 401);
  // IP listesi disindaki sahip
  await setupMember('dus3', 'operator'); const k3 = await setupKey({ name: 'k3', permissions: ['live.view'], owner: 'dus3' });
  h.members.find('dus3').ips = ['10.1.1.1'];
  assert.equal((await req('/api/v1/me', { bearer: k3.key })).json.code, 'IP_BLOCKED');
  // sahibi uye olmayan (permission.manage'in verdigi entegrasyon etiketi) anahtar kendi haklariyla calisir
  const e = await setupKey({ name: 'e', permissions: ['live.view'], owner: 'entegrasyon-etiketi' });
  assert.equal((await req('/api/v1/me', { bearer: e.key })).status, 200);
});

// ---- 5 stateless-session-cookie-no-revocation (+15 etiket ayrimi)
test('cerez cikista, parola degisince ve ayni adla yeniden acilista gecersiz olur', async () => {
  await setupMember('oturum1', 'viewer');
  const c1 = cookies.get('oturum1');
  assert.equal((await req('/api/me', { cookie: c1 })).status, 200);
  assert.equal((await req('/api/logout', { method: 'POST', cookie: c1 })).status, 200);
  assert.equal((await req('/api/me', { cookie: c1 })).status, 401, 'cikistan sonra eski cerez islememeli');
  await login('oturum1', P('oturum1'));
  const c2 = cookies.get('oturum1');
  assert.equal((await req('/api/members/oturum1', { method: 'PATCH', body: { password: 'degisti12345' } })).status, 200);
  assert.equal((await req('/api/me', { cookie: c2 })).status, 401, 'parola degisince eski cerez islememeli');
  await login('oturum1', 'degisti12345');
  const c3 = cookies.get('oturum1');
  assert.equal((await req('/api/members/oturum1', { method: 'DELETE' })).status, 200);
  await setupMember('oturum1', 'admin');
  assert.equal((await req('/api/me', { cookie: c3 })).status, 401, 'ayni adla yeni hesap eski cerezi devralamaz');
  // kendi parolasini degistiren oturumdan dusmez (yeni cerez ayni yanitta gelir)
  await setupMember('oturum2', 'uyeci');
  assert.equal((await req('/api/members/oturum2', { who: 'oturum2', method: 'PATCH', body: { password: 'kendi12345678' } })).status, 200);
  assert.equal((await req('/api/me', { who: 'oturum2' })).status, 200);
});

// ---- 15 signed-cookie-key-reuse-no-domain-separation
test('etiketsiz (eski bicim) imzali ya da tipsiz talepli cerez oturum sayilmaz', async () => {
  const plain = (payload) => `${payload}.${createHmac('sha256', h.members.secret).update(payload).digest('base64url')}`;
  const load = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal((await req('/api/me', { cookie: `cam_session=${plain(load({ a: 'admin', e: Date.now() + 1e6 }))}` })).status, 401, 'eski bicim');
  await setupMember('undefined', 'viewer');
  // KYM akis cerezi bicimi ({d,s,e}) ayni anahtarla imzali: 'undefined' adli uyeye oturum vermemeli
  const stream = plain(load({ d: 'x', s: 'y', e: Date.now() + 1e6 }));
  assert.equal((await req('/api/me', { cookie: `cam_session=${stream}` })).status, 401);
  // dogru etiketle imzali ama tipsiz talep de reddedilir
  const labeled = (o) => { const y = load(o); return `${y}.${h.members.labeledSignature('kamera2/oturum', y)}`; };
  assert.equal((await req('/api/me', { cookie: `cam_session=${labeled({ e: Date.now() + 1e6 })}` })).status, 401);
  assert.equal((await req('/api/me', { cookie: `cam_session=${labeled({ t: 'oturum', a: 5, e: Date.now() + 1e6 })}` })).status, 401);
});

// ---- 6 key-bindings-not-bounded-by-creator
test('kisitli olusturan kisitsiz anahtar uretemez; sahip, admin koydugu kisiti gevsetemez', async () => {
  await setupMember('ent2', 'entegrator');
  assert.equal((await req('/api/members/ent2', { method: 'PATCH', body: { ips: ['127.0.0.1'], expiresAt: '2099-01-01' } })).status, 200);
  await login('ent2', P('ent2'));
  const k = await setupKey({ name: 'a', permissions: ['live.view'] }, 'ent2');
  assert.deepEqual(k.record.ips, ['127.0.0.1']); assert.equal(k.record.expiresAt, (h.members.find('ent2')).expiresAt);
  for (const body of [{ ips: ['10.0.0.0/8'] }, { expiresAt: '2100-01-01' }]) {
    const r = await req('/api/access/keys', { who: 'ent2', method: 'POST', body: { name: 'b', permissions: ['live.view'], ...body } });
    assert.equal(r.status, 403, r.text); assert.equal(r.json.code, 'PRIVILEGE_ESCALATION');
  }
  assert.equal((await req(`/api/access/keys/${k.record.id}`, { who: 'ent2', method: 'PATCH', body: { ips: [] } })).status, 403);
  // anahtar ebeveyn: hiz/akis siniri asilamaz
  const narrow = await setupKey({ name: 'dar', permissions: ['live.view', 'api.key'], owner: 'ent2', rateLimit: 50, concurrentStreams: 1 });
  const child = await req('/api/v1/keys', { method: 'POST', bearer: narrow.key, body: { name: 'c', permissions: ['live.view'] } });
  assert.equal(child.status, 200, child.text); assert.ok(child.json.record.rateLimit <= 50 && child.json.record.concurrentStreams <= 1);
  assert.equal((await req('/api/v1/keys', { method: 'POST', bearer: narrow.key, body: { name: 'c2', permissions: ['live.view'], rateLimit: 100 } })).json.code, 'PRIVILEGE_ESCALATION');
  // admin'in atadigi kisit
  const assigned = await setupKey({ name: 'atanmis', permissions: ['live.view'], owner: 'ent2', ips: ['127.0.0.1'], rateLimit: 10 });
  const patch = (body) => req(`/api/access/keys/${assigned.record.id}`, { who: 'ent2', method: 'PATCH', body });
  assert.equal((await patch({ ips: [] })).status, 403);
  assert.equal((await patch({ rateLimit: 100 })).status, 403);
  assert.equal((await patch({ rateLimit: 5 })).status, 200);
});

// ---- 13 member-self-restriction-lift
test('kisitli uye yoneticisi kendi bitis/IP kisitini kaldiramaz ve gevsek ikiz hesap acamaz', async () => {
  await setupMember('mgr1', 'uyeci');
  assert.equal((await req('/api/members/mgr1', { method: 'PATCH', body: { ips: ['127.0.0.1'], expiresAt: '2099-01-01' } })).status, 200);
  await login('mgr1', P('mgr1'));
  const me = (await req('/api/members')).json.find((u) => u.name === 'mgr1');
  const patch = (body) => req('/api/members/mgr1', { who: 'mgr1', method: 'PATCH', body });
  for (const body of [{ expiresAt: null }, { ips: [] }, { ips: ['127.0.0.1', '10.0.0.1'] }, { expiresAt: '2100-01-01' }]) assert.equal((await patch(body)).json.code, 'PRIVILEGE_ESCALATION', JSON.stringify(body));
  assert.equal((await patch({ role: 'uyeci', scope: null, expiresAt: me.expiresAt, ips: me.ips })).status, 200, 'arayuz hepsini geri yollar: degismeyen deger serbest');
  const twin = (body) => req('/api/members', { who: 'mgr1', method: 'POST', body: { name: 'ikiz1', password: P('ikiz1'), role: 'viewer', ...body } });
  assert.equal((await twin({})).json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await twin({ ips: ['127.0.0.1'] })).json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await twin({ expiresAt: '2100-01-01', ips: ['127.0.0.1'] })).json.code, 'PRIVILEGE_ESCALATION');
  assert.equal((await twin({ expiresAt: me.expiresAt, ips: ['127.0.0.1'] })).status, 200);
});

// ---- 7 device-password-reuse-on-host-change
test('cihazin adresi/portu parola yeniden girilmeden degistirilemez', async () => {
  const c = await req('/api/devices', { method: 'POST', body: { name: 'Sahte C', type: 'mock', host: '127.0.0.13', username: 'u', password: 'cihazparola', label: 'C' } });
  assert.equal(c.status, 200, c.text); const id = c.json.id;
  const patch = (body) => req(`/api/devices/${id}`, { method: 'PATCH', body });
  const r = await patch({ host: '127.0.0.99' }); assert.equal(r.status, 400, r.text); assert.match(r.json.error, /parola/);
  assert.equal((await patch({ host: '127.0.0.13', httpPort: 8080 })).status, 400, 'port degisimi de parola ister');
  const host = async () => (await req('/api/devices')).json.devices.find((x) => x.id === id).host;
  assert.equal(await host(), '127.0.0.13');
  assert.equal((await patch({ name: 'Sahte C2', host: '127.0.0.13' })).status, 200, 'adres ayni: parolasiz duzenlenebilir');
  assert.equal((await patch({ host: '127.0.0.98', password: 'yeniparola1' })).status, 200, 'parola verilirse adres degisebilir');
  assert.equal(await host(), '127.0.0.98');
  assert.equal((await req(`/api/devices/${id}`, { method: 'DELETE' })).status, 200);
});

// ---- 9 numeric-channel-scope-rebinds-new-device
test('silinen cihazin kanal blogu yeni cihaza verilmez; kapsamli yonetici olmayan kanal numarasi veremez', async () => {
  const add = async (name, host) => { const r = await req('/api/devices', { method: 'POST', body: { name, type: 'mock', host, username: 'u', password: 'p1234567', label: 'D' } }); assert.equal(r.status, 200, r.text); return r.json.id; };
  const from = async (id) => (await req('/api/devices')).json.devices.find((c) => c.id === id).startIndex;
  const d1 = await add('Sahte X', '127.0.0.21'); const b1 = await from(d1);
  assert.equal((await req(`/api/devices/${d1}`, { method: 'DELETE' })).status, 200);
  const d2 = await add('Sahte Y', '127.0.0.22');
  assert.ok(await from(d2) >= b1 + 4, 'silinen blok yeniden kullanilmamali');
  assert.equal((await req(`/api/devices/${d2}`, { method: 'DELETE' })).status, 200);
  const a = (await devices()).A;
  await setupMember('mudur3', 'uyeci', { scope: { devices: [a.id] } });
  const r = await req('/api/members', { who: 'mudur3', method: 'POST', body: { name: 'onceden1', password: P('onceden1'), role: 'viewer', scope: { channels: [100] } } });
  assert.equal(r.status, 403, r.text); assert.equal(r.json.code, 'PRIVILEGE_ESCALATION');
});

// ---- 8 device-channel-writes-ignore-kapsam + 12 bilgi-kapsamsuz-unfiltered-metadata
test('kapsamli asal kapsam disi kanal/cihaz yazamaz; bilgi kapsam disi veri tasimaz', async () => {
  const { A, B } = await devices();
  assert.equal((await req('/api/channels', { method: 'PUT', body: { setting: { 0: { name: 'A-SIFIR' } } } })).status, 200);
  await setupMember('kapsb', 'operator', { scope: { devices: [B.id] } });
  const k = (path, method, body) => req(path, { who: 'kapsb', method, body });
  const outer = await k('/api/channels', 'PUT', { setting: { 0: { name: 'ele-gecirildi', view: 'hide' } } });
  assert.equal(outer.status, 403, outer.text); assert.equal(outer.json.code, 'OUT_OF_SCOPE');
  assert.equal((await k('/api/channels', 'PUT', { setting: { 4: { name: 'B-SIFIR' } } })).status, 200);
  assert.equal(h.devices.channelSetting['0']?.name, 'A-SIFIR', 'kapsam disi ayar korunmali');
  assert.equal(h.devices.channelSetting['4']?.name, 'B-SIFIR');
  assert.equal((await k('/api/dvr/clock', 'POST', { device: A.id })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await k('/api/dvr/clock', 'POST', { device: B.id })).status, 200);
  assert.equal((await k(`/api/devices/${A.id}`, 'PATCH', { name: 'ele' })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await k(`/api/devices/${A.id}`, 'DELETE')).json.code, 'OUT_OF_SCOPE');
  assert.equal((await k(`/api/devices/${A.id}/camera`, 'POST', { name: 'x', ip: '10.0.0.1', username: 'u', password: 'p' })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await k('/api/devices', 'POST', { name: 'Z', type: 'mock', host: '127.0.0.50', username: 'u', password: 'p1234567' })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await k('/api/dvr/wipe', 'POST', { confirm: 'TÜM KAYITLARI SİL' })).json.code, 'OUT_OF_SCOPE');
  assert.equal((await devices()).A.name, 'Sahte A');
  // bilgi
  const b = (await k('/api/info', 'GET')).json;
  for (let i = 0; i < 4; i++) for (const field of ['channelNames', 'channelCodes', 'channelCamera', 'channelDevice', 'channelDeviceName']) assert.equal(b[field][i], '', `${field}[${i}]`);
  assert.deepEqual(Object.keys(b.channelSetting), ['4']);
  assert.ok(b.disks.every((d) => d.device === B.id) && b.disks.length === 1);
  assert.ok(!JSON.stringify(b).includes('127.0.0.11') && !JSON.stringify(b).includes('S-127.0.0.11'), 'kapsam disi cihaz adresi/seri no sizmamali');
  assert.equal(b.devices.length, 1); assert.equal(b.diskMB.total, 1000);
  assert.equal(b.channelNames.length, b.channelEmpty.length, 'dizi uzunlugu korunur');
});

// ---- 11 public-docs-and-meta-routes-outside-kimlik
test('dokuman ve /api/v1 oturum ister; saglik yalniz dongu adresinden; .json statik sunulmaz', async () => {
  for (const path of ['/docs', '/docs/api-v1.tr.md', '/docs/openapi.json', '/api/v1']) {
    assert.equal((await req(path, { who: null })).status, 401, path);
    assert.equal((await req(path)).status, 200, `${path} oturumla acilmali`);
  }
  assert.equal((await req('/docs/..%2Fpackage.json')).status, 404);
  assert.equal((await req('/css/eys/OZET.json', { who: null })).status, 404);
  assert.equal((await req('/css/app.css', { who: null })).status, 200);
  assert.equal((await req('/', { who: null })).status, 200);
  const s = await req('/api/v1/health', { who: null });
  assert.equal(s.status, 200); assert.deepEqual(s.json, { ok: true });
  assert.equal((await req('/api/v1/health', { who: null, headers: { 'X-Real-IP': '203.0.113.9' } })).status, 404, 'vekil uzerinden gelen istek saglik yoklamasi sayilmaz');
});

// ---- 14 request-url-parse-outside-try
test('bozuk istek hedefi 400 ile yanitlanir', async () => {
  const response = await new Promise((resolve) => {
    const s = connect(t.server.address().port, '127.0.0.1', () => s.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let v = ''; s.on('data', (b) => { v += b; }); s.on('end', () => resolve(v)); s.on('error', () => resolve(v));
    setTimeout(() => { s.destroy(); resolve(v); }, 3000);
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
});

// ---- NV: indirme de akis hakkindan sayilir; ffmpeg baslatilamazsa panel dusmez
test('indirme eszamanli akis sinirina tabidir (eszamanliAkis=0 olan anahtar indiremez)', async () => {
  const k = await setupKey({ name: 'indirici', permissions: ['recording.download'], concurrentStreams: 0 });
  const path = '/api/v1/cameras/0/download?file=/sahte/c0/x.h264&from=2026-10-05%2010:00:00&to=2026-10-05%2010:05:00';
  const r = await req(path, { bearer: k.key });
  assert.equal(r.status, 429, r.text); assert.equal(r.json.code, 'STREAM_LIMIT');
  const k2 = await setupKey({ name: 'indirici2', permissions: ['recording.download'], concurrentStreams: 1 });
  assert.equal((await req(path, { bearer: k2.key })).status, 200);
});

test('ffmpeg baslatilamazsa (ENOENT) yayin hata ile kapanir, surec dusmez', async () => {
  const device = { ffmpeg: '/yok/ffmpeg-yok', rtspUrl: () => 'rtsp://127.0.0.1:1/x', scale: () => 'scale=320:180' };
  const y = new RtspFeed(device, '/x', 320, () => {}, false);
  y.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(y.stopped, true); y.stop();
});

// ---- NV: giris hata kaydi sinirli
test('giris hata kaydi: kullanici adi kirpilir (anahtar uzunlugu sinirli)', async () => {
  try { await h.members.verify('x'.repeat(5000), 'yanlis', '9.9.9.9'); } catch {}
  assert.ok([...h.members.errors.keys()].every((a) => a.length <= '9.9.9.9|'.length + 64));
});

// ---- 10 preauth-login-sync-scrypt-no-rate-gate (IP'yi kilitler: EN SON)
test('kimliksiz giris IP basina sinirlanir (kullanici adi degistirerek asilamaz)', async () => {
  const statuses = [];
  for (let i = 0; i < 24; i++) statuses.push((await req('/api/login', { method: 'POST', body: { name: `yok${i}`, password: 'yanlis' }, who: null })).status);
  assert.ok(statuses.includes(429), `429 beklenirdi: ${statuses.join(',')}`);
  assert.ok(statuses.slice(0, 20).every((d) => d === 401));
  const r = await req('/api/login', { method: 'POST', body: { name: 'admin', password: 'adminparola1' }, who: null });
  assert.equal(r.status, 429); assert.equal(r.json.code, 'TOO_MANY_ATTEMPTS'); assert.ok(r.headers.get('retry-after'));
});
