/**
 * /live: uyeliksiz izleme, yalniz admin duzen kaydeder, gomme yalniz /live'da serbest; goruntu panelin canli MP4 akisi
 * (sahte cihaz, ffmpeg deneme goruntusu).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fmp4Splitter } from '../src/drivers/fmp4.mjs';
import { openApp } from './helpers.mjs';

test('/live kapali (CAM_LIVE=0): 404', async () => {
  const u = await openApp({ live: { enabled: false } });
  try { for (const path of ['/live/', '/live/cameras.json', '/live/live.js', '/live/stream/k0']) assert.equal((await fetch(u.B + path)).status, 404, path); }
  finally { await u.close(); }
});

test('/live acik: izleme kimliksiz, duzen yalniz admin (CSRF), gomme yalniz /live', async () => {
  const u = await openApp({ live: { frame: '*' } });
  try {
    await u.services.live.first;
    u.services.live.cameras = [{ path: 'k0', name: 'Kamera 1', device: 'A' }, { path: 'k1', name: 'Kamera 2', device: 'A' }];
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
  } finally { await u.close(); }
});

test('/live goruntu: panelin canli MP4 akisi, kimliksiz; yalniz listelenen kameralar', async () => {
  const u = await openApp();
  try {
    await u.services.live.first;
    assert.ok(u.services.live.cameras.some((k) => k.path === 'k0'), 'sahte cihazin kanallari listede');
    assert.ok(!JSON.stringify(u.services.live.cameras).includes('rtsp'), 'adres yok');
    const ctrl = new AbortController();
    const r = await fetch(`${u.B}/live/stream/k0`, { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.match(r.headers.get('x-codec'), /^avc1\.[0-9a-f]{6}$/);
    const a = new Fmp4Splitter(), read = r.body.getReader(), p = [];
    while (p.length < 2) { const { value, done } = await read.read(); if (done) break; p.push(...a.add(Buffer.from(value))); }
    ctrl.abort();
    assert.equal(p[0].type, 'init'); assert.equal(p[1].key, true);
    for (const path of ['k99', 'x', '..%2Fstream%2Flive-mp4']) assert.equal((await fetch(`${u.B}/live/stream/${path}`)).status, 404, path);
  } finally { await u.close(); }
});

test('/live varsayilan duzen: CAM_LIVE_DEFAULT sirasi (1\'den kanal no), bossa ilk kameralar', async () => {
  const old = { ...process.env };
  try {
    process.env.CAM_LIVE = '0';
    process.env.CAM_LIVE_DEFAULT = '3, 1,x,0,2';
    const { config } = await import(`../config/app.mjs?t=${Date.now() + 2}`);
    assert.deepEqual(config.live.defaultOrder, ['k2', 'k0', 'k1']);
    assert.equal(config.live.enabled, false, 'CAM_LIVE=0 kapatir');
    delete process.env.CAM_LIVE_DEFAULT; delete process.env.CAM_LIVE;
    const k = (await import(`../config/app.mjs?t=${Date.now() + 3}`)).config.live;
    assert.deepEqual(k.defaultOrder, []); assert.equal(k.enabled, true, 'varsayilan acik');
  } finally { process.env = old; }
  const { LiveService } = await import('../src/services/live.mjs');
  const cameras = [{ path: 'k0' }, { path: 'k1' }, { path: 'k2' }];
  const h = (defaultOrder) => Object.assign(Object.create(LiveService.prototype), { y: { defaultOrder: defaultOrder }, cameras, savedLayout: null });
  assert.deepEqual(h(['k2', 'k9', 'k0']).layout(), { column: 4, paths: ['k2', 'k0'], isDefault: true }, 'listede olmayan atlanir');
  assert.deepEqual(h([]).layout().paths, ['k0', 'k1', 'k2'], 'bos: ilk kameralar');
});
