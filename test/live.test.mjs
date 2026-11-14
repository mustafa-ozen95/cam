/**
 * /live: uyeliksiz izleme, yalniz admin duzen kaydeder, gomme yalniz /live'da serbest; mediamtx yollari (H.265 -> kaynak kalitede H.264).
 * mediamtx yerine kucuk bir sahte API (yol listesi bos, yazmalar kabul).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { CONVERTER_FLOOD, LIVE_TRANSCODE, WHEP_TIMEOUT, frozenPaths, livePaths, stuckConverters } from '../src/services/live.mjs';
import { openApp } from './helpers.mjs';

test('mediamtx yollari: H.264 dogrudan, H.265 kaynak + izlenince calisan cevirici (olcek/kare hizi suzgeci yok)', () => {
  const y = livePaths([{ k: 0, url: 'rtsp://a/0' }, { k: 32, url: 'rtsp://b/32' }, { k: 5, url: 'rtsp://a/5' }], new Map([[0, 'hevc'], [32, 'h264']]));
  assert.deepEqual(Object.keys(y).sort(), ['k0', 'k0_source', 'k32']);
  assert.deepEqual(y.k32, { source: 'rtsp://b/32', rtspTransport: 'tcp', sourceOnDemand: true });
  assert.equal(y.k0_source.source, 'rtsp://a/0');
  assert.equal(y.k0.source, 'publisher');
  assert.ok(y.k0.runOnDemand.includes(LIVE_TRANSCODE) && y.k0.runOnDemand.includes('rtsp://127.0.0.1:8554/k0_source') && !/scale|fps=/.test(y.k0.runOnDemand));
  assert.ok(LIVE_TRANSCODE.includes('-fps_mode passthrough') && LIVE_TRANSCODE.includes('RTCTIME'), 'zaman damgasi sicrayinca kopya kare uretilmez');
  assert.ok(!y.k0.runOnDemand.includes('rtsp://a/0'), 'cihaz adresi (parola) cevirici komutunda yok');
});

test('donmus kaynak: iki esitleme boyunca hazir ve bayt almayan cihaz kaynagi', () => {
  const requested = { k0: {}, k1_source: {}, k2: {}, k3: {} };
  const items = (b) => [
    { name: 'k0', ready: true, source: { type: 'rtspSource' }, bytesReceived: b.k0 },
    { name: 'k1_source', ready: true, source: { type: 'rtspSource' }, bytesReceived: b.k1 },
    { name: 'k1', ready: true, source: { type: 'rtspSession' }, bytesReceived: 7 },
    { name: 'k2', ready: false, source: { type: 'rtspSource' }, bytesReceived: 0 },
    { name: 'k9', ready: true, source: { type: 'rtspSource' }, bytesReceived: 5 },
  ];
  const first = frozenPaths(new Map(), items({ k0: 100, k1: 50 }), requested);
  assert.deepEqual(first.frozen, [], 'ilk olcumde karsilastiracak bir sey yok');
  const second = frozenPaths(first.received, items({ k0: 900, k1: 50 }), requested);
  assert.deepEqual(second.frozen, ['k1_source'], 'akan yol, ceviricinin yayini, hazir olmayan ve panelin yazmadigi yol dokunulmaz');
  assert.ok(!second.received.has('k1_source'), 'yeniden baglanan yol sifirdan olculur');
  assert.deepEqual(frozenPaths(second.received, items({ k0: 1700, k1: 0 }), requested).frozen, []);
});

test('takilan cevirici: kopya kare yigini ya da kaynagi okumayan cevirici yeniden baslatilir', () => {
  const requested = { k0: { source: 'publisher' }, k0_source: { source: 'rtsp://a/0' }, k1: { source: 'publisher' }, k1_source: {}, k2: { source: 'rtsp://a/2' } };
  const items = (o) => [
    { name: 'k0', ready: true, source: { type: 'rtspSession', id: o.s0 ?? 'a' }, bytesReceived: o.k0 },
    { name: 'k0_source', ready: true, readers: [{ type: 'rtspSession' }] },
    { name: 'k1', ready: true, source: { type: 'rtspSession', id: 'b' }, bytesReceived: o.k1 },
    { name: 'k1_source', ready: o.k1src, readers: o.k1src ? [{ type: 'rtspSession' }] : [] },
    { name: 'k2', ready: true, source: { type: 'rtspSource' }, bytesReceived: 99 },
  ];
  const t0 = 1_000_000;
  const a = stuckConverters(new Map(), items({ k0: 0, k1: 0, k1src: true }), requested, t0);
  assert.deepEqual(a.stuck, [], 'ilk olcumde hiz bilinmez');
  // 60 sn: k0 normal (125 KB/sn), k1 normal
  const b = stuckConverters(a.state, items({ k0: 125 * 1024 * 60, k1: 125 * 1024 * 60, k1src: true }), requested, t0 + 60_000);
  assert.deepEqual(b.stuck, []);
  // k0 kopya kare yigini (1,2 MB/sn); k1 kaynagi okumayi birakti (ilk kez: henuz dokunulmaz)
  const c = stuckConverters(b.state, items({ k0: 125 * 1024 * 60 + 1200 * 1024 * 60, k1: 2 * 125 * 1024 * 60, k1src: false }), requested, t0 + 120_000);
  assert.deepEqual(c.stuck.map((x) => [x.name, x.session]), [['k0', 'a']]);
  assert.ok(1200 * 1024 > CONVERTER_FLOOD && 125 * 1024 * 2 < CONVERTER_FLOOD);
  assert.ok(!c.state.has('k0'), 'yeniden baslatilan cevirici sifirdan olculur');
  // k1 ikinci kez kaynagi okumuyor: takili; k0 yeni oturumla geldi, ilk olcum
  const d = stuckConverters(c.state, items({ s0: 'yeni', k0: 10, k1: 3 * 125 * 1024 * 60, k1src: false }), requested, t0 + 180_000);
  assert.deepEqual(d.stuck.map((x) => [x.name, x.reason]), [['k1', 'kaynagi okumuyor']]);
  assert.equal(d.state.get('k0').session, 'yeni');
});

test('/live kapali (CAM_RTC_API bos): 404', async () => {
  const u = await openApp();
  try { for (const path of ['/live/', '/live/cameras.json', '/live/live.js']) assert.equal((await fetch(u.B + path)).status, 404, path); }
  finally { await u.close(); }
});

test('/live acik: izleme kimliksiz, duzen yalniz admin (CSRF), gomme yalniz /live', async () => {
  const mtx = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.url.includes('/list') ? '{"items":[]}' : '{}'); }).listen(0);
  await new Promise((r) => mtx.once('listening', r));
  const u = await openApp({ live: { rtcApi: `http://127.0.0.1:${mtx.address().port}`, frame: '*' } });
  try {
    await u.services.live.first;
    u.services.live.cameras = [{ path: 'k0', name: 'Kamera 1', device: 'A', converted: false }, { path: 'k1', name: 'Kamera 2', device: 'A', converted: true }];
    const y = await fetch(`${u.B}/live`, { redirect: 'manual' });
    assert.equal(y.status, 301); assert.equal(y.headers.get('location'), '/live/');
    const s = await fetch(`${u.B}/live/`);
    assert.equal(s.status, 200); assert.match(await s.text(), /<video|id="grid"/);
    assert.match(s.headers.get('content-security-policy'), /frame-ancestors \*/);
    assert.equal(s.headers.get('x-frame-options'), null);
    const panel = await fetch(`${u.B}/`);
    assert.match(panel.headers.get('content-security-policy'), /frame-ancestors 'self'/, 'panelin geri kalani gomulemez');
    assert.equal((await fetch(`${u.B}/live/live.js`)).status, 200);
    assert.equal((await fetch(`${u.B}/live/theme.mjs`)).status, 200);
    assert.equal((await fetch(`${u.B}/live/..%2Findex.html`)).status, 404);
    const k = await (await fetch(`${u.B}/live/cameras.json`)).json();
    assert.deepEqual(k.cameras.map((x) => x.path), ['k0', 'k1']); assert.ok(!JSON.stringify(k).includes('rtsp'));
    assert.deepEqual(await (await fetch(`${u.B}/live/access`)).json(), { canEdit: false, name: null });

    const body = JSON.stringify({ column: 3, paths: ['k1', 'k0'] });
    assert.equal((await fetch(`${u.B}/live/layout`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Cam': '1' }, body: body })).status, 401);
    await u.login('admin', 'adminparola1');
    const cookie = u.cookies.get('admin');
    assert.equal((await (await fetch(`${u.B}/live/access`, { headers: { Cookie: cookie } })).json()).canEdit, true);
    assert.equal((await fetch(`${u.B}/live/layout`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body })).status, 403, 'CSRF basligi yok');
    assert.equal((await u.req('/live/layout', { method: 'PUT', body: { column: 3, paths: ['k9'] } })).status, 400, 'bilinmeyen kamera');
    const r = await u.req('/live/layout', { method: 'PUT', body: { column: 3, paths: ['k1', 'k0'] } });
    assert.equal(r.status, 200); assert.equal(r.json.savedBy, 'admin');
    assert.deepEqual((await (await fetch(`${u.B}/live/layout.json`)).json()).paths, ['k1', 'k0']);

    await u.services.members.add('ayse', 'ayseparola12', 'camera');
    await u.login('ayse', 'ayseparola12');
    assert.equal((await u.req('/live/layout', { method: 'PUT', body: { column: 2, paths: ['k0'] }, who: 'ayse' })).status, 403, 'admin olmayan');
    assert.equal((await u.req('/live/access', { who: 'ayse' })).json.canEdit, false);
  } finally { await u.close(); mtx.close(); }
});

test('/live izleme baglantisi (WHEP): panel SDP teklifini mediamtx\'e gecirir; yalniz listelenen yollar, kimliksiz', async () => {
  const incoming = [];
  const mtx = createServer((req, res) => {
    let g = ''; req.on('data', (b) => { g += b; });
    req.on('end', () => {
      if (req.url.startsWith('/v3/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(req.url.includes('/list') ? '{"items":[]}' : '{}'); }
      incoming.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: g });
      if (req.url === '/k1/whep') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no stream is available on path'); }
      res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/k0/whep/oturum' }); res.end('v=0 cevap');
    });
  }).listen(0);
  await new Promise((r) => mtx.once('listening', r));
  const address = `http://127.0.0.1:${mtx.address().port}`;
  const u = await openApp({ live: { rtcApi: address, rtcWhep: address, frame: '*' } });
  const whep = (path, body = 'v=0 teklif', type = 'application/sdp', extra = { 'X-Cam': '1' }) => fetch(`${u.B}/live/rtc/${path}/whep`, { method: 'POST', headers: { 'Content-Type': type, ...extra }, body: body });
  try {
    await u.services.live.first;
    u.services.live.cameras = [{ path: 'k0', name: 'Kamera 1', device: 'A', converted: false }, { path: 'k1', name: 'Kamera 2', device: 'A', converted: true }];
    const r = await whep('k0');
    assert.equal(r.status, 201); assert.equal(r.headers.get('content-type'), 'application/sdp'); assert.equal(await r.text(), 'v=0 cevap');
    assert.deepEqual(incoming, [{ method: 'POST', path: '/k0/whep', type: 'application/sdp', body: 'v=0 teklif' }]);
    assert.equal((await whep('k1')).status, 404, 'mediamtx\'in hatasi aynen doner');
    incoming.length = 0;
    for (const path of ['k0_source', 'k9', '..%2Fv3%2Fconfig%2Fglobal%2Fget']) assert.equal((await whep(path)).status, 404, path);
    assert.equal((await whep('k0', 'v=0 teklif', 'application/sdp', {})).status, 403, 'CSRF basligi yok');
    assert.equal((await whep('k0', '{}', 'application/json')).status, 415);
    assert.equal((await whep('k0', 'x'.repeat(70_000))).status, 413);
    assert.deepEqual(incoming, [], 'listede olmayan yol ve gecersiz istek mediamtx\'e gitmez');
    mtx.close(); mtx.closeAllConnections?.();
    assert.equal((await whep('k0')).status, 502, 'mediamtx kapali');
  } finally { await u.close(); mtx.close(); }
});

test('/live izleme adresi verilmezse yonetim adresinin konagi, mediamtx\'in 8889\'u', async () => {
  const old = { ...process.env };
  try {
    process.env.CAM_RTC_API = 'http://dc-kamera-rtc:9997/';
    delete process.env.CAM_RTC_WHEP;
    const { config } = await import(`../config/app.mjs?t=${Date.now()}`);
    assert.equal(config.live.rtcWhep, 'http://dc-kamera-rtc:8889');
    process.env.CAM_RTC_WHEP = 'http://baska:1234/';
    assert.equal((await import(`../config/app.mjs?t=${Date.now() + 1}`)).config.live.rtcWhep, 'http://baska:1234');
  } finally { process.env = old; }
});

test('/live varsayilan duzen: CAM_LIVE_DEFAULT sirasi (1\'den kanal no), bossa ilk kameralar', async () => {
  const old = { ...process.env };
  try {
    process.env.CAM_LIVE_DEFAULT = '3, 1,x,0,2';
    const { config } = await import(`../config/app.mjs?t=${Date.now() + 2}`);
    assert.deepEqual(config.live.defaultOrder, ['k2', 'k0', 'k1']);
    delete process.env.CAM_LIVE_DEFAULT;
    assert.deepEqual((await import(`../config/app.mjs?t=${Date.now() + 3}`)).config.live.defaultOrder, []);
  } finally { process.env = old; }
  const { LiveService } = await import('../src/services/live.mjs');
  const cameras = [{ path: 'k0' }, { path: 'k1' }, { path: 'k2' }];
  const h = (defaultOrder) => Object.assign(Object.create(LiveService.prototype), { y: { defaultOrder: defaultOrder }, cameras, savedLayout: null });
  assert.deepEqual(h(['k2', 'k9', 'k0']).layout(), { column: 4, paths: ['k2', 'k0'], isDefault: true }, 'listede olmayan atlanir');
  assert.deepEqual(h([]).layout().paths, ['k0', 'k1', 'k2'], 'bos: ilk kameralar');
});

test('WHEP beklemesi mediamtx acilis suresinden uzun, tarayicininki panelinkinden uzun (kanal dusunce cevirici durdurulmaz)', () => {
  const yml = readFileSync(new URL('../docker/mediamtx.yml', import.meta.url), 'utf8');
  const sec = (k) => Number(yml.match(new RegExp(`${k}:\\s*(\\d+)s`))[1]) * 1000;
  assert.ok(WHEP_TIMEOUT > Math.max(sec('runOnDemandStartTimeout'), sec('sourceOnDemandStartTimeout')), 'panel mediamtx acilisini bekler');
  const js = readFileSync(new URL('../resources/views/live/live.js', import.meta.url), 'utf8');
  const browser = Number(js.match(/whep`[^\n]*AbortSignal\.timeout\((\d+)_?(\d*)\)/).slice(1).join(''));
  assert.ok(browser > WHEP_TIMEOUT, 'tarayici panelden once vazgecmez');
});
