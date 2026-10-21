/**
 * Canli akis ffmpeg argumanlari: izgara kare hizi secimi ve tam ekran icin olceksiz ana akis.
 * Cihaza baglanmadan, uretilen komut dogrulanir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISTEGE_FPS, RtspCihaz, yayinArgumanlari } from '../src/drivers/rtsp.mjs';

const cihaz = { olcek: (w) => `scale='min(${w},iw)':-2`, rtspUrl: (y) => `rtsp://x/${y}` };
const vf = (a) => { const i = a.indexOf('-vf'); return i < 0 ? null : a[i + 1]; };

test('izgara: secilen kare hizi ve olcek', () => {
  assert.equal(vf(yayinArgumanlari(cihaz, { yol: 'a', genislik: 480, oynatma: false, fps: 20 })), "fps=20,scale='min(480,iw)':-2");
  assert.equal(vf(yayinArgumanlari(cihaz, { yol: 'a', genislik: 320, oynatma: false, fps: 5 })), "fps=5,scale='min(320,iw)':-2");
});

test('ana akis: kare hizi suzgeci yok; genislik 0 ise olcek de yok (-vf yazilmaz)', () => {
  assert.equal(vf(yayinArgumanlari(cihaz, { yol: 'a', genislik: 1280, oynatma: false, fps: null })), "scale='min(1280,iw)':-2");
  const tam = yayinArgumanlari(cihaz, { yol: 'a', genislik: 0, oynatma: false, fps: null });
  assert.equal(vf(tam), null);
  assert.equal(tam[tam.indexOf('-q:v') + 1], '6');
});

test('surucu: fps yalniz izinli degerler, Main icin yok sayilir; farkli fps ayri yayin', () => {
  const c = Object.create(RtspCihaz.prototype);
  c.yayinlar = new Map(); c.canliYol = (k, t) => `${k}/${t}`;
  const yakala = []; const eski = c.constructor;
  // yayin() yeni RtspYayin kurar ve baslatir; baslatmayi engellemek icin yayinlar haritasina onceden sahte konur
  for (const [tur, g, f, anahtar] of [['Extra1', 480, 20, '0/Extra1/480/20'], ['Extra1', 480, 99, '0/Extra1/480/10'], ['Mini', 320, undefined, '0/Mini/320/5'], ['Main', 0, 25, '0/Main/0/'], ['Main', 1920, 25, '0/Main/1280/'], ['Main', 960, 15, '0/Main/960/15'], ['Main', 640, 10, '0/Main/640/10'], ['Main', 960, 99, '0/Main/1280/'], ['Main', 1280, undefined, '0/Main/1280/']]) {
    const sahte = { anahtar }; c.yayinlar.set(anahtar, sahte);
    assert.equal(c.yayin(0, tur, g, f), sahte, `${tur} g=${g} fps=${f} -> ${anahtar}`);
    yakala.push(anahtar);
  }
  assert.ok(eski && ISTEGE_FPS.includes(20) && !ISTEGE_FPS.includes(99));
});
