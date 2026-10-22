/**
 * Canli MP4 yayini: kameranin kendi videosu (H.264/H.265) ffmpeg ile YENIDEN KODLANMADAN parcali MP4'e sarilir, tum izleyiciler paylasir.
 * MJPEG'e gore tarayiciya giden veri cihazdan gelen kadardir (Hikvision ana akis olcumu: MJPEG 14,4 Mbps, kaynak 1,9 Mbps).
 *
 * Sonradan katilan izleyici: baslangic + son anahtar kareden bu yana biriken parcalar (GOP) verilir; tarayici oradan cozer.
 * Yetisemeyen izleyici (soket dolu) parca atlar ama yalniz bir sonraki anahtar kareye kadar: yarim GOP cozulmez.
 * Sozlesme RtspFeed ile ayni: aboneler, hazir, hata, lastZ, durdur, bitince.
 */
import { spawn } from 'node:child_process';
import { Fmp4Splitter, makeHvc1, codecName } from './fmp4.mjs';

/** ffmpeg cikis secenekleri (kodlayici haric): parca her anahtar karede ve en gec 200 ms'de kapanir (gecikme), ses yok. */
export const MP4_OUTPUT = ['-an', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000', 'pipe:1'];

/**
 * Kaynak kalitede H.264'e cevirme (tarayici H.265 oynatamazsa; Chrome). Cozunurluk ve kare hizi oldugu gibi
 * (goruntu kalitesinden odun verilmez). Bit hizi kaynagin ~1,5-2 kati (H.264 ayni kalite icin daha cok ister).
 * Olcum (Uniview): ana 1080p 25 kare/sn %82 cekirdek 3,09 Mbps; alt 704x576 %18 cekirdek 1,04 Mbps.
 * Anahtar kare saniyede bir: yeni izleyici beklemez, tampon kirpilabilir.
 */
export const CONVERT_BITRATE = { Main: 3000, Extra1: 1000 };
export const convertArgs = (type) => {
  const b = CONVERT_BITRATE[type] ?? CONVERT_BITRATE.Extra1;
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${2 * b}k`, '-force_key_frames', 'expr:gte(t,n_forced*1)', '-bf', '0'];
};

const GOP_LIMIT = 16 * 1024 * 1024;   // anahtar karesiz bu kadar birikirse onbellek bosaltilir (sonraki anahtar kare beklenir)

export class Mp4Feed {
  constructor({ ffmpeg, args, onEnd = () => {}, firstDuration = 15_000, stopDuration = 10_000 }) {
    Object.assign(this, { ffmpeg, args, onEnd, firstDuration, stopDuration });
    this.subscribers = new Set(); this.init = null; this.codec = null; this.gop = []; this.gopByte = 0;
    this.error = null; this.stopped = false; this.lastZ = Date.now(); this.splitter = new Fmp4Splitter();
  }

  start() {
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.firstTime = setTimeout(() => { if (!this.init) { this.error ??= 'Kameradan görüntü gelmedi'; this.stop(); } }, this.firstDuration);
    this.watcher = setInterval(() => { if (this.init && Date.now() - this.lastZ > this.stopDuration) this.stop(); }, 2000);
    this.ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...this.args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', (e) => { this.error = `ffmpeg başlatılamadı: ${e.code ?? e.message}`; this.stop(); });   // dinleyicisiz 'error' tum paneli dusurur
    this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#data(b));
    this.ff.on('close', () => this.stop());
    return this;
  }

  #data(b) {
    let parts;
    try { parts = this.splitter.add(b); } catch { this.error = 'Görüntü çözümlenemedi'; return this.stop(); }
    for (const p of parts) {
      this.lastZ = Date.now();
      if (p.type === 'init') {
        this.init = makeHvc1(p.data); this.codec = codecName(this.init);
        if (!this.codec) { this.error = 'Kameranın video biçimi desteklenmiyor'; return this.stop(); }
        clearTimeout(this.firstTime); this.resolveReady();
      } else this.#part(p.data, p.key);
    }
  }

  #part(data, key) {
    if (key) { this.gop = [data]; this.gopByte = data.length; }
    else if (this.gop.length) { this.gop.push(data); this.gopByte += data.length; if (this.gopByte > GOP_LIMIT) { this.gop = []; this.gopByte = 0; } }
    for (const r of this.subscribers) {
      if (r.waitKey && !key) continue;
      if (r.writableNeedDrain) { r.waitKey = true; continue; }
      r.waitKey = false; r.write(data);
    }
  }

  /** hazir'dan SONRA cagrilir (baslangic hazir olmali). */
  subscriber(res) {
    this.subscribers.add(res);
    clearTimeout(this.idleTimer);
    res.write(this.init);
    if (this.gop.length) res.write(Buffer.concat(this.gop)); else res.waitKey = true;
    res.on('close', () => {
      this.subscribers.delete(res);
      if (!this.subscribers.size) this.idleTimer = setTimeout(() => this.stop(), 4000);
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer); clearTimeout(this.firstTime); clearInterval(this.watcher);
    try { this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.subscribers) { try { r.end(); } catch {} }
    this.subscribers.clear();
    this.resolveReady?.();
    this.onEnd();
  }
}
