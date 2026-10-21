/**
 * Canli MP4 yayini: kameranin kendi videosu (H.264/H.265) ffmpeg ile YENIDEN KODLANMADAN parcali MP4'e sarilir, tum izleyiciler paylasir.
 * MJPEG'e gore tarayiciya giden veri cihazdan gelen kadardir (Hikvision ana akis olcumu: MJPEG 14,4 Mbps, kaynak 1,9 Mbps).
 *
 * Sonradan katilan izleyici: baslangic + son anahtar kareden bu yana biriken parcalar (GOP) verilir; tarayici oradan cozer.
 * Yetisemeyen izleyici (soket dolu) parca atlar ama yalniz bir sonraki anahtar kareye kadar: yarim GOP cozulmez.
 * Sozlesme RtspYayin ile ayni: aboneler, hazir, hata, sonZ, durdur, bitince.
 */
import { spawn } from 'node:child_process';
import { Fmp4Ayirici, hvc1Yap, kodekAdi } from './fmp4.mjs';

/** ffmpeg cikis secenekleri (kodlayici haric): parca her anahtar karede ve en gec 200 ms'de kapanir (gecikme), ses yok. */
export const MP4_CIKIS = ['-an', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000', 'pipe:1'];

/**
 * Kaynak kalitede H.264'e cevirme (tarayici H.265 oynatamazsa; Chrome). Cozunurluk ve kare hizi oldugu gibi
 * (goruntu kalitesinden odun verilmez). Bit hizi kaynagin ~1,5-2 kati (H.264 ayni kalite icin daha cok ister).
 * Olcum (Uniview): ana 1080p 25 kare/sn %82 cekirdek 3,09 Mbps; alt 704x576 %18 cekirdek 1,04 Mbps.
 * Anahtar kare saniyede bir: yeni izleyici beklemez, tampon kirpilabilir.
 */
export const CEVIR_BIT = { Main: 3000, Extra1: 1000 };
export const cevirArgumanlari = (tur) => {
  const b = CEVIR_BIT[tur] ?? CEVIR_BIT.Extra1;
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${2 * b}k`, '-force_key_frames', 'expr:gte(t,n_forced*1)', '-bf', '0'];
};

const GOP_SINIRI = 16 * 1024 * 1024;   // anahtar karesiz bu kadar birikirse onbellek bosaltilir (sonraki anahtar kare beklenir)

export class Mp4Yayin {
  constructor({ ffmpeg, argumanlar, bitince = () => {}, ilkSure = 15_000, durmaSure = 10_000 }) {
    Object.assign(this, { ffmpeg, argumanlar, bitince, ilkSure, durmaSure });
    this.aboneler = new Set(); this.init = null; this.kodek = null; this.gop = []; this.gopBayt = 0;
    this.hata = null; this.durduruldu = false; this.sonZ = Date.now(); this.ayirici = new Fmp4Ayirici();
  }

  baslat() {
    this.hazir = new Promise((coz) => { this.hazirCoz = coz; });
    this.ilkZaman = setTimeout(() => { if (!this.init) { this.hata ??= 'Kameradan görüntü gelmedi'; this.durdur(); } }, this.ilkSure);
    this.bekci = setInterval(() => { if (this.init && Date.now() - this.sonZ > this.durmaSure) this.durdur(); }, 2000);
    this.ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...this.argumanlar], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', (e) => { this.hata = `ffmpeg başlatılamadı: ${e.code ?? e.message}`; this.durdur(); });   // dinleyicisiz 'error' tum paneli dusurur
    this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#veri(b));
    this.ff.on('close', () => this.durdur());
    return this;
  }

  #veri(b) {
    let parcalar;
    try { parcalar = this.ayirici.ekle(b); } catch { this.hata = 'Görüntü çözümlenemedi'; return this.durdur(); }
    for (const p of parcalar) {
      this.sonZ = Date.now();
      if (p.tur === 'init') {
        this.init = hvc1Yap(p.veri); this.kodek = kodekAdi(this.init);
        if (!this.kodek) { this.hata = 'Kameranın video biçimi desteklenmiyor'; return this.durdur(); }
        clearTimeout(this.ilkZaman); this.hazirCoz();
      } else this.#parca(p.veri, p.anahtar);
    }
  }

  #parca(veri, anahtar) {
    if (anahtar) { this.gop = [veri]; this.gopBayt = veri.length; }
    else if (this.gop.length) { this.gop.push(veri); this.gopBayt += veri.length; if (this.gopBayt > GOP_SINIRI) { this.gop = []; this.gopBayt = 0; } }
    for (const r of this.aboneler) {
      if (r.anahtarBekle && !anahtar) continue;
      if (r.writableNeedDrain) { r.anahtarBekle = true; continue; }
      r.anahtarBekle = false; r.write(veri);
    }
  }

  /** hazir'dan SONRA cagrilir (baslangic hazir olmali). */
  abone(res) {
    this.aboneler.add(res);
    clearTimeout(this.bosZaman);
    res.write(this.init);
    if (this.gop.length) res.write(Buffer.concat(this.gop)); else res.anahtarBekle = true;
    res.on('close', () => {
      this.aboneler.delete(res);
      if (!this.aboneler.size) this.bosZaman = setTimeout(() => this.durdur(), 4000);
    });
  }

  durdur() {
    if (this.durduruldu) return;
    this.durduruldu = true;
    clearTimeout(this.bosZaman); clearTimeout(this.ilkZaman); clearInterval(this.bekci);
    try { this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.aboneler) { try { r.end(); } catch {} }
    this.aboneler.clear();
    this.hazirCoz?.();
    this.bitince();
  }
}
