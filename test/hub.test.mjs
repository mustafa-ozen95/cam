/**
 * Kimlik Yonetim Merkezi ile giris: sahte bir merkez (http) kurulur; PKCE akisi, hesap acma, rol eslemesi,
 * merkezin kapiyi kapatmasi (403), durum bildirimi (/api/kimlik/tazele) ve erisimin kalkmasi sinanir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/bootstrap.mjs';
import { tempDb } from './helpers.mjs';
import { config as base } from '../config/app.mjs';

const SECRET = 'istemci-sirri', NOTIFICATION = 'bildirim-sirri', CLIENT = 'kamera-istemci';
let hubServer, M, app, server, B, data, gv;
/** Sahte merkezin davranisi; testler degistirir. */
const hub = { challenge: null, code: 'KOD-1', username: { sub: '11111111-1111-7111-8111-111111111111', name: 'Ali Veli', email: 'ali.veli@ornek.test', email_verified: true, 'rol': 'admin', 'hesap_acilabilir': true }, unauthorized: false, status: { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin' }, queries: 0, logouts: [] };

before(async () => {
  hubServer = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const response = (k, j) => { res.writeHead(k, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/oauth/authorize') {
      hub.challenge = u.searchParams.get('code_challenge');
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('client_id'), CLIENT);
      const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', hub.code); back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (u.pathname === '/oauth/token') {
      let g = ''; for await (const p of req) g += p; const f = new URLSearchParams(g);
      if (f.get('client_secret') !== SECRET || f.get('code') !== hub.code) return response(401, { error: 'invalid_client' });
      if (createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== hub.challenge) return response(400, { error: 'invalid_grant' });
      return response(200, { access_token: 'JETON-1', token_type: 'Bearer' });
    }
    if (u.pathname === '/oauth/kullanici') {
      if (req.headers.authorization !== 'Bearer JETON-1') return response(401, {});
      if (hub.unauthorized) return response(403, { 'kod': 'rol_yetkisiz', 'hata': 'Bu uygulamaya erişim yetkiniz yok.' });
      return response(200, hub.username);
    }
    if (u.pathname === '/api/oturum-kapandi') {
      let g = ''; for await (const p of req) g += p; const j = JSON.parse(g);
      if (j.client_secret !== SECRET) return response(401, {});
      hub.logouts.push(j.subject); return response(200, { result: 'alındı' });
    }
    if (u.pathname === '/api/kimlik-durumu') {
      let g = ''; for await (const p of req) g += p; const j = JSON.parse(g); hub.queries++;
      if (j.client_secret !== SECRET) return response(401, {});
      return response(200, { 'kimlikler': Object.fromEntries(j['kimlikler'].map((k) => [k, hub.status])) });
    }
    response(404, {});
  });
  hubServer.listen(0, '127.0.0.1'); await new Promise((r) => hubServer.once('listening', r));
  M = `http://127.0.0.1:${hubServer.address().port}`;

  data = mkdtempSync(join(tmpdir(), 'cam-hub-'));
  gv = await tempDb();
  const y = { ...base, dataDir: data, database: gv.setting, server: { ...base.server, port: 0, address: '127.0.0.1' },
    device: { ...base.device, test: true, seed: JSON.stringify([{ name: 'Sahte', type: 'mock', host: '127.0.0.1', username: 'a', password: 'b', label: 'A' }]) },
    permissions: { ...base.permissions, initialAdminPassword: 'adminparola1' },
    identity: { ...base.identity, address: M, client: CLIENT, secret: SECRET, redirectUri: '', notifySecret: NOTIFICATION, checkMinutes: 60, roleMap: {}, defaultRole: '' } };
  app = await createApp(y);
  server = app.listen(); await new Promise((r) => server.once('listening', r));
  B = `http://127.0.0.1:${server.address().port}`;
  y.identity.redirectUri = `${B}/login/hub/callback`;   // donus adresi port bilinince yazilir (nesne paylasiliyor)
});
after(async () => { server.close(); hubServer.close(); await app.close(); await gv.remove(); rmSync(data, { recursive: true, force: true }); });

const cookie = (r) => (r.headers.get('set-cookie') ?? '').split(',').map((c) => c.split(';')[0]).filter(Boolean);

/** Tam akis: baslat -> merkez -> geri. Oturum cerezini dondurur (ya da hata kodunu). */
async function hubEnter() {
  const b = await fetch(`${B}/login/hub`, { redirect: 'manual' });
  assert.equal(b.status, 302);
  const flowCookie = cookie(b).find((c) => c.startsWith('cam_hub_flow='));
  assert.ok(flowCookie, 'akis cerezi yazilmali');
  const m = await fetch(b.headers.get('location'), { redirect: 'manual' });
  assert.equal(m.status, 302);
  const g = await fetch(m.headers.get('location'), { redirect: 'manual', headers: { Cookie: flowCookie } });
  assert.equal(g.status, 302);
  const position = g.headers.get('location');
  if (position !== '/') return { error: new URL(position, B).searchParams.get('hub') };
  return { session: cookie(g).find((c) => c.startsWith('cam_session=')) };
}
const me = (session) => fetch(`${B}/api/me`, { headers: { Cookie: session } });

test('giris sayfasi merkez dugmesini cizer', async () => {
  const html = await (await fetch(`${B}/`)).text();
  assert.match(html, /href="\/login\/hub"/);
  const faulty = await (await fetch(`${B}/?hub=denied`)).text();
  assert.match(faulty, /erişim yetkiniz yok/);
});

test('state eslesmeyen donus reddedilir', async () => {
  const g = await fetch(`${B}/login/hub/callback?code=x&state=uydurma`, { redirect: 'manual' });
  assert.equal(g.status, 302); assert.equal(g.headers.get('location'), '/?hub=state');
});

test('merkezle giris: hesap acilir, rol eslenir, oturum calisir', async () => {
  const { session, error } = await hubEnter();
  assert.equal(error, undefined); assert.ok(session);
  const r = await me(session); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.name, 'ali.veli@ornek.test'); assert.equal(j.role, 'admin');
  // ikinci giris ayni hesaba baglanir, yeni hesap acmaz
  const second = await hubEnter(); assert.ok(second.session);
  const members = await (await fetch(`${B}/api/members`, { headers: { Cookie: second.session } })).json();
  assert.equal(members.filter((u) => u.name.startsWith('ali.veli')).length, 1);
});

test('merkez kapiyi kapatirsa (403) giris reddedilir', async () => {
  hub.unauthorized = true;
  try { const { error } = await hubEnter(); assert.equal(error, 'denied'); } finally { hub.unauthorized = false; }
});

test('hesap acilamaz denince yeni kimlik giremez', async () => {
  const old = hub.username;
  hub.username = { ...old, sub: '22222222-2222-7222-8222-222222222222', email: 'yeni@ornek.test', 'hesap_acilabilir': false };
  try { const { error } = await hubEnter(); assert.equal(error, 'denied'); } finally { hub.username = old; }
});

test('merkezde erisim kalkinca bildirimle oturum duser; geri gelince acilir', async () => {
  const { session } = await hubEnter();
  assert.equal((await me(session)).status, 200);
  hub.status = { 'durum': 'askida', 'girebilir': false, 'rol': 'admin' };
  const signature = createHmac('sha256', NOTIFICATION).update(hub.username.sub).digest('hex');
  // imzasiz bildirim merkeze sordurmaz: durum askida olsa da oturum surer
  const queriesBefore = hub.queries;
  await fetch(`${B}/api/kimlik/tazele`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: hub.username.sub }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.queries, queriesBefore, 'imzasiz bildirim merkeze soru acmamali');
  assert.equal((await me(session)).status, 200, 'imzasiz bildirim erisimi degistirmemeli');
  const t = await fetch(`${B}/api/kimlik/tazele`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kimlik-Imza': signature }, body: JSON.stringify({ subject: hub.username.sub }) });
  assert.equal(t.status, 200);
  await app.services.links.refresh(hub.username.sub);
  assert.equal((await me(session)).status, 401, 'erisimi kalkan kisi 401 almali');
  hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'network' };
  await app.services.links.refresh(hub.username.sub);
  const r = await me(session); assert.equal(r.status, 200);
  assert.equal((await r.json()).role, 'network', 'merkezdeki rol degisince ayni adli DC rolu uygulanmali');
  hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin' };
  await app.services.links.refresh(hub.username.sub);
});

test('yerel parola girisi merkezden bagimsiz calisir', async () => {
  const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cam': '1' }, body: JSON.stringify({ name: 'admin', password: 'adminparola1' }) });
  assert.equal(r.status, 200);
});

// ---- guvenlik denetimi duzeltmeleri ----
/** Yerel admin oturumu (parola girisi) ile yonetim istekleri. */
async function localAdmin() {
  const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cam': '1' }, body: JSON.stringify({ name: 'admin', password: 'adminparola1' }) });
  assert.equal(r.status, 200);
  const session = cookie(r).find((c) => c.startsWith('cam_session='));
  return (path, method = 'GET', body) => fetch(`${B}${path}`, { method: method, headers: { Cookie: session, 'X-Cam': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

test('merkezdeki kamera rolu panelde kamera rolune eslenir: izler, yonetemez', async () => {
  const old = hub.username, legacyStatus = hub.status;
  hub.username = { ...old, sub: '55555555-5555-7555-8555-555555555555', name: 'Kam Era', email: 'kam.era@ornek.test', 'rol': 'kamera' };
  hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'kamera' };
  try {
    const { session } = await hubEnter(); assert.ok(session);
    const j = await (await me(session)).json();
    assert.equal(j.role, 'camera');
    assert.equal((await fetch(`${B}/api/members`, { headers: { Cookie: session } })).status, 403);
  } finally { hub.username = old; hub.status = legacyStatus; }
});

test('kym-bag: silinen uyenin adi yeniden kullanilsa eski kimlik yeni hesabi devralamaz ve rolunu degistiremez', async () => {
  const old = hub.username;
  hub.username = { ...old, sub: '33333333-3333-7333-8333-333333333333', name: 'Zed Kim', email: 'zed.kim@ornek.test', 'rol': 'admin' };
  try {
    const first = await hubEnter(); assert.ok(first.session);
    assert.equal((await (await me(first.session)).json()).name, 'zed.kim@ornek.test');
    const management = await localAdmin();
    assert.equal((await management('/api/members/zed.kim@ornek.test', 'DELETE')).status, 200);
    assert.ok(!Object.values(app.services.links.data).some((b) => b.name === 'zed.kim@ornek.test'), 'uye silinince bag da gider');
    assert.equal((await management('/api/members', 'POST', { name: 'zed.kim@ornek.test', password: 'zedparola12', role: 'technical' })).status, 200);
    const second = await hubEnter(); assert.ok(second.session);
    const j = await (await me(second.session)).json();
    assert.notEqual(j.name, 'zed.kim@ornek.test', 'eski kimlik yeni zed.kim hesabina girmemeli');
    const local = (await (await management('/api/members')).json()).find((u) => u.name === 'zed.kim@ornek.test');
    assert.equal(local.role, 'technical', 'yeni hesabin rolu merkezdeki rolle ezilmemeli');
  } finally { hub.username = old; }
});

test('kym-bag: merkezde erisimi kalkan uyenin API anahtari da islemez', async () => {
  const old = hub.username, sub = '44444444-4444-7444-8444-444444444444';
  hub.username = { ...old, sub, name: 'Key Owner', email: 'key.owner@ornek.test', 'rol': 'admin' };
  try {
    const { session } = await hubEnter(); assert.ok(session);
    const management = await localAdmin();
    const k = await (await management('/api/access/keys', 'POST', { name: 'k', permissions: ['live.view'], owner: 'key.owner@ornek.test' })).json();
    const bearer = () => fetch(`${B}/api/v1/me`, { headers: { Authorization: `Bearer ${k.key}` } });
    assert.equal((await bearer()).status, 200);
    hub.status = { 'durum': 'askida', 'girebilir': false, 'rol': 'admin' };
    await app.services.links.refresh(sub);
    assert.equal((await bearer()).status, 401, 'merkezde erisimi kalkan sahibin anahtari islememeli');
    hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin' };
    await app.services.links.refresh(sub);
    assert.equal((await bearer()).status, 200);
  } finally { hub.username = old; hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin' }; }
});

test('cerez etiketi: merkez akis cerezi oturum cerezi olarak, oturum cerezi akis cerezi olarak gecmez', async () => {
  const management = await localAdmin();
  assert.equal((await management('/api/members', 'POST', { name: 'undefined', password: 'undefparola1', role: 'technical' })).status, 200);
  const b = await fetch(`${B}/login/hub`, { redirect: 'manual' });
  const stream = cookie(b).find((c) => c.startsWith('cam_hub_flow=')).split('=').slice(1).join('=');
  assert.equal((await me(`cam_session=${stream}`)).status, 401, "akis cerezi 'undefined' uyesine oturum vermemeli");
  const session = (await (await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cam': '1' }, body: JSON.stringify({ name: 'admin', password: 'adminparola1' }) })).headers.get('set-cookie')).split(';')[0].split('=').slice(1).join('=');
  const g = await fetch(`${B}/login/hub/callback?code=x&state=y`, { redirect: 'manual', headers: { Cookie: `cam_hub_flow=${session}` } });
  assert.equal(g.headers.get('location'), '/?hub=state', 'oturum cerezi akis cerezi olarak kabul edilmemeli');
});

// ORTAK CIKIS: merkezdeki son cikistan once acilan oturum islemez; buradan cikis merkeze bildirilir.
const notifyLogout = (moment, signature) => fetch(`${B}/api/kimlik/cikis`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kimlik-Imza': signature ?? createHmac('sha256', NOTIFICATION).update(`cikis|${hub.username.sub}|${moment}`).digest('hex') }, body: JSON.stringify({ subject: hub.username.sub, moment }) });

test('merkezin imzali cikis bildirimi acik oturumu kapatir; sonra acilan oturum surer', async () => {
  const { session } = await hubEnter();
  assert.equal((await me(session)).status, 200);
  const moment = Date.now() + 5;
  assert.equal((await notifyLogout(moment, 'yanlis')).status, 200);
  assert.equal((await notifyLogout(moment + 1, createHmac('sha256', NOTIFICATION).update(`cikis|${hub.username.sub}|${moment}`).digest('hex'))).status, 200);
  assert.equal((await me(session)).status, 200, 'imzasi tutmayan (ya da baska an icin) bildirim oturumu kapatmamali');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await notifyLogout(moment)).status, 200);
  const r = await me(session); assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'HUB_LOGOUT');
  const page = await (await fetch(`${B}/`, { headers: { Cookie: session } })).text();
  assert.ok(page.includes('gate__'), 'API 401 verirken ana sayfa paneli vermemeli: giris sayfasi gelmeli (yoksa sayfa durmadan yenilenir)');
  const { session: fresh } = await hubEnter();
  assert.equal((await me(fresh)).status, 200, 'cikistan sonra acilan oturum surmeli');
  await notifyLogout(moment - 1000);
  assert.equal((await me(fresh)).status, 200, 'gec gelen eski an yeni oturumu kapatmamali');
});

test('buradan cikis merkeze bildirilir', async () => {
  const { session } = await hubEnter();
  hub.logouts.length = 0;
  const r = await fetch(`${B}/api/logout`, { method: 'POST', headers: { Cookie: session, 'X-Cam': '1' } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && !hub.logouts.length; i++) await new Promise((t) => setTimeout(t, 10));
  assert.deepEqual(hub.logouts, [hub.username.sub]);
});

test('durum sorgusundaki son_cikis uygulanir (bildirim kaybolsa da)', async () => {
  const { session } = await hubEnter();
  await new Promise((r) => setTimeout(r, 5));
  hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin', 'son_cikis': Date.now() };
  try {
    await app.services.links.refresh(hub.username.sub);
    assert.equal((await me(session)).status, 401);
  } finally { hub.status = { 'durum': 'aktif', 'girebilir': true, 'rol': 'admin' }; }
});
