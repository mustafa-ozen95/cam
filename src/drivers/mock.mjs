/**
 * SAHTE cihaz (yalniz testler): CAM_TEST=1 iken kullanilabilir. Gercek cihaza baglanmadan canli akis, kayit listesi,
 * oynatma ve indirme taklidi yapar; yetkilendirme/API entegrasyon testleri bununla kosar.
 */
import { DeviceBase } from './base.mjs';
import { MP4_OUTPUT, Mp4Feed } from './mp4-stream.mjs';

// SOI + APP0 + EOI: bayt duzeyinde gecerli en kucuk "JPEG" (sunucu kareyi cozmez, yalniz tasir)
export const MOCK_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

class MockFeed {
  constructor(onEnd, lifetimeMs = 0) {
    this.subscribers = new Set(); this.last = MOCK_JPEG; this.frameCounter = 0; this.stopped = false; this.error = null; this.ready = Promise.resolve(); this.onEnd = onEnd;
    this.time = setInterval(() => {
      this.frameCounter++;
      for (const r of this.subscribers) { if (r.writableNeedDrain) continue; r.write(r.raw ? MOCK_JPEG : `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${MOCK_JPEG.length}\r\n\r\n`); if (!r.raw) { r.write(MOCK_JPEG); r.write('\r\n'); } }
    }, 50);
    if (lifetimeMs) this.lifetime = setTimeout(() => this.stop(), lifetimeMs);
  }
  subscriber(res) { this.subscribers.add(res); res.on('close', () => { this.subscribers.delete(res); if (!this.subscribers.size) this.idleTimer = setTimeout(() => this.stop(), 200); }); }
  async firstFrame() { return this.last; }
  stop() {
    if (this.stopped) return; this.stopped = true;
    clearInterval(this.time); clearTimeout(this.lifetime); clearTimeout(this.idleTimer);
    for (const r of this.subscribers) { try { r.end(); } catch {} } this.subscribers.clear(); this.onEnd?.();
  }
}

export class Mock extends DeviceBase {
  constructor(o) {
    super(o);
    this.channelCount = Number(this.setting.channelCount ?? 4); this.label = this.setting.label ?? 'T';
  }
  async info() {
    const n = this.channelCount;
    return {
      channelEmpty: new Array(n).fill(false), serverClock: DeviceBase.localTime(),
      host: this.setting.host, model: 'MOCK-1', version: '1.0', serialNo: `S-${this.setting.host}`, build: '2026-01-01',
      uptimeSec: 1, clock: DeviceBase.localTime(), channel: n,
      channelNames: Array.from({ length: n }, (_, i) => `Kamera ${i + 1}`), channelCodes: Array.from({ length: n }, (_, i) => `${this.label}${i + 1}`), channelCamera: new Array(n).fill('mock'),
      diskMB: { total: 1000, empty: 500 }, disks: [{ name: 'Disk 1', manufacturer: 'MOCK', totalMB: 1000, freeMB: 500, temperature: 30, status: 'good', statusText: 'Normal', recordStart: null, recordEnd: null, existing: true }], recordDayEstimated: null,
    };
  }
  async records(channel, from) {
    const day = from.slice(0, 10);
    return [0, 1, 2].map((i) => ({ name: `/sahte/c${channel}/${day}-${i}.h264`, from: `${day} 10:${i}0:00`, to: `${day} 10:${i}9:59`, size: 1000 + i, type: 'R' }));
  }
  feed(channel, type) {
    const key = `${channel}/${type}`;
    let y = this.feeds.get(key);
    if (!y) { y = new MockFeed(() => this.feeds.delete(key)); this.feeds.set(key, y); }
    return y;
  }
  /** Canli MP4: ffmpeg'in deneme goruntusu H.264'e kodlanir (gercek fMP4; tarayici sinamasi oynatabilsin). cevir: ayri yayin (RtspDevice gibi). */
  feedMp4(channel, type, convert = false) {
    const key = `mp4:${channel}/${type}${convert ? '/h264' : ''}`;
    let y = this.feeds.get(key);
    if (!y) {
      const input = ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '10', '-pix_fmt', 'yuv420p'];
      y = new Mp4Feed({ ffmpeg: this.ffmpeg, args: [...input, ...MP4_OUTPUT], onEnd: () => this.feeds.delete(key) });
      this.feeds.set(key, y); y.start();
    }
    return y;
  }
  playMjpeg(res) {
    if (!this.canPlay()) { try { res.end(); } catch {} return null; }
    this.playCounter++; res.on('close', () => { this.playCounter = Math.max(0, this.playCounter - 1); });
    const y = new MockFeed(() => {}, 600); y.subscriber(res); return y;
  }
  async pipeDownload(res, channel, record, name, onEnd) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name}"` });
    res.end(Buffer.alloc(1000, 1)); onEnd?.({ ok: true, byte: 1000 });
  }
  async syncClock() { const t = DeviceBase.localTime(); return { before: t, after: t, server: t }; }
}
