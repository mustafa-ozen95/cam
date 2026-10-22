/**
 * Canli MP4 (yeniden kodlamasiz): fMP4 ayirici, kodek adi, hev1 -> hvc1 ve /akis/canli-mp4 (sahte cihaz, ffmpeg deneme goruntusu).
 * Ornekler ffmpeg ile uretilir (kamera goruntusu depoya girmez).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Fmp4Splitter, makeHvc1, codecName, findBox, boxes } from '../src/drivers/fmp4.mjs';
import { CONVERT_BITRATE, MP4_OUTPUT } from '../src/drivers/mp4-stream.mjs';
import { mp4Args } from '../src/drivers/rtsp.mjs';
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
  const copy = mp4Args('rtsp://x/a', 'Main', false);
  assert.deepEqual(copy.slice(copy.indexOf('-c:v'), copy.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  for (const type of ['Main', 'Extra1']) {
    const a = mp4Args('rtsp://x/a', type, true);
    assert.equal(a[a.indexOf('-c:v') + 1], 'libx264');
    assert.equal(a[a.indexOf('-b:v') + 1], `${CONVERT_BITRATE[type]}k`);
    assert.ok(!a.includes('-vf') && !a.includes('-r'), 'cozunurluk ve kare hizi kaynaktaki gibi');
    assert.equal(a[a.indexOf('-bf') + 1], '0');
  }
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
