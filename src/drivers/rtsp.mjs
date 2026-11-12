/**
 * RTSP tabanli NVR (Uniview, Hikvision) ortak kismi: canli yayin (ffmpeg -> MJPEG, kanal/tur basina tek akis, tum izleyiciler paylasir),
 * kayitli oynatma (izleyici basina) ve indirme (cihazdan dogrudan indirenin tarayicisina akar, sunucuya yazilmaz).
 * Alt siniflar yalniz adresleri verir: livePath(kanal, tur), playPath(kanal, bas, bit) ve deviceNow() (cihazin yerel saati, sn).
 */
import { spawn } from 'node:child_process';
import { DeviceBase, localText, localSec } from './base.mjs';
import { MP4_OUTPUT, Mp4Feed, convertArgs } from './mp4-stream.mjs';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/** Izgara akislari icin secilebilen kare hizlari (kare/sn). Arayuzdeki secenekler ve tercih siniri bununla ayni olmali. */
export const OPTIONAL_FPS = [5, 10, 15, 20, 25];
/** Izgarada ana akis kare genislikleri (masaustu 960, dar ekran 640). */
export const GRID_MAIN_WIDTH = [640, 960];

export class RtspDevice extends DeviceBase {
  constructor(o) {
    super(o);
    this.rtspPort = Number(this.setting.rtspPort) || 554;
    this.miniSupport = true;            // 'Mini': dusuk bantli izgara akisi (320 px, 5 kare/sn) - mobil hat icin
  }

  rtspUrl(path) {
    const a = `${encodeURIComponent(this.setting.username)}:${encodeURIComponent(this.setting.password)}`;
    return `rtsp://${a}@${this.setting.host}:${this.rtspPort}/${path}`;
  }

  /**
   * Canli MJPEG. Genislik tur basina sabit (her kanal/tur icin cihaza tek baglanti): Mini 320, Extra1 480, Main 1280.
   * genislik === 0 yalniz Main icin: OLCEKSIZ, kameranin tam cozunurlugu (tam ekran ve goruntu al).
   * fps yalniz izgara akislari (Mini/Extra1) icin; izinli degerler OPTIONAL_FPS, verilmezse Mini 5, Extra1 10. Main kameranin kendi hizindadir.
   * Farkli fps ayri baglantidir: kayit cihazinin es zamanli akis siniri (16) bunu da sayar.
   */
  feed(channel, type, requested, fps) {
    // Ana akis IZGARADA (uye tercihi "ana akış"): kare boyunda (640/960) ve izgara kare hiziyla; odak/tam ekran olcekli (1280) ya da olceksiz (0), kendi hiziyla.
    const gridMain = type === 'Main' && GRID_MAIN_WIDTH.includes(requested) && OPTIONAL_FPS.includes(fps);
    const width = type === 'Mini' ? 320 : type === 'Extra1' ? 480 : gridMain ? requested : requested === 0 ? 0 : 1280;
    const rate = type === 'Main' ? (gridMain ? fps : null) : OPTIONAL_FPS.includes(fps) ? fps : type === 'Mini' ? 5 : 10;
    const key = `${channel}/${type}/${width}/${rate ?? ''}`;
    let y = this.feeds.get(key);
    if (!y) { y = new RtspFeed(this, this.livePath(channel, type), width, () => this.feeds.delete(key), false, rate); this.feeds.set(key, y); y.start(); }
    return y;
  }

  /**
   * Canli MP4: tur 'Main' ya da 'Extra1' (alt akis); kanal/tur basina tek baglanti, izleyiciler paylasir.
   * cevir=false: kameranin videosu oldugu gibi (yeniden kodlamasiz). cevir=true: kaynak kalitede H.264 (tarayici H.265 oynatmiyorsa).
   */
  feedMp4(channel, type, convert = false) {
    const key = `mp4:${channel}/${type}${convert ? '/h264' : ''}`;
    let y = this.feeds.get(key);
    if (!y) {
      y = new Mp4Feed({ ffmpeg: this.ffmpeg, args: mp4Args(this.rtspUrl(this.livePath(channel, type)), type, convert), onEnd: () => this.feeds.delete(key) });
      this.feeds.set(key, y); y.start();
    }
    return y;
  }

  playMjpeg(res, channel, from, to, width) {
    if (!this.canPlay()) { try { res.end(); } catch {} return null; }
    this.playCounter++;
    res.on('close', () => { this.playCounter = Math.max(0, this.playCounter - 1); });
    // Bitis: istenen anin 6 saat sonrasi, cihazin simdisinden ilerisi olamaz
    this.deviceNow().then((now) => {
      const toSec = Math.min(localSec(from) + 6 * 3600, Math.floor(now) - 1);
      const y = new RtspFeed(this, this.playPath(channel, from, localText(toSec)), Math.max(160, Math.min(1920, width || 960)), () => {}, true);
      y.start(); y.subscriber(res);
      res.on('close', () => y.stop());
    }).catch(() => { try { res.end(); } catch {} });
  }

  async pipeDownload(res, channel, record, name, onEnd) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    let byte = 0, finished = false, ff = null, counted = false, lastZ = Date.now(), watcher = null;
    const finish = (ok) => { if (finished) return; finished = true; clearInterval(watcher); if (counted) this.downloadCounter = Math.max(0, this.downloadCounter - 1); try { ff?.kill('SIGKILL'); } catch {} try { res.end(); } catch {} onEnd?.({ ok: ok && byte > 0, byte }); };
    res.on('close', () => finish(false));
    for (let t = 0; !this.canDownload(); t++) { if (finished || t > 900) return finish(false); await new Promise((r) => setTimeout(r, 1000)); }
    if (finished) return;
    counted = true; this.downloadCounter++;
    const duration = Math.max(1, localSec(record.to) - localSec(record.from) + 2);
    ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', this.rtspUrl(this.playPath(channel, record.from, record.to)),
      '-an', '-c:v', 'copy', '-t', String(duration), '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // 'error' dinleyicisi spawn'dan HEMEN sonra: baslatilamazsa (EMFILE/EAGAIN/ENOENT) dinleyicisiz 'error' butun paneli dusurur (stdio de yoktur).
    ff.on('error', () => finish(false));
    ff.stderr.on('data', () => {});
    watcher = setInterval(() => { if (byte > 100_000 && Date.now() - lastZ > 25_000) { clearInterval(watcher); finish(true); } else if (Date.now() - lastZ > 40_000) { clearInterval(watcher); finish(false); } }, 1000);
    ff.stdout.on('data', (b) => { byte += b.length; lastZ = Date.now(); if (!res.write(b)) { ff.stdout.pause(); res.once('drain', () => ff.stdout.resume()); } });
    ff.on('close', (code) => finish(code === 0 || byte > 0));
  }
}

/** Canli MP4 ffmpeg argumanlari (test/mp4.test.mjs): kopya ya da kaynak kalitede H.264. */
export const mp4Args = (url, type, convert) => ['-rtsp_transport', 'tcp', '-i', url, ...(convert ? convertArgs(type) : ['-c:v', 'copy']), ...MP4_OUTPUT];

/** Canli/kayitli MJPEG akisi: aboneler, son, frameCounter, hazir, hata, durdur, firstFrame (sunucu.mjs bu sozlesmeyi kullanir). */
/**
 * ffmpeg argumanlari (test/rtsp-args.test.mjs). Suzgec: kare hizi (yalniz canli izgara) ve olcek;
 * genislik 0 = olceksiz, kameranin tam cozunurlugu. Suzgec yoksa -vf hic yazilmaz.
 */
export function feedArgs(device, { path, width, playback, fps }) {
  const vf = [!playback && fps ? `fps=${fps}` : null, width ? device.scale(width) : null].filter(Boolean);
  return ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', device.rtspUrl(path), '-an',
    ...(vf.length ? ['-vf', vf.join(',')] : []), '-q:v', width && width <= 320 ? '9' : '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
}

export class RtspFeed {
  constructor(device, path, width, onEnd, playback, fps = null) {
    Object.assign(this, { device, path, width, onEnd, playback, fps });
    this.subscribers = new Set(); this.lastZ = Date.now(); this.last = null; this.stopped = false; this.jpegBuffer = Buffer.alloc(0); this.error = null; this.frameCounter = 0;
  }

  start() {
    this.ready = this.#setup().catch((e) => { this.error = e.message; this.stop(); });
    this.watcher = setInterval(() => { if (this.last && Date.now() - this.lastZ > (this.playback ? 20_000 : 10_000)) this.stop(); }, 2000);
  }

  async #setup() {
    const { device } = this;
    this.ff = spawn(device.ffmpeg, feedArgs(device, this), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', (e) => { this.error = `ffmpeg başlatılamadı: ${e.code ?? e.message}`; this.stop(); });   // dinleyicisiz 'error' tum paneli dusurur
    this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#jpeg(b));
    this.ff.on('close', () => this.stop());
    const t0 = Date.now();
    while (!this.last && !this.stopped) {
      if (Date.now() - t0 > 15_000) throw new Error(this.playback ? 'Bu anda kayıt yok' : 'Kameradan görüntü gelmedi');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ham=true: fetch okuyucusu icin yalniz ardisik JPEG baytlari (WebKit fetch'te multipart/x-mixed-replace'i reddeder)
  #part(frame, r) { return r.raw ? [frame] : [`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`, frame, '\r\n']; }

  #jpeg(b) {
    this.jpegBuffer = this.jpegBuffer.length ? Buffer.concat([this.jpegBuffer, b]) : b;
    for (;;) {
      const from = this.jpegBuffer.indexOf(JPEG_START);
      if (from < 0) { this.jpegBuffer = Buffer.alloc(0); return; }
      const last = this.jpegBuffer.indexOf(JPEG_END, from + 2);
      if (last < 0) { this.jpegBuffer = this.jpegBuffer.subarray(from); return; }
      const frame = Buffer.from(this.jpegBuffer.subarray(from, last + 2));
      this.jpegBuffer = this.jpegBuffer.subarray(last + 2);
      this.last = frame; this.lastZ = Date.now(); this.frameCounter++;
      for (const r of this.subscribers) {
        if (r.writableNeedDrain) continue;
        for (const p of this.#part(frame, r)) r.write(p);
      }
    }
  }

  subscriber(res) {
    this.subscribers.add(res);
    clearTimeout(this.idleTimer);
    if (this.last) for (const p of this.#part(this.last, res)) res.write(p);
    res.on('close', () => {
      this.subscribers.delete(res);
      if (!this.subscribers.size) this.idleTimer = setTimeout(() => this.stop(), this.playback ? 300 : 4000);
    });
  }

  async firstFrame() { await this.ready; return this.last; }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer); clearInterval(this.watcher);
    try { this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.subscribers) { try { r.end(); } catch {} }
    this.subscribers.clear();
    this.onEnd();
  }
}
