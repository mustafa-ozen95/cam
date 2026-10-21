/**
 * Canli MP4 (yeniden kodlamasiz): fMP4 ayirici, kodek adi, hev1 -> hvc1 ve /akis/canli-mp4 (sahte cihaz, ffmpeg deneme goruntusu).
 * Ornekler ffmpeg ile uretilir (kamera goruntusu depoya girmez).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Fmp4Ayirici, hvc1Yap, kodekAdi, kutuBul, kutular } from '../src/drivers/fmp4.mjs';
import { CEVIR_BIT, MP4_CIKIS } from '../src/drivers/mp4yayin.mjs';
import { mp4Argumanlari } from '../src/drivers/rtsp.mjs';
import { uygulamaAc } from './helpers.mjs';

const ornek = (kodlayici) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '3', ...kodlayici, '-g', '10', '-pix_fmt', 'yuv420p', ...MP4_CIKIS], { maxBuffer: 64e6 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};
/** Akisi rastgele boyda dilimlerle verir (borudan gelen veri kutu sinirina denk gelmez). */
const ayir = (b) => { const a = new Fmp4Ayirici(), cikti = []; for (let i = 0; i < b.length;) { const n = 1 + Math.floor(Math.random() * 5000); cikti.push(...a.ekle(b.subarray(i, i + n))); i += n; } return cikti; };

test('H.264: baslangic once, parcalar anahtar karede baslar, kodek adi avcC baytlari', () => {
  const p = ayir(ornek(['-c:v', 'libx264', '-profile:v', 'main', '-level', '3.0']));
  assert.equal(p[0].tur, 'init');
  assert.deepEqual(kutular(p[0].veri).map((k) => k.tur), ['ftyp', 'moov']);
  assert.equal(kodekAdi(p[0].veri), 'avc1.4d401e');
  const parca = p.slice(1);
  assert.ok(parca.length >= 3 && parca.every((x) => x.tur === 'parca'));
  assert.equal(parca[0].anahtar, true);
  assert.ok(parca.some((x) => !x.anahtar), 'anahtar olmayan parca da var (200 ms bolme)');
  assert.equal(parca.filter((x) => x.anahtar).length, 3, '3 sn, 10 kare/sn, -g 10');
  for (const x of parca) assert.deepEqual(kutular(x.veri).map((k) => k.tur), ['moof', 'mdat']);
});

test('H.265: hev1 -> hvc1, kodek adi profil/uyum/seviye', () => {
  const init = ayir(ornek(['-c:v', 'libx265', '-x265-params', 'log-level=none']))[0].veri;
  const tur = () => { const s = kutuBul(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']); return kutular(init, s.ic + 8, s.son)[0].tur; };
  assert.equal(tur(), 'hev1');
  hvc1Yap(init);
  assert.equal(tur(), 'hvc1');
  assert.match(kodekAdi(init), /^hvc1\.1\.6\.L\d+(\.[0-9a-f]{2})*$/);
});

test('/akis/canli-mp4: kimliksiz 401; X-Kodek; ikinci izleyici baslangic + anahtar kareyle baslar', async () => {
  const u = await uygulamaAc();
  try {
    assert.equal((await fetch(`${u.B}/akis/canli-mp4?kanal=0`)).status, 401);
    await u.giris('admin', 'adminparola1');
    const ac = async () => {
      const ctrl = new AbortController();
      const r = await fetch(`${u.B}/akis/canli-mp4?kanal=0&tur=Extra1`, { headers: { Cookie: u.cerezler.get('admin') }, signal: ctrl.signal });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'video/mp4');
      assert.match(r.headers.get('x-kodek'), /^avc1\.[0-9a-f]{6}$/);
      const a = new Fmp4Ayirici(), oku = r.body.getReader(), p = [];
      while (p.length < 3) { const { value, done } = await oku.read(); if (done) break; p.push(...a.ekle(Buffer.from(value))); }
      ctrl.abort();
      return p;
    };
    const ilk = await ac();
    assert.equal(ilk[0].tur, 'init'); assert.equal(ilk[1].anahtar, true);
    const ikinci = await ac();   // ayni yayin (paylasilan) — sonradan katilan
    assert.equal(ikinci[0].tur, 'init'); assert.equal(ikinci[1].anahtar, true, 'yarim GOP verilmez');
    assert.equal((await fetch(`${u.B}/akis/canli-mp4?kanal=99`, { headers: { Cookie: u.cerezler.get('admin') } })).status, 400);
  } finally { await u.kapat(); }
});

test('ffmpeg baslatilamazsa (ENOENT) MP4 yayini hata ile kapanir, surec dusmez', async () => {
  const { Mp4Yayin } = await import('../src/drivers/mp4yayin.mjs');
  let bitti = false;
  const y = new Mp4Yayin({ ffmpeg: '/yok/ffmpeg', argumanlar: [], bitince: () => { bitti = true; } }).baslat();
  await y.hazir;
  assert.match(y.hata, /ffmpeg başlatılamadı/); assert.equal(y.init, null); assert.ok(bitti && y.durduruldu);
});

test('ffmpeg: kopya ya da kaynak kalitede H.264 (olcek/kare hizi suzgeci YOK)', () => {
  const kopya = mp4Argumanlari('rtsp://x/a', 'Main', false);
  assert.deepEqual(kopya.slice(kopya.indexOf('-c:v'), kopya.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  for (const tur of ['Main', 'Extra1']) {
    const a = mp4Argumanlari('rtsp://x/a', tur, true);
    assert.equal(a[a.indexOf('-c:v') + 1], 'libx264');
    assert.equal(a[a.indexOf('-b:v') + 1], `${CEVIR_BIT[tur]}k`);
    assert.ok(!a.includes('-vf') && !a.includes('-r'), 'cozunurluk ve kare hizi kaynaktaki gibi');
    assert.equal(a[a.indexOf('-bf') + 1], '0');
  }
});

test('/akis/canli-mp4?h264=1 ayri yayin; MJPEG web rotasi yok', async () => {
  const u = await uygulamaAc();
  try {
    await u.giris('admin', 'adminparola1');
    const h = { Cookie: u.cerezler.get('admin') };
    const ctrl = new AbortController();
    const r = await fetch(`${u.B}/akis/canli-mp4?kanal=1&tur=Main&h264=1`, { headers: h, signal: ctrl.signal });
    assert.equal(r.status, 200); assert.match(r.headers.get('x-kodek'), /^avc1\./);
    const anahtarlar = u.hizmetler.cihazlar.grup.cihazlar.flatMap((c) => [...c.yayinlar.keys()]);
    ctrl.abort();
    assert.ok(anahtarlar.includes('mp4:1/Main/h264'), anahtarlar.join(','));
    assert.equal((await fetch(`${u.B}/akis/canli?kanal=0&ham=1`, { headers: h })).status, 404);
  } finally { await u.kapat(); }
});
