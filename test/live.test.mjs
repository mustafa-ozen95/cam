/**
 * Canli sayfalar (/<yol>/): public sayfada uyeliksiz izleme, private sayfada giris + rol; duzeni yalniz livepage.manage kaydeder;
 * gomme yalniz public sayfada serbest; sayfa yalniz kendi duzenindeki kameralari verir; mediamtx yollari (H.265 -> kaynak kalitede H.264).
 * mediamtx yerine kucuk bir sahte API (yol listesi bos, yazmalar kabul).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONVERTER_FLOOD, LIVE_TRANSCODE, LiveService, STALL_INTERVAL, WHEP_TIMEOUT, deviceSources, frozenPaths, livePaths, stuckConverters } from '../src/services/live.mjs';
import { DeviceGroup } from '../src/drivers/group.mjs';
import { DeviceBase } from '../src/drivers/base.mjs';
import { openApp } from './helpers.mjs';

test('mediamtx yollari: H.264 dogrudan, H.265 kaynak + izlenince calisan cevirici (olcek/kare hizi suzgeci yok)', () => {
  const y = livePaths([{ k: 0, url: 'rtsp://a/0' }, { k: 32, url: 'rtsp://b/32' }, { k: 5, url: 'rtsp://a/5' }], new Map([[0, 'hevc'], [32, 'h264']]));
  assert.deepEqual(Object.keys(y).sort(), ['k0', 'k0_source', 'k32', 'k5_source'], 'kodegi olculmemis kanal yalniz kaynak yolu (olcum mediamtx uzerinden)');
  assert.deepEqual(y.k5_source, { source: 'rtsp://a/5', rtspTransport: 'tcp', sourceOnDemand: true });
  const m = livePaths([{ k: 2, url: 'rtsp://a/2s1', main: 'rtsp://a/2s0' }], new Map([[2, 'h264']]));
  assert.deepEqual(Object.keys(m).sort(), ['k2', 'k2_main']);
  assert.deepEqual(m.k2_main, { source: 'rtsp://a/2s0', rtspTransport: 'tcp', sourceOnDemand: true }, 'ana akis yalniz okunurken cihaza baglanir');
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

test('takilan cevirici: panel kaynak yolunu okusa da yalniz mediamtx icindeki (127.0.0.1) okuyucu sayilir', () => {
  const requested = { k1: { source: 'publisher' }, k1_source: {} };
  const items = [{ name: 'k1', ready: true, source: { type: 'rtspSession', id: 'b' }, bytesReceived: 0 }, { name: 'k1_source', ready: true, readers: [{ type: 'rtspSession', id: 'panel' }] }];
  const a = stuckConverters(new Map(), items, requested, 1, new Set(['cevirici']));
  const b = stuckConverters(a.state, items, requested, 60_001, new Set(['cevirici']));
  assert.deepEqual(b.stuck.map((x) => x.reason), ['kaynagi okumuyor']);
  assert.deepEqual(stuckConverters(new Map(), items, requested, 1, new Set(['panel'])).state.get('k1').strikes, 0);
});

test('relay: panel canli akisi mediamtx yolundan; kapali/esitlenmemis/olculmemis kanal null (cihaza dogrudan); takilan kaynak hizla yeniden kurulur', async () => {
  const calls = [];
  const s = new LiveService({ config: { live: { rtcApi: 'http://cam-rtc:9997' } }, devices: { ffmpeg: 'ffmpeg' }, livePages: null });
  assert.equal(s.rtsp, 'rtsp://cam-rtc:8554');
  assert.equal(s.relay(0, 'Extra1'), null, 'ilk esitleme yok');
  s.healthy = true;
  for (const n of ['k0', 'k0_source', 'k0_main', 'k1', 'k1_main', 'k2_source']) s.written.set(n, JSON.stringify({ source: `rtsp://nvr/${n}` }));
  s.codec.set(0, 'hevc'); s.codec.set(1, 'h264');
  const r = (k, t) => { const x = s.relay(k, t); return x && { copy: x.copy, h264: x.h264 }; };
  assert.deepEqual(r(0, 'Extra1'), { copy: 'rtsp://cam-rtc:8554/k0_source', h264: 'rtsp://cam-rtc:8554/k0' });
  assert.deepEqual(r(1, 'Extra1'), { copy: 'rtsp://cam-rtc:8554/k1', h264: 'rtsp://cam-rtc:8554/k1' });
  assert.deepEqual(r(0, 'Main'), { copy: 'rtsp://cam-rtc:8554/k0_main', h264: null });
  assert.equal(r(2, 'Extra1'), null, 'kodek olculmedi');
  assert.equal(r(2, 'Main'), null, 'yol yazilmamis');
  s.healthy = false; assert.equal(r(0, 'Main'), null, 'mediamtx ulasilamiyor'); s.healthy = true;
  assert.equal(new LiveService({ config: { live: { rtcApi: '' } }, devices: {}, livePages: null }).relay(0, 'Main'), null, '/live kapali');

  const mtx = createServer((req, res) => { calls.push(`${req.method} ${req.url}`); req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); }).listen(0);
  await new Promise((ok) => mtx.once('listening', ok));
  try {
    s.y = { rtcApi: `http://127.0.0.1:${mtx.address().port}` };
    assert.equal(await s.stall(0, 'Extra1', 100_000), true);
    assert.deepEqual(calls, ['DELETE /v3/config/paths/delete/k0_source', 'POST /v3/config/paths/add/k0_source'], 'cihaza giden kaynak yolu');
    assert.equal(await s.stall(0, 'Extra1', 100_000 + STALL_INTERVAL - 1), false, 'yol basina sinirli');
    assert.equal(await s.stall(0, 'Main', 100_000), true); assert.equal(calls.at(-1), 'POST /v3/config/paths/add/k0_main');
    assert.equal(await s.stall(1, 'Extra1', 100_000), true); assert.equal(calls.at(-1), 'POST /v3/config/paths/add/k1', 'H.264 kanalda kaynak kN');
  } finally { mtx.close(); }
});

test('akis butcesi: mediamtx\'in cihaza acik oturumlari cihaz basina sayilir; kayitli oynatma dolu cihazda acilmaz', () => {
  const items = [
    { name: 'k0_source', ready: true, source: { type: 'rtspSource' } },
    { name: 'k0', ready: true, source: { type: 'rtspSession' } },          // cevirici yayini: cihaz oturumu degil
    { name: 'k1', ready: true, source: { type: 'rtspSource' } },
    { name: 'k1_main', ready: true, source: { type: 'rtspSource' } },
    { name: 'k2_main', ready: false, source: { type: 'rtspSource' } },      // acilmamis
    { name: 'k17_source', ready: true, source: { type: 'rtspSource' } },
    { name: 'k99', ready: true, source: { type: 'rtspSource' } },           // cihazi yok
  ];
  const n = deviceSources(items, (k) => (k < 16 ? 'a' : k < 32 ? 'b' : null));
  assert.deepEqual([...n], [['a', 3], ['b', 1]]);

  const c = Object.assign(Object.create(DeviceBase.prototype), { id: 'a', startIndex: 0, channelCount: 16, feeds: new Map(), playCounter: 0, downloadCounter: 0, streamMax: 4, playMax: 4 });
  const g = new DeviceGroup({ setting: {}, devices: [c] });
  assert.equal(g.canPlay(0), true, 'baglanmadan once mediamtx sayisi 0');
  g.relayCount = (id) => n.get(id) ?? 0;
  assert.equal(c.relaySessions(), 3);
  assert.equal(g.canPlay(0), true, '3 + 0 < 4');
  c.playCounter = 1;
  assert.equal(g.canPlay(0), false, 'mediamtx 3 + oynatma 1 = sinir');
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
    assert.deepEqual(await (await fetch(`${u.B}/live/access`)).json(), { canEdit: false, name: null, title: 'Kameralar', access: 'public' });
    assert.match(await (await fetch(`${u.B}/live/`)).text(), /<title>Kameralar<\/title>/, 'baslik sayfa adindan');

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
  const h = (defaultOrder) => Object.assign(Object.create(LiveService.prototype), { y: { defaultOrder: defaultOrder }, cameras });
  assert.deepEqual(h(['k2', 'k9', 'k0']).layoutOf({ layout: null }), { column: 4, paths: ['k2', 'k0'], isDefault: true }, 'listede olmayan atlanir');
  assert.deepEqual(h([]).layoutOf({ layout: null }).paths, ['k0', 'k1', 'k2'], 'bos: ilk kameralar');
  assert.deepEqual(h([]).layoutOf({ layout: { column: 2, paths: [] } }).paths, [], 'kayitli bos duzen varsayilana dusmez');
});

test('WHEP beklemesi mediamtx acilis suresinden uzun, tarayicininki panelinkinden uzun (kanal dusunce cevirici durdurulmaz)', () => {
  const yml = readFileSync(new URL('../docker/mediamtx.yml', import.meta.url), 'utf8');
  const sec = (k) => Number(yml.match(new RegExp(`${k}:\\s*(\\d+)s`))[1]) * 1000;
  assert.ok(WHEP_TIMEOUT > Math.max(sec('runOnDemandStartTimeout'), sec('sourceOnDemandStartTimeout')), 'panel mediamtx acilisini bekler');
  const js = readFileSync(new URL('../resources/views/live/live.js', import.meta.url), 'utf8');
  const browser = Number(js.match(/whep`[^\n]*AbortSignal\.timeout\((\d+)_?(\d*)\)/).slice(1).join(''));
  assert.ok(browser > WHEP_TIMEOUT, 'tarayici panelden once vazgecmez');
});

/** Sahte mediamtx: /v3 yonetim cagrilari bos, WHEP teklifleri kaydedilir ve 201 doner. */
async function fakeMediamtx() {
  const incoming = [];
  const mtx = createServer((req, res) => {
    let g = ''; req.on('data', (b) => { g += b; });
    req.on('end', () => {
      if (req.url.startsWith('/v3/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(req.url.includes('/list') ? '{"items":[]}' : '{}'); }
      incoming.push(req.url); res.writeHead(201, { 'Content-Type': 'application/sdp' }); res.end('v=0 cevap');
    });
  }).listen(0);
  await new Promise((r) => mtx.once('listening', r));
  return { mtx, incoming, address: `http://127.0.0.1:${mtx.address().port}` };
}
const CAMERAS = [{ path: 'k0', name: 'Kamera 1', device: 'A', converted: false }, { path: 'k1', name: 'Kamera 2', device: 'A', converted: false }, { path: 'k2', name: 'Kamera 3', device: 'A', converted: false }];

test('coklu canli sayfa: private sayfa giris + rol ister, kameralari baska sayfanin ucundan cekilemez', async () => {
  const { mtx, incoming, address } = await fakeMediamtx();
  const u = await openApp({ live: { rtcApi: address, rtcWhep: address, frame: '*' } });
  const whep = (slug, path, cookie) => fetch(`${u.B}/${slug}/rtc/${path}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Cam': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: 'v=0 teklif' });
  const get = (path, cookie) => fetch(u.B + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  try {
    await u.services.live.first;
    u.services.live.cameras = CAMERAS;
    await u.login('admin', 'adminparola1');
    // public /live yalniz k0; private /ofis yalniz k1 (camera rolu)
    assert.equal((await u.req('/live/layout', { method: 'PUT', body: { column: 2, paths: ['k0'] } })).status, 200);
    const add = await u.req('/api/live-pages', { method: 'POST', body: { name: 'Ofis', slug: '/Ofis/', access: 'private', roles: ['camera'] } });
    assert.equal(add.status, 200, add.text); assert.equal(add.json.slug, 'ofis'); assert.equal(add.json.cameraCount, 0, 'yeni sayfa bos dogar');
    const id = add.json.id;
    assert.equal((await u.req('/ofis/layout', { method: 'PUT', body: { column: 2, paths: ['k1'] } })).status, 200);

    // kimliksiz: giris formu ayni adreste, veri uclari 401, mediamtx'e istek gitmez
    const page = await get('/ofis/');
    assert.equal(page.status, 200); const html = await page.text();
    assert.match(html, /id="form"/, 'giris formu'); assert.match(html, /href="\/css\/app\.css"/, 'varlik adresleri kokten');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/, 'private sayfa gomulmez');
    for (const p of ['/ofis/cameras.json', '/ofis/layout.json', '/ofis/access', '/ofis/live.js']) assert.equal((await get(p)).status, 401, p);
    incoming.length = 0;
    assert.equal((await whep('ofis', 'k1')).status, 401);
    assert.equal((await whep('live', 'k1')).status, 404, 'private sayfanin kamerasi public sayfanin ucundan cekilemez');
    assert.equal((await whep('live', 'k2')).status, 404, 'public sayfa duzen disi kamerayi vermez');
    assert.deepEqual(incoming, []);
    assert.deepEqual((await (await get('/live/cameras.json')).json()).cameras.map((k) => k.path), ['k0'], 'public sayfa yalniz kendi duzenini listeler');
    assert.equal((await whep('live', 'k0')).status, 201);

    // rol: camera -> gorur; baska rol (live.view'li) -> 403; admin -> gorur (editor: tum kameralar)
    await u.services.members.add('ayse', 'ayseparola12', 'camera');
    await u.login('ayse', 'ayseparola12');
    const ayse = u.cookies.get('ayse');
    const s = await get('/ofis/', ayse);
    assert.equal(s.status, 200); assert.match(await s.text(), /<title>Ofis<\/title>/);
    assert.match(s.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.deepEqual((await (await get('/ofis/cameras.json', ayse)).json()).cameras.map((k) => k.path), ['k1']);
    assert.equal((await whep('ofis', 'k1', ayse)).status, 201);
    assert.equal((await whep('ofis', 'k0', ayse)).status, 404, 'sayfanin duzeninde olmayan kamera');
    assert.equal((await u.req('/ofis/layout', { method: 'PUT', body: { column: 2, paths: ['k0'] }, who: 'ayse' })).status, 403, 'duzen yalniz yonetici');
    const role = await u.req('/api/access/roles', { method: 'POST', body: { id: 'izleyici', name: 'İzleyici', permissions: ['live.view'] } });
    assert.equal(role.status, 200, role.text);
    await u.services.members.add('ali', 'aliparola1234', 'izleyici');
    await u.login('ali', 'aliparola1234');
    const ali = u.cookies.get('ali');
    assert.equal((await get('/ofis/', ali)).status, 403);
    assert.equal((await get('/ofis/cameras.json', ali)).status, 403);
    assert.equal((await whep('ofis', 'k1', ali)).status, 403);
    // REGRESYON (Muhasebe giremiyordu): izinsiz rol sayfaya ACIKCA eklenince yalniz o sayfayi izler, duzeni degistiremez;
    // ana panel (bos ekran) yerine sayfasina yonlenir. Ana paneldeki kameralar ona acilmaz.
    assert.equal((await u.req(`/api/live-pages/${id}`, { method: 'PATCH', body: { roles: ['camera', 'accounting'] } })).status, 200);
    await u.services.members.add('can', 'canparola12345', 'accounting');
    await u.login('can', 'canparola12345');
    const can = u.cookies.get('can');
    assert.deepEqual((await (await get('/ofis/cameras.json', can)).json()).cameras.map((k) => k.path), ['k1']);
    assert.equal((await whep('ofis', 'k1', can)).status, 201);
    assert.equal((await whep('ofis', 'k0', can)).status, 404, 'sayfanin duzeninde olmayan kamera');
    assert.equal((await u.req('/ofis/layout', { method: 'PUT', body: { column: 2, paths: ['k0'] }, who: 'can' })).status, 403, 'duzen yalniz yonetici');
    assert.equal((await u.req('/api/snapshot?path=k1', { who: 'can' })).status, 403, 'ana panel canli izleme kapali');
    const home = await get('/', can);
    assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/ofis/');
    assert.equal((await u.req('/api/live-pages', { who: 'can' })).status, 403, 'liste ana panelin; izinsiz uye ona varmaz');
    assert.equal((await get('/', ayse)).status, 200, 'izni olan uye ana paneli gorur');
    // sayfaya bagli rol silinemez
    const r2 = await u.req('/api/access/roles', { method: 'POST', body: { id: 'gece', name: 'Gece', permissions: ['live.view'] } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await u.req(`/api/live-pages/${id}`, { method: 'PATCH', body: { roles: ['camera', 'gece'] } })).status, 200);
    assert.equal((await u.req('/api/access/roles/gece', { method: 'DELETE' })).status, 409, 'sayfaya bagli rol');
    // rol listesi bosaltilinca live.view olan herkes gorur; live.view'siz rol goremez
    assert.equal((await u.req(`/api/live-pages/${id}`, { method: 'PATCH', body: { roles: [] } })).status, 200);
    assert.equal((await u.req('/api/access/roles/gece', { method: 'DELETE' })).status, 200, 'artik bagli degil');
    assert.equal((await get('/ofis/cameras.json', ali)).status, 200, 'rol listesi bos: live.view yeter');
    await u.req('/api/access/roles', { method: 'POST', body: { id: 'muhasebe2', name: 'Muhasebe 2', permissions: ['recording.list'] } });
    await u.services.members.add('veli', 'veliparola1234', 'muhasebe2');
    await u.login('veli', 'veliparola1234');
    assert.equal((await get('/ofis/cameras.json', u.cookies.get('veli'))).status, 403, 'live.view yok');
    const admin = u.cookies.get('admin');
    assert.equal((await (await get('/ofis/access', admin)).json()).canEdit, true);
    assert.equal((await (await get('/ofis/cameras.json', admin)).json()).cameras.length, 3, 'editor tum kameralari gorur (taslak)');

    // izleyici listesi: yalniz gorebildikleri, ayrintisiz
    const list = await u.req('/api/live-pages', { who: 'ayse' });
    assert.equal(list.status, 200); assert.equal(list.json.manage, false);
    assert.deepEqual(list.json.pages.map((p) => p.slug).sort(), ['live', 'ofis']);
    assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: 'x', slug: 'x' }, who: 'ayse' })).json.requiredPermission, 'livepage.manage');

    // yol degisince eski adres 404, yeni calisir; ilk sayfa silinebilir
    assert.equal((await u.req(`/api/live-pages/${id}`, { method: 'PATCH', body: { slug: 'depo' } })).status, 200);
    assert.equal((await get('/ofis/', admin)).status, 404);
    assert.equal((await get('/depo/cameras.json', admin)).status, 200);
    assert.equal((await u.req('/api/live-pages/live', { method: 'DELETE' })).status, 200);
    for (const p of ['/live/', '/live/cameras.json']) assert.equal((await get(p)).status, 404, p);
    assert.equal((await whep('live', 'k0')).status, 404);
    assert.equal((await get('/depo/layout.json', ayse)).status, 200, 'diger sayfa calismaya devam eder');
    await u.services.auditLog.wait();
    const events = new Set((await u.req('/api/audit-log?size=200')).json.records.map((k) => k.event));
    for (const e of ['livepage-add', 'livepage-edit', 'livepage-delete', 'livepage-layout']) assert.ok(events.has(e), e);
  } finally { await u.close(); mtx.close(); }
});

test('canli sayfa yolu: dogrulama, cakisma ve panel rotalarini golgelememe; kalicilik', async () => {
  const { mtx, address } = await fakeMediamtx();
  const secretKey = randomBytes(32).toString('base64');
  const u = await openApp({ secretKey, live: { rtcApi: address, rtcWhep: address } });
  try {
    await u.login('admin', 'adminparola1');
    for (const slug of ['api', 'css', 'login', 'docs', 'stream', 'a.b', 'a/b', '', '-a', 'ç', 'x'.repeat(65)]) assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: 'X', slug } })).status, 400, slug);
    assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: 'X', slug: 'live' } })).status, 409);
    assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: 'X', slug: 'yeni', access: 'gizli' } })).status, 400);
    assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: 'X', slug: 'yeni', access: 'private', roles: ['yok'] } })).status, 400);
    assert.equal((await u.req('/api/live-pages', { method: 'POST', body: { name: '', slug: 'yeni' } })).status, 400);
    const ok = await u.req('/api/live-pages', { method: 'POST', body: { name: 'Yeni', slug: 'yeni-2' } });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.access, 'public');
    // genel /:live kaliplari baska yollari golgelemez
    assert.equal((await u.req('/api/login')).status, 405);
    assert.equal((await u.req('/api/yok')).status, 404);
    assert.equal((await u.req('/bilinmeyen/')).status, 404);
    assert.equal((await u.req('/css/app.css')).status, 200);
    // kalicilik: yeniden aciliste kayitlar yerinde, silinen ilk sayfa geri gelmez
    assert.equal((await u.req('/api/live-pages/live', { method: 'DELETE' })).status, 200);
    await u.close({ permanent: true });
    const v = await openApp({ database: u.database, secretKey, live: { rtcApi: address, rtcWhep: address } });
    try { assert.deepEqual(v.services.livePages.list().map((p) => p.slug), ['yeni-2']); }
    finally { await v.close(); await u.database.remove(); }
  } finally { mtx.close(); }
});
