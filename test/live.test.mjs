/**
 * /live: uyeliksiz izleme, yalniz admin duzen kaydeder, gomme yalniz /live'da serbest; mediamtx yollari (H.265 -> kaynak kalitede H.264).
 * mediamtx yerine kucuk bir sahte API (yol listesi bos, yazmalar kabul).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LIVE_CEVIR, liveYollari } from '../src/services/live.mjs';
import { uygulamaAc } from './helpers.mjs';

test('mediamtx yollari: H.264 dogrudan, H.265 kaynak + izlenince calisan cevirici (olcek/kare hizi suzgeci yok)', () => {
  const y = liveYollari([{ k: 0, url: 'rtsp://a/0' }, { k: 32, url: 'rtsp://b/32' }, { k: 5, url: 'rtsp://a/5' }], new Map([[0, 'hevc'], [32, 'h264']]));
  assert.deepEqual(Object.keys(y).sort(), ['k0', 'k0_kaynak', 'k32']);
  assert.deepEqual(y.k32, { source: 'rtsp://b/32', rtspTransport: 'tcp', sourceOnDemand: true });
  assert.equal(y.k0_kaynak.source, 'rtsp://a/0');
  assert.equal(y.k0.source, 'publisher');
  assert.ok(y.k0.runOnDemand.includes(LIVE_CEVIR) && y.k0.runOnDemand.includes('rtsp://127.0.0.1:8554/k0_kaynak') && !y.k0.runOnDemand.includes('-vf'));
  assert.ok(!y.k0.runOnDemand.includes('rtsp://a/0'), 'cihaz adresi (parola) cevirici komutunda yok');
});

test('/live kapali (KAMERA_RTC_API bos): 404', async () => {
  const u = await uygulamaAc();
  try { for (const yol of ['/live/', '/live/kameralar.json', '/live/live.js']) assert.equal((await fetch(u.B + yol)).status, 404, yol); }
  finally { await u.kapat(); }
});

test('/live acik: izleme kimliksiz, duzen yalniz admin (CSRF), gomme yalniz /live', async () => {
  const mtx = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.url.includes('/list') ? '{"items":[]}' : '{}'); }).listen(0);
  await new Promise((r) => mtx.once('listening', r));
  const u = await uygulamaAc({ live: { rtcApi: `http://127.0.0.1:${mtx.address().port}`, cerceve: '*' } });
  try {
    await u.hizmetler.live.ilk;
    u.hizmetler.live.kameralar = [{ yol: 'k0', ad: 'Kamera 1', cihaz: 'A', cevrilir: false }, { yol: 'k1', ad: 'Kamera 2', cihaz: 'A', cevrilir: true }];
    const y = await fetch(`${u.B}/live`, { redirect: 'manual' });
    assert.equal(y.status, 301); assert.equal(y.headers.get('location'), '/live/');
    const s = await fetch(`${u.B}/live/`);
    assert.equal(s.status, 200); assert.match(await s.text(), /<video|id="izgara"/);
    assert.match(s.headers.get('content-security-policy'), /frame-ancestors \*/);
    assert.equal(s.headers.get('x-frame-options'), null);
    const panel = await fetch(`${u.B}/`);
    assert.match(panel.headers.get('content-security-policy'), /frame-ancestors 'self'/, 'panelin geri kalani gomulemez');
    assert.equal((await fetch(`${u.B}/live/live.js`)).status, 200);
    assert.equal((await fetch(`${u.B}/live/..%2Findex.html`)).status, 404);
    const k = await (await fetch(`${u.B}/live/kameralar.json`)).json();
    assert.deepEqual(k.kameralar.map((x) => x.yol), ['k0', 'k1']); assert.ok(!JSON.stringify(k).includes('rtsp'));
    assert.deepEqual(await (await fetch(`${u.B}/live/yetki`)).json(), { duzenleyebilir: false, ad: null });

    const govde = JSON.stringify({ sutun: 3, yollar: ['k1', 'k0'] });
    assert.equal((await fetch(`${u.B}/live/duzen`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Kamera': '1' }, body: govde })).status, 401);
    await u.giris('admin', 'adminparola1');
    const cerez = u.cerezler.get('admin');
    assert.equal((await (await fetch(`${u.B}/live/yetki`, { headers: { Cookie: cerez } })).json()).duzenleyebilir, true);
    assert.equal((await fetch(`${u.B}/live/duzen`, { method: 'PUT', headers: { Cookie: cerez, 'Content-Type': 'application/json' }, body: govde })).status, 403, 'CSRF basligi yok');
    assert.equal((await u.istek('/live/duzen', { yontem: 'PUT', govde: { sutun: 3, yollar: ['k9'] } })).durum, 400, 'bilinmeyen kamera');
    const r = await u.istek('/live/duzen', { yontem: 'PUT', govde: { sutun: 3, yollar: ['k1', 'k0'] } });
    assert.equal(r.durum, 200); assert.equal(r.json.kaydeden, 'admin');
    assert.deepEqual((await (await fetch(`${u.B}/live/duzen.json`)).json()).yollar, ['k1', 'k0']);

    u.hizmetler.uyeler.ekle('ayse', 'ayseparola12', 'kamera');
    await u.giris('ayse', 'ayseparola12');
    assert.equal((await u.istek('/live/duzen', { yontem: 'PUT', govde: { sutun: 2, yollar: ['k0'] }, kim: 'ayse' })).durum, 403, 'admin olmayan');
    assert.equal((await u.istek('/live/yetki', { kim: 'ayse' })).json.duzenleyebilir, false);
  } finally { await u.kapat(); mtx.close(); }
});

test('/live izleme baglantisi (WHEP): panel SDP teklifini mediamtx\'e gecirir; yalniz listelenen yollar, kimliksiz', async () => {
  const gelen = [];
  const mtx = createServer((req, res) => {
    let g = ''; req.on('data', (b) => { g += b; });
    req.on('end', () => {
      if (req.url.startsWith('/v3/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(req.url.includes('/list') ? '{"items":[]}' : '{}'); }
      gelen.push({ yontem: req.method, yol: req.url, tur: req.headers['content-type'], govde: g });
      if (req.url === '/k1/whep') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no stream is available on path'); }
      res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/k0/whep/oturum' }); res.end('v=0 cevap');
    });
  }).listen(0);
  await new Promise((r) => mtx.once('listening', r));
  const adres = `http://127.0.0.1:${mtx.address().port}`;
  const u = await uygulamaAc({ live: { rtcApi: adres, rtcWhep: adres, cerceve: '*' } });
  const whep = (yol, govde = 'v=0 teklif', tur = 'application/sdp', ek = { 'X-Kamera': '1' }) => fetch(`${u.B}/live/rtc/${yol}/whep`, { method: 'POST', headers: { 'Content-Type': tur, ...ek }, body: govde });
  try {
    await u.hizmetler.live.ilk;
    u.hizmetler.live.kameralar = [{ yol: 'k0', ad: 'Kamera 1', cihaz: 'A', cevrilir: false }, { yol: 'k1', ad: 'Kamera 2', cihaz: 'A', cevrilir: true }];
    const r = await whep('k0');
    assert.equal(r.status, 201); assert.equal(r.headers.get('content-type'), 'application/sdp'); assert.equal(await r.text(), 'v=0 cevap');
    assert.deepEqual(gelen, [{ yontem: 'POST', yol: '/k0/whep', tur: 'application/sdp', govde: 'v=0 teklif' }]);
    assert.equal((await whep('k1')).status, 404, 'mediamtx\'in hatasi aynen doner');
    gelen.length = 0;
    for (const yol of ['k0_kaynak', 'k9', '..%2Fv3%2Fconfig%2Fglobal%2Fget']) assert.equal((await whep(yol)).status, 404, yol);
    assert.equal((await whep('k0', 'v=0 teklif', 'application/sdp', {})).status, 403, 'CSRF basligi yok');
    assert.equal((await whep('k0', '{}', 'application/json')).status, 415);
    assert.equal((await whep('k0', 'x'.repeat(70_000))).status, 413);
    assert.deepEqual(gelen, [], 'listede olmayan yol ve gecersiz istek mediamtx\'e gitmez');
    mtx.close(); mtx.closeAllConnections?.();
    assert.equal((await whep('k0')).status, 502, 'mediamtx kapali');
  } finally { await u.kapat(); mtx.close(); }
});

test('/live izleme adresi verilmezse yonetim adresinin konagi, mediamtx\'in 8889\'u', async () => {
  const eski = { ...process.env };
  try {
    process.env.KAMERA_RTC_API = 'http://dc-kamera-rtc:9997/';
    delete process.env.KAMERA_RTC_WHEP;
    const { yapilandirma } = await import(`../config/app.mjs?t=${Date.now()}`);
    assert.equal(yapilandirma.live.rtcWhep, 'http://dc-kamera-rtc:8889');
    process.env.KAMERA_RTC_WHEP = 'http://baska:1234/';
    assert.equal((await import(`../config/app.mjs?t=${Date.now() + 1}`)).yapilandirma.live.rtcWhep, 'http://baska:1234');
  } finally { process.env = eski; }
});

test('/live varsayilan duzen: KAMERA_LIVE_VARSAYILAN sirasi (1\'den kanal no), bossa ilk kameralar', async () => {
  const eski = { ...process.env };
  try {
    process.env.KAMERA_LIVE_VARSAYILAN = '3, 1,x,0,2';
    const { yapilandirma } = await import(`../config/app.mjs?t=${Date.now() + 2}`);
    assert.deepEqual(yapilandirma.live.varsayilan, ['k2', 'k0', 'k1']);
    delete process.env.KAMERA_LIVE_VARSAYILAN;
    assert.deepEqual((await import(`../config/app.mjs?t=${Date.now() + 3}`)).yapilandirma.live.varsayilan, []);
  } finally { process.env = eski; }
  const { LiveHizmeti } = await import('../src/services/live.mjs');
  const kameralar = [{ yol: 'k0' }, { yol: 'k1' }, { yol: 'k2' }];
  const h = (varsayilan) => Object.assign(Object.create(LiveHizmeti.prototype), { y: { varsayilan }, kameralar, DOSYA: '/yok/live-duzen.json' });
  assert.deepEqual(h(['k2', 'k9', 'k0']).duzen(), { sutun: 4, yollar: ['k2', 'k0'], varsayilan: true }, 'listede olmayan atlanir');
  assert.deepEqual(h([]).duzen().yollar, ['k0', 'k1', 'k2'], 'bos: ilk kameralar');
});
