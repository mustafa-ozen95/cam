/**
 * Canli MP4 (yeniden kodlamasiz): fMP4 ayirici, kodek adi, hev1 -> hvc1 ve /akis/canli-mp4 (sahte cihaz, ffmpeg deneme goruntusu).
 * Ornekler ffmpeg ile uretilir (kamera goruntusu depoya girmez).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Fmp4Splitter, makeHvc1, codecName, findBox, boxes } from '../src/drivers/fmp4.mjs';
import { CONVERT_BITRATE, MP4_OUTPUT, Mp4Feed, RELAY_FIRST, convertArgs, sharedMp4 } from '../src/drivers/mp4-stream.mjs';
import { DeviceBase } from '../src/drivers/base.mjs';
import { openApp } from './helpers.mjs';

const example = (encoder) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '3', ...encoder, '-g', '10', '-pix_fmt', 'yuv420p', ...MP4_OUTPUT], { maxBuffer: 64e6 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};
/** Akisi rastgele boyda dilimlerle verir (borudan gelen veri kutu sinirina denk gelmez). */
const split = (b) => { const a = new Fmp4Splitter(), output = []; for (let i = 0; i < b.length;) { const n = 1 + Math.floor(Math.random() * 5000); output.push(...a.add(b.subarray(i, i + n))); i += n; } return output; };

test('H.264: baslangic once, parcalar anahtar karede baslar, kodek adi avcC baytlari', () => {
  const p = split(example(['-c:v', 'libx264', '-profile:v', 'main', '-level', '3.0']));
  assert.equal(p[0].type, 'init');
  assert.deepEqual(boxes(p[0].data).map((k) => k.type), ['ftyp', 'moov']);
  assert.equal(codecName(p[0].data), 'avc1.4d401e');
  const part = p.slice(1);
  assert.ok(part.length >= 3 && part.every((x) => x.type === 'chunk'));
  assert.equal(part[0].key, true);
  assert.ok(part.some((x) => !x.key), 'anahtar olmayan parca da var (200 ms bolme)');
  assert.equal(part.filter((x) => x.key).length, 3, '3 sn, 10 kare/sn, -g 10');
  for (const x of part) assert.deepEqual(boxes(x.data).map((k) => k.type), ['moof', 'mdat']);
});

test('H.265: hev1 -> hvc1, kodek adi profil/uyum/seviye', () => {
  const init = split(example(['-c:v', 'libx265', '-x265-params', 'log-level=none']))[0].data;
  const type = () => { const s = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']); return boxes(init, s.inner + 8, s.last)[0].type; };
  assert.equal(type(), 'hev1');
  makeHvc1(init);
  assert.equal(type(), 'hvc1');
  assert.match(codecName(init), /^hvc1\.1\.6\.L\d+(\.[0-9a-f]{2})*$/);
});

test('/stream/canli-mp4: kimliksiz 401; X-Codec; ikinci izleyici baslangic + anahtar kareyle baslar', async () => {
  const u = await openApp();
  try {
    assert.equal((await fetch(`${u.B}/stream/live-mp4?channel=0`)).status, 401);
    await u.login('admin', 'adminparola1');
    const open = async () => {
      const ctrl = new AbortController();
      const r = await fetch(`${u.B}/stream/live-mp4?channel=0&type=Extra1`, { headers: { Cookie: u.cookies.get('admin') }, signal: ctrl.signal });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'video/mp4');
      assert.match(r.headers.get('x-codec'), /^avc1\.[0-9a-f]{6}$/);
      const a = new Fmp4Splitter(), read = r.body.getReader(), p = [];
      while (p.length < 3) { const { value, done } = await read.read(); if (done) break; p.push(...a.add(Buffer.from(value))); }
      ctrl.abort();
      return p;
    };
    const first = await open();
    assert.equal(first[0].type, 'init'); assert.equal(first[1].key, true);
    const second = await open();   // ayni yayin (paylasilan) — sonradan katilan
    assert.equal(second[0].type, 'init'); assert.equal(second[1].key, true, 'yarim GOP verilmez');
    assert.equal((await fetch(`${u.B}/stream/live-mp4?channel=99`, { headers: { Cookie: u.cookies.get('admin') } })).status, 400);
  } finally { await u.close(); }
});

test('ffmpeg baslatilamazsa (ENOENT) MP4 yayini hata ile kapanir, surec dusmez', async () => {
  const { Mp4Feed } = await import('../src/drivers/mp4-stream.mjs');
  let finished = false;
  const y = new Mp4Feed({ ffmpeg: '/yok/ffmpeg', args: [], onEnd: () => { finished = true; } }).start();
  await y.ready;
  assert.match(y.error, /ffmpeg başlatılamadı/); assert.equal(y.init, null); assert.ok(finished && y.stopped);
});

test('ffmpeg: kopya ya da kaynak kalitede H.264 (olcek/kare hizi suzgeci YOK)', () => {
  const feeds = new Map(), label = (cv) => (cv ? 'h264' : 'kopya');
  const copy = sharedMp4(feeds, { ffmpeg: '/yok/ffmpeg', channel: 0, type: 'Main', convert: false, input: () => ['-rtsp_transport', 'tcp', '-i', 'rtsp://x/a'], label });
  assert.deepEqual(copy.args.slice(copy.args.indexOf('-c:v'), copy.args.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  // kopyada da zaman damgasi duzeltilir (cihaz RTP zamanini geri sicratinca medya zamani durmasin)
  assert.match(copy.args[copy.args.indexOf('-bsf:v') + 1], /^setts=ts=.*PREV_OUTPTS.*clip\(PTS-PREV_INPTS/);
  assert.match(copy.args[copy.args.indexOf('-bsf:v') + 1], /^setts=ts=if\(eq\(PREV_OUTPTS\\,NOPTS\)\\,PTS.*eq\(PTS\\,NOPTS\)\+eq\(PREV_INPTS\\,NOPTS\)/, 'damgasiz ilk paket sonraki damgalari bozmaz');
  for (const type of ['Main', 'Extra1']) {
    const a = convertArgs(type);
    assert.equal(a[a.indexOf('-c:v') + 1], 'libx264');
    assert.equal(a[a.indexOf('-b:v') + 1], `${CONVERT_BITRATE[type]}k`);
    assert.ok(!a.includes('-r') && !/scale|fps=/.test(a[a.indexOf('-vf') + 1]), 'cozunurluk ve kare hizi kaynaktaki gibi');
    // zaman damgasi cozucuden sonra verilir (cihaz RTP zamanini geri sicratiyor); giriste wallclock YOK (40c651e)
    assert.match(a[a.indexOf('-vf') + 1], /^setpts=.*PREV_OUTPTS\+if\(isnan\(PTS-PREV_INPTS\).*RTCTIME/, 'kare araligi korunur, gercek saate tutunur');
    assert.ok(!a.includes('-use_wallclock_as_timestamps'));
    assert.equal(a[a.indexOf('-bf') + 1], '0');
    // zaman damgasi sicrayinca kopya kare uretilmez (yayin gercek zamandan hizli akip donuyordu)
    assert.equal(a[a.indexOf('-fps_mode') + 1], 'passthrough');
    assert.match(a[a.indexOf('-force_key_frames') + 1], /prev_forced_t/);
  }
});

test('kanal basina tek kamera baglantisi: H.264 yayini kopyadan cevrilir, kamera ikinci kez acilmaz', () => {
  const feeds = new Map(), urls = [];
  const o = (convert) => ({ ffmpeg: '/yok/ffmpeg', channel: 3, type: 'Extra1', convert, extra: ['-aspect', '16:9'], label: (cv) => (cv ? 'h264' : 'kopya'),
    input: () => { urls.push('rtsp'); return ['-rtsp_transport', 'tcp', '-i', 'rtsp://x/k3']; } });
  const copy = new Mp4Feed({ ffmpeg: '/yok/ffmpeg', args: [] });
  copy.ready = new Promise(() => {});   // kopya hic hazir olmaz: cevrilen yayin ffmpeg baslatmadan bekler
  feeds.set('mp4:3/Extra1', copy);
  const h = sharedMp4(feeds, o(true));
  assert.equal(h.source, copy);
  assert.equal(urls.length, 0, 'cevrilen yayin kameraya baglanmaz');
  assert.ok(!h.args.includes('-i') && !h.args.includes('-rtsp_transport'), 'girisi kopyanin ciktisi (stdin)');
  assert.deepEqual(h.args.slice(h.args.indexOf('-aspect'), h.args.indexOf('-aspect') + 2), ['-aspect', '16:9']);
  assert.equal(sharedMp4(feeds, o(true)), h, 'ikinci izleyici ayni cevrilen yayin');
  assert.equal(sharedMp4(feeds, o(false)), copy, 'kopya istegi kopya yayina');
  copy.codec = 'avc1.4d401f';
  assert.equal(sharedMp4(feeds, o(true)), copy, 'kamera zaten H.264: cevirme yok');
  h.stop();
});

test('kaynak zaten H.264 ise cevrilen yayin ffmpeg acmadan kopyaya yonlendirir', async () => {
  const source = { ready: Promise.resolve(), init: Buffer.alloc(8), codec: 'avc1.4d401f', stopped: false };
  const y = new Mp4Feed({ ffmpeg: '/yok/ffmpeg', args: [], source, log: () => {} }).start();
  await y.ready;
  assert.equal(y.passthrough, source);
  assert.ok(y.stopped && !y.ff, 'ffmpeg baslatilmadi');
});

test('H.265 kopya yayin borudan H.264e cevrilir (kaynak kapaninca cevrilen de kapanir)', async () => {
  // sahte kamera: H.265 kopya yayin (feeds'e onceden konur; sharedMp4 onu kaynak alir)
  const feeds = new Map(), log = () => {};
  const copy = new Mp4Feed({ ffmpeg: 'ffmpeg', log, args: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '20', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-g', '10', '-pix_fmt', 'yuv420p', ...MP4_OUTPUT] });
  feeds.set('mp4:0/Extra1', copy); copy.start();
  await copy.ready;
  assert.match(copy.codec, /^hvc1/);
  const h = sharedMp4(feeds, { ffmpeg: 'ffmpeg', channel: 0, type: 'Extra1', convert: true, input: () => assert.fail('kamera ikinci kez acildi'), label: () => 'h264' });
  h.log.write = log;
  await h.ready;
  assert.match(h.codec, /^avc1/);
  assert.equal(copy.subscribers.size, 1, 'cevirici kopyanin abonesi');
  copy.stop();
  for (let t = 0; !h.stopped && t < 50; t++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(h.stopped, 'kopya bitince cevrilen de kapanir');
});

test('/stream/live-mp4?h264=1 ayri yayin; MJPEG web rotasi yok', async () => {
  const u = await openApp();
  try {
    await u.login('admin', 'adminparola1');
    const h = { Cookie: u.cookies.get('admin') };
    const ctrl = new AbortController();
    const r = await fetch(`${u.B}/stream/live-mp4?channel=1&type=Main&h264=1`, { headers: h, signal: ctrl.signal });
    assert.equal(r.status, 200); assert.match(r.headers.get('x-codec'), /^avc1\./);
    const keys = u.services.devices.group.devices.flatMap((c) => [...c.feeds.keys()]);
    ctrl.abort();
    assert.ok(keys.includes('mp4:1/Main/h264'), keys.join(','));
    assert.equal((await fetch(`${u.B}/stream/live?channel=0&raw=1`, { headers: h })).status, 404);
  } finally { await u.close(); }
});

test('ayni uye hesabiyla baska ekranda 16 akis acikken yeni ekran 429 almaz (uyede akis siniri yok)', async () => {
  const u = await openApp();
  try {
    await u.login('admin', 'adminparola1');
    // Baska ekran: ayni kullanici adiyla 16 farkli canli akis (sahada 16'lik izgara)
    const { permissions } = u.services;
    const other = { identity: 'member:admin', concurrentStreams: null };
    const held = Array.from({ length: 16 }, (_, i) => permissions.openStream(other, `mp4:${i}/Extra1/h264`));
    const ctrl = new AbortController();
    const r = await fetch(`${u.B}/stream/live-mp4?channel=0&type=Extra1`, { headers: { Cookie: u.cookies.get('admin') }, signal: ctrl.signal });
    ctrl.abort();
    held.forEach((f) => f());
    assert.equal(r.status, 200);
  } finally { await u.close(); }
});

test('mediamtx uzerinden (relay): alt akis H.264 panelde cevrilmez, mediamtx cevirisinin kopyasi; ana akis kopyadan borudan cevrilir', () => {
  const label = (cv) => (cv ? 'h264' : 'kopya'), input = () => assert.fail('cihaza baglandi');
  const at = (a, f) => a[a.indexOf(f) + 1];
  const feeds = new Map();
  const relay = { copy: 'rtsp://m:8554/k3_source', h264: 'rtsp://m:8554/k3', stall: () => {} };
  const h = sharedMp4(feeds, { ffmpeg: '/yok/ffmpeg', channel: 3, type: 'Extra1', convert: true, input, label, relay });
  assert.equal(at(h.args, '-i'), relay.h264); assert.equal(at(h.args, '-c:v'), 'copy'); assert.ok(!h.args.includes('libx264'));
  assert.ok(!h.source && h.relayed && h.firstDuration === RELAY_FIRST);
  assert.ok(!feeds.has('mp4:3/Extra1'), 'H.264 istegi kaynak kopyasini acmaz');
  const copy = sharedMp4(feeds, { ffmpeg: '/yok/ffmpeg', channel: 3, type: 'Extra1', convert: false, input, label, relay });
  assert.equal(at(copy.args, '-i'), relay.copy);

  // H.264 kanal: kopya ile cevrilen ayni yol, tek yayin
  const same = { copy: 'rtsp://m:8554/k4', h264: 'rtsp://m:8554/k4', stall: () => {} };
  const a = sharedMp4(feeds, { ffmpeg: '/yok/ffmpeg', channel: 4, type: 'Extra1', convert: true, input, label, relay: same });
  assert.equal(a, feeds.get('mp4:4/Extra1')); assert.equal(at(a.args, '-i'), same.h264);

  // Main: mediamtx cevirmez; kopya kN_main'den, H.264 borudan (3000k)
  const main = { copy: 'rtsp://m:8554/k5_main', h264: null, stall: () => {} };
  const mh = sharedMp4(feeds, { ffmpeg: '/yok/ffmpeg', channel: 5, type: 'Main', convert: true, input, label, relay: main });
  assert.equal(at(mh.source.args, '-i'), main.copy); assert.equal(at(mh.args, '-b:v'), `${CONVERT_BITRATE.Main}k`); assert.ok(!mh.args.includes('-i'));
  for (const y of feeds.values()) y.stop();
});

test('yonlendirilmis yayin kendiliginden kapanirsa mediamtx kaynagi yeniden kurulur; panel kapatirsa kurulmaz; butcede sayilmaz', async () => {
  let stalls = 0;
  // ffmpeg yerine node: '-hide_banner' secenegini tanimaz, hemen kapanir (cihaz/mediamtx yayini kesmis gibi)
  const y = new Mp4Feed({ ffmpeg: process.execPath, args: [], relayed: true, onStall: () => { stalls++; }, log: () => {} }).start();
  await new Promise((r) => { const t = setInterval(() => { if (y.stopped) { clearInterval(t); r(); } }, 20); });
  assert.equal(stalls, 1, 'ffmpeg kendiliginden kapandi');
  const z = new Mp4Feed({ ffmpeg: '/yok/ffmpeg', args: [], relayed: true, onStall: () => { stalls++; }, log: () => {} });
  z.stop(); assert.equal(stalls, 1, 'panelin kapattigi yayin');

  const d = Object.assign(Object.create(DeviceBase.prototype), { feeds: new Map([['a', { relayed: true }], ['b', { relayed: true }], ['c', {}]]), playCounter: 0, downloadCounter: 0, streamMax: 2 });
  assert.equal(d.budgetVar(), true, 'mediamtx yayinlari cihaz baglantisi degil');
  d.feeds.set('d', {}); assert.equal(d.budgetVar(), false);
});
