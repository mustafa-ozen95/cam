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
import { FeedLog } from './feed-log.mjs';

/** ffmpeg cikis secenekleri (kodlayici haric): parca her anahtar karede ve en gec 200 ms'de kapanir (gecikme), ses yok. */
export const MP4_OUTPUT = ['-an', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000', 'pipe:1'];

/**
 * Kaynak kalitede H.264'e cevirme (tarayici H.265 oynatamazsa; Chrome). Cozunurluk ve kare hizi oldugu gibi
 * (goruntu kalitesinden odun verilmez). Bit hizi kaynagin ~1,5-2 kati (H.264 ayni kalite icin daha cok ister).
 * Olcum (Uniview): ana 1080p 25 kare/sn %82 cekirdek 3,09 Mbps; alt 704x576 %18 cekirdek 1,04 Mbps.
 * Anahtar kare saniyede bir: yeni izleyici beklemez, tampon kirpilabilir.
 *
 * Kare hizi kaynaktaki gibi GECIRILIR (-fps_mode passthrough): mp4 cikisinda ffmpeg'in varsayilani sabit kare hizidir;
 * cihazin zaman damgasi ileri sicrayinca (RTP kopmasi, "bad cseq") aradaki boslugu KOPYA KARELERLE doldurur. Olculen:
 * 25 kare/sn kaynak 150-220 kare/sn kodlandi (cekirdek dolu), yayin gercek zamandan 6-9 kat hizli aktigi icin oynatici
 * surekli canli uca atladi ve goruntu dondu; akis paylasildigindan sayfayi yenilemek de duzeltmedi.
 * Anahtar kare de onceki zorlanmis kareye gore sayilir: n_forced'a gore sayilsaydi sicramadan sonra her kare anahtar olurdu.
 *
 * Zaman damgasi COZUCUDEN CIKIS ANI (setpts RTCTIME), her kare oncekinden en az 1 ms sonra: kayit cihazi alt akista RTP
 * zamanini geri de sicratiyor; ffmpeg sonraki her kareye "oncekinden 1 tik sonra" diyor, anahtar kare zorlanmiyor ve
 * goruntu 250 karelik (10 sn) yiginlar halinde gelip donuyordu. Damga giriste (-use_wallclock_as_timestamps) DEGIL
 * cozucuden sonra verilir: giriste verilince kopya akis ve cozucu de etkilendi, kareler bozuldu (40c651e).
 */
export const CONVERT_BITRATE = { Main: 3000, Extra1: 1000 };
export const KEYFRAME_EXPR = 'expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+1))';
const NOW = '(RTCTIME-RTCSTART)/(TB*1000000)';
export const TIMESTAMP_FILTER = `setpts='if(isnan(PREV_OUTPTS),${NOW},max(${NOW},PREV_OUTPTS+0.001/TB))'`;
export const convertArgs = (type) => {
  const b = CONVERT_BITRATE[type] ?? CONVERT_BITRATE.Extra1;
  return ['-vf', TIMESTAMP_FILTER, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${2 * b}k`, '-force_key_frames', KEYFRAME_EXPR, '-bf', '0', '-fps_mode', 'passthrough'];
};

const GOP_LIMIT = 16 * 1024 * 1024;   // anahtar karesiz bu kadar birikirse onbellek bosaltilir (sonraki anahtar kare beklenir)
const GAP_LOG = 3000;   // ffmpeg'den bu kadar sure veri gelmeyip sonra yeniden gelirse gunluge yazilir (kisa duraksama)
const sec = (ms) => `${(ms / 1000).toFixed(1)} sn`;

export class Mp4Feed {
  /** etiket: gunlukte akisin adi (cihaz, kamera, kanal, tur); gunluk: test icin yazici. */
  constructor({ ffmpeg, args, onEnd = () => {}, firstDuration = 15_000, stopDuration = 10_000, label = 'akış', log = console.log }) {
    Object.assign(this, { ffmpeg, args, onEnd, firstDuration, stopDuration });
    this.log = new FeedLog(label, log);
    this.subscribers = new Set(); this.init = null; this.codec = null; this.gop = []; this.gopByte = 0;
    this.error = null; this.stopped = false; this.lastZ = Date.now(); this.splitter = new Fmp4Splitter();
  }

  start() {
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.t0 = Date.now(); this.log.event('başladı');
    this.firstTime = setTimeout(() => { if (!this.init) { this.error ??= 'Kameradan görüntü gelmedi'; this.stop(`ilk görüntü ${sec(this.firstDuration)} içinde gelmedi (ffmpeg çalışıyor)`); } }, this.firstDuration);
    // ffmpeg calisiyor ama cihazdan veri gelmiyor: cihaz baglantiyi tutup gondermeyi birakmis
    this.watcher = setInterval(() => { if (this.init && Date.now() - this.lastZ > this.stopDuration) this.stop(`cihaz veri göndermeyi bıraktı: ${sec(Date.now() - this.lastZ)} veri yok, bağlantı açık (ffmpeg çalışıyordu)`); }, 2000);
    this.ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...this.args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', (e) => { this.error = `ffmpeg başlatılamadı: ${e.code ?? e.message}`; this.stop(this.error); });   // dinleyicisiz 'error' tum paneli dusurur
    this.ff.stderr.on('data', (b) => this.log.stderr(b));
    this.ff.stdout.on('data', (b) => this.#data(b));
    // ffmpeg kendiliginden kapandi: cihaz baglantiyi kesti ya da akisi reddetti (nedeni ffmpeg satirlarinda)
    this.ff.on('close', (code, signal) => this.stop(`ffmpeg kapandı (${signal ? `sinyal ${signal}` : `kod ${code}`}) — cihaz bağlantıyı kesti ya da akışı reddetti`));
    return this;
  }

  #data(b) {
    let parts;
    try { parts = this.splitter.add(b); } catch { this.error = 'Görüntü çözümlenemedi'; return this.stop(this.error); }
    for (const p of parts) {
      const now = Date.now();
      if (this.init && now - this.lastZ >= GAP_LOG) this.log.event(`veri ${sec(now - this.lastZ)} gelmedi, sonra sürdü (izleyici ${this.subscribers.size})`);
      this.lastZ = now;
      if (p.type === 'init') {
        this.init = makeHvc1(p.data); this.codec = codecName(this.init);
        if (!this.codec) { this.error = 'Kameranın video biçimi desteklenmiyor'; return this.stop(`${this.error} (${this.init.length} bayt başlangıç)`); }
        this.log.event(`ilk görüntü ${sec(now - this.t0)} sonra, kodek ${this.codec}`);
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
      if (!this.subscribers.size) this.idleTimer = setTimeout(() => this.stop('izleyici kalmadı'), 4000);
    });
  }

  /** neden: gunluge yazilir (kopmanin kaynagi). */
  stop(reason = 'panel kapattı') {
    if (this.stopped) return;
    this.stopped = true;
    this.log.end(`${reason}; ${sec(Date.now() - this.t0)} açık kaldı, izleyici ${this.subscribers.size}`);
    clearTimeout(this.idleTimer); clearTimeout(this.firstTime); clearInterval(this.watcher);
    try { this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.subscribers) { try { r.end(); } catch {} }
    this.subscribers.clear();
    this.resolveReady?.();
    this.onEnd();
  }
}
