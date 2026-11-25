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

test('canli MP4: kopya ve cevrilen yayin ayni kamera baglantisini paylasir', () => {
  const copy = { stopped: false, codec: 'hvc1.1.6.L90', ready: new Promise(() => {}) };
  const c = Object.assign(Object.create(RtspDevice.prototype), { feeds: new Map([['mp4:3/Extra1', copy]]), setting: { host: 'x' }, rtspUrl: () => assert.fail('kamera ikinci kez acildi'), livePath: () => '' });
  const h = c.feedMp4(3, 'Extra1', true);
  assert.equal(h.source, copy, 'cevrilen yayin kopyadan okur');
  assert.equal(c.feedMp4(3, 'Extra1'), copy, 'kopya istegi kopyaya');
  assert.equal(c.feedMp4(3, 'Extra1', true), h);
  h.stop();
});

test('mediamtx uzerinden (relay): canli MJPEG cihaza baglanmaz, tum genislikler ayni yolu okur; grup global kanali sorar', async () => {
  const relay = { copy: 'rtsp://cam-rtc:8554/k7_main', h264: null, stall: () => {} };
  const noDevice = { ...device, rtspUrl: () => assert.fail('cihaza baglandi') };
  for (const width of [0, 640, 1280]) { const a = feedArgs(noDevice, { path: 'a', width, playback: false, fps: null, relay }); assert.equal(a[a.indexOf('-i') + 1], relay.copy); }
  assert.equal(feedArgs(device, { path: 'p', width: 960, playback: true }).includes('rtsp://x/p'), true, 'kayitli oynatma cihazdan');

  const { DeviceGroup } = await import('../src/drivers/group.mjs');
  const asked = [], got = [];
  const c = { id: 2, startIndex: 16, channelCount: 16, miniSupport: false, rtspUrl: () => '', feed: (...a) => { got.push(a); return {}; }, feedMp4: (...a) => { got.push(a); return {}; } };
  const g = new DeviceGroup({ setting: {}, devices: [c] });
  g.relay = (k, t) => { asked.push([k, t]); return { copy: `k${k}`, h264: null, stall: () => {} }; };
  g.feed(19, 'Mini', 320, 5); g.feedMp4(20, 'Main', true);
  assert.deepEqual(asked, [[19, 'Extra1'], [20, 'Main']], 'yol adi global kanal; Mini alt akis yolunu okur');
  assert.equal(got[0][0], 3); assert.equal(got[0][4].copy, 'k19');
  assert.equal(got[1][0], 4); assert.equal(got[1][4].copy, 'k20');
  const dvr = new DeviceGroup({ setting: {}, devices: [{ id: 1, startIndex: 0, channelCount: 4, feed: (...a) => a }] });
  dvr.relay = () => assert.fail('RTSP siz surucu (Xiongmai DVR-IP) icin sorulmaz');
  assert.equal(dvr.feed(0, 'Extra1', 480)[4], null);
});
