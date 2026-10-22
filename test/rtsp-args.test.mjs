/**
 * Canli akis ffmpeg argumanlari: izgara kare hizi secimi ve tam ekran icin olceksiz ana akis.
 * Cihaza baglanmadan, uretilen komut dogrulanir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONAL_FPS, RtspDevice, feedArgs } from '../src/drivers/rtsp.mjs';

const device = { scale: (w) => `scale='min(${w},iw)':-2`, rtspUrl: (y) => `rtsp://x/${y}` };
const vf = (a) => { const i = a.indexOf('-vf'); return i < 0 ? null : a[i + 1]; };

test('izgara: secilen kare hizi ve olcek', () => {
  assert.equal(vf(feedArgs(device, { path: 'a', width: 480, playback: false, fps: 20 })), "fps=20,scale='min(480,iw)':-2");
  assert.equal(vf(feedArgs(device, { path: 'a', width: 320, playback: false, fps: 5 })), "fps=5,scale='min(320,iw)':-2");
});

test('ana akis: kare hizi suzgeci yok; genislik 0 ise olcek de yok (-vf yazilmaz)', () => {
  assert.equal(vf(feedArgs(device, { path: 'a', width: 1280, playback: false, fps: null })), "scale='min(1280,iw)':-2");
  const full = feedArgs(device, { path: 'a', width: 0, playback: false, fps: null });
  assert.equal(vf(full), null);
  assert.equal(full[full.indexOf('-q:v') + 1], '6');
});

test('surucu: fps yalniz izinli degerler, Main icin yok sayilir; farkli fps ayri yayin', () => {
  const c = Object.create(RtspDevice.prototype);
  c.feeds = new Map(); c.livePath = (k, t) => `${k}/${t}`;
  const capture = []; const old = c.constructor;
  // yayin() yeni RtspFeed kurar ve baslatir; baslatmayi engellemek icin yayinlar haritasina onceden sahte konur
  for (const [type, g, f, key] of [['Extra1', 480, 20, '0/Extra1/480/20'], ['Extra1', 480, 99, '0/Extra1/480/10'], ['Mini', 320, undefined, '0/Mini/320/5'], ['Main', 0, 25, '0/Main/0/'], ['Main', 1920, 25, '0/Main/1280/'], ['Main', 960, 15, '0/Main/960/15'], ['Main', 640, 10, '0/Main/640/10'], ['Main', 960, 99, '0/Main/1280/'], ['Main', 1280, undefined, '0/Main/1280/']]) {
    const mock = { key }; c.feeds.set(key, mock);
    assert.equal(c.feed(0, type, g, f), mock, `${type} g=${g} fps=${f} -> ${key}`);
    capture.push(key);
  }
  assert.ok(old && OPTIONAL_FPS.includes(20) && !OPTIONAL_FPS.includes(99));
});
