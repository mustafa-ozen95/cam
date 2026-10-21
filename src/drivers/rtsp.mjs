/**
 * RTSP tabanli NVR (Uniview, Hikvision) ortak kismi: canli yayin (ffmpeg -> MJPEG, kanal/tur basina tek akis, tum izleyiciler paylasir),
 * kayitli oynatma (izleyici basina) ve indirme (cihazdan dogrudan indirenin tarayicisina akar, sunucuya yazilmaz).
 * Alt siniflar yalniz adresleri verir: canliYol(kanal, tur), oynatYol(kanal, bas, bit) ve cihazSimdi() (cihazin yerel saati, sn).
 */
import { spawn } from 'node:child_process';
import { CihazTaban, yerelMetin, yerelSn } from './taban.mjs';
import { MP4_CIKIS, Mp4Yayin, cevirArgumanlari } from './mp4yayin.mjs';

const JPEG_BAS = Buffer.from([0xff, 0xd8]);
const JPEG_SON = Buffer.from([0xff, 0xd9]);

/** Izgara akislari icin secilebilen kare hizlari (kare/sn). Arayuzdeki secenekler ve tercih siniri bununla ayni olmali. */
export const ISTEGE_FPS = [5, 10, 15, 20, 25];
/** Izgarada ana akis kare genislikleri (masaustu 960, dar ekran 640). */
export const IZGARA_ANA_GENISLIK = [640, 960];

export class RtspCihaz extends CihazTaban {
  constructor(o) {
    super(o);
    this.rtspPort = Number(this.ayar.rtspPort) || 554;
    this.miniDestek = true;            // 'Mini': dusuk bantli izgara akisi (320 px, 5 kare/sn) - mobil hat icin
  }

  rtspUrl(yol) {
    const a = `${encodeURIComponent(this.ayar.kullanici)}:${encodeURIComponent(this.ayar.parola)}`;
    return `rtsp://${a}@${this.ayar.ana}:${this.rtspPort}/${yol}`;
  }

  /**
   * Canli MJPEG. Genislik tur basina sabit (her kanal/tur icin cihaza tek baglanti): Mini 320, Extra1 480, Main 1280.
   * genislik === 0 yalniz Main icin: OLCEKSIZ, kameranin tam cozunurlugu (tam ekran ve goruntu al).
   * fps yalniz izgara akislari (Mini/Extra1) icin; izinli degerler ISTEGE_FPS, verilmezse Mini 5, Extra1 10. Main kameranin kendi hizindadir.
   * Farkli fps ayri baglantidir: kayit cihazinin es zamanli akis siniri (16) bunu da sayar.
   */
  yayin(kanal, tur, istenen, fps) {
    // Ana akis IZGARADA (uye tercihi "ana akış"): kare boyunda (640/960) ve izgara kare hiziyla; odak/tam ekran olcekli (1280) ya da olceksiz (0), kendi hiziyla.
    const izgaraAna = tur === 'Main' && IZGARA_ANA_GENISLIK.includes(istenen) && ISTEGE_FPS.includes(fps);
    const genislik = tur === 'Mini' ? 320 : tur === 'Extra1' ? 480 : izgaraAna ? istenen : istenen === 0 ? 0 : 1280;
    const hiz = tur === 'Main' ? (izgaraAna ? fps : null) : ISTEGE_FPS.includes(fps) ? fps : tur === 'Mini' ? 5 : 10;
    const anahtar = `${kanal}/${tur}/${genislik}/${hiz ?? ''}`;
    let y = this.yayinlar.get(anahtar);
    if (!y) { y = new RtspYayin(this, this.canliYol(kanal, tur), genislik, () => this.yayinlar.delete(anahtar), false, hiz); this.yayinlar.set(anahtar, y); y.baslat(); }
    return y;
  }

  /**
   * Canli MP4: tur 'Main' ya da 'Extra1' (alt akis); kanal/tur basina tek baglanti, izleyiciler paylasir.
   * cevir=false: kameranin videosu oldugu gibi (yeniden kodlamasiz). cevir=true: kaynak kalitede H.264 (tarayici H.265 oynatmiyorsa).
   */
  yayinMp4(kanal, tur, cevir = false) {
    const anahtar = `mp4:${kanal}/${tur}${cevir ? '/h264' : ''}`;
    let y = this.yayinlar.get(anahtar);
    if (!y) {
      y = new Mp4Yayin({ ffmpeg: this.ffmpeg, argumanlar: mp4Argumanlari(this.rtspUrl(this.canliYol(kanal, tur)), tur, cevir), bitince: () => this.yayinlar.delete(anahtar) });
      this.yayinlar.set(anahtar, y); y.baslat();
    }
    return y;
  }

  oynatMjpeg(res, kanal, bas, bit, genislik) {
    if (!this.oynatabilir()) { try { res.end(); } catch {} return null; }
    this.oynatSayac++;
    res.on('close', () => { this.oynatSayac = Math.max(0, this.oynatSayac - 1); });
    // Bitis: istenen anin 6 saat sonrasi, cihazin simdisinden ilerisi olamaz
    this.cihazSimdi().then((simdi) => {
      const bitSn = Math.min(yerelSn(bas) + 6 * 3600, Math.floor(simdi) - 1);
      const y = new RtspYayin(this, this.oynatYol(kanal, bas, yerelMetin(bitSn)), Math.max(160, Math.min(1920, genislik || 960)), () => {}, true);
      y.baslat(); y.abone(res);
      res.on('close', () => y.durdur());
    }).catch(() => { try { res.end(); } catch {} });
  }

  async indirAkit(res, kanal, kayit, ad, bitince) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${ad}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    let bayt = 0, bitti = false, ff = null, sayildi = false, sonZ = Date.now(), bekci = null;
    const bitir = (tamam) => { if (bitti) return; bitti = true; clearInterval(bekci); if (sayildi) this.indirSayac = Math.max(0, this.indirSayac - 1); try { ff?.kill('SIGKILL'); } catch {} try { res.end(); } catch {} bitince?.({ tamam: tamam && bayt > 0, bayt }); };
    res.on('close', () => bitir(false));
    for (let t = 0; !this.indirabilir(); t++) { if (bitti || t > 900) return bitir(false); await new Promise((r) => setTimeout(r, 1000)); }
    if (bitti) return;
    sayildi = true; this.indirSayac++;
    const sure = Math.max(1, yerelSn(kayit.bit) - yerelSn(kayit.bas) + 2);
    ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', this.rtspUrl(this.oynatYol(kanal, kayit.bas, kayit.bit)),
      '-an', '-c:v', 'copy', '-t', String(sure), '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // 'error' dinleyicisi spawn'dan HEMEN sonra: baslatilamazsa (EMFILE/EAGAIN/ENOENT) dinleyicisiz 'error' butun paneli dusurur (stdio de yoktur).
    ff.on('error', () => bitir(false));
    ff.stderr.on('data', () => {});
    bekci = setInterval(() => { if (bayt > 100_000 && Date.now() - sonZ > 25_000) { clearInterval(bekci); bitir(true); } else if (Date.now() - sonZ > 40_000) { clearInterval(bekci); bitir(false); } }, 1000);
    ff.stdout.on('data', (b) => { bayt += b.length; sonZ = Date.now(); if (!res.write(b)) { ff.stdout.pause(); res.once('drain', () => ff.stdout.resume()); } });
    ff.on('close', (kod) => bitir(kod === 0 || bayt > 0));
  }
}

/** Canli MP4 ffmpeg argumanlari (test/mp4.test.mjs): kopya ya da kaynak kalitede H.264. */
export const mp4Argumanlari = (url, tur, cevir) => ['-rtsp_transport', 'tcp', '-i', url, ...(cevir ? cevirArgumanlari(tur) : ['-c:v', 'copy']), ...MP4_CIKIS];

/** Canli/kayitli MJPEG akisi: aboneler, son, kareSayac, hazir, hata, durdur, ilkKare (sunucu.mjs bu sozlesmeyi kullanir). */
/**
 * ffmpeg argumanlari (test/rtsp-arguman.test.mjs). Suzgec: kare hizi (yalniz canli izgara) ve olcek;
 * genislik 0 = olceksiz, kameranin tam cozunurlugu. Suzgec yoksa -vf hic yazilmaz.
 */
export function yayinArgumanlari(cihaz, { yol, genislik, oynatma, fps }) {
  const vf = [!oynatma && fps ? `fps=${fps}` : null, genislik ? cihaz.olcek(genislik) : null].filter(Boolean);
  return ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', cihaz.rtspUrl(yol), '-an',
    ...(vf.length ? ['-vf', vf.join(',')] : []), '-q:v', genislik && genislik <= 320 ? '9' : '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
}

export class RtspYayin {
  constructor(cihaz, yol, genislik, bitince, oynatma, fps = null) {
    Object.assign(this, { cihaz, yol, genislik, bitince, oynatma, fps });
    this.aboneler = new Set(); this.sonZ = Date.now(); this.son = null; this.durduruldu = false; this.jpegTampon = Buffer.alloc(0); this.hata = null; this.kareSayac = 0;
  }

  baslat() {
    this.hazir = this.#kur().catch((e) => { this.hata = e.message; this.durdur(); });
    this.bekci = setInterval(() => { if (this.son && Date.now() - this.sonZ > (this.oynatma ? 20_000 : 10_000)) this.durdur(); }, 2000);
  }

  async #kur() {
    const { cihaz } = this;
    this.ff = spawn(cihaz.ffmpeg, yayinArgumanlari(cihaz, this), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', (e) => { this.hata = `ffmpeg başlatılamadı: ${e.code ?? e.message}`; this.durdur(); });   // dinleyicisiz 'error' tum paneli dusurur
    this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#jpeg(b));
    this.ff.on('close', () => this.durdur());
    const t0 = Date.now();
    while (!this.son && !this.durduruldu) {
      if (Date.now() - t0 > 15_000) throw new Error(this.oynatma ? 'Bu anda kayıt yok' : 'Kameradan görüntü gelmedi');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ham=true: fetch okuyucusu icin yalniz ardisik JPEG baytlari (WebKit fetch'te multipart/x-mixed-replace'i reddeder)
  #parca(kare, r) { return r.ham ? [kare] : [`--kare\r\nContent-Type: image/jpeg\r\nContent-Length: ${kare.length}\r\n\r\n`, kare, '\r\n']; }

  #jpeg(b) {
    this.jpegTampon = this.jpegTampon.length ? Buffer.concat([this.jpegTampon, b]) : b;
    for (;;) {
      const bas = this.jpegTampon.indexOf(JPEG_BAS);
      if (bas < 0) { this.jpegTampon = Buffer.alloc(0); return; }
      const son = this.jpegTampon.indexOf(JPEG_SON, bas + 2);
      if (son < 0) { this.jpegTampon = this.jpegTampon.subarray(bas); return; }
      const kare = Buffer.from(this.jpegTampon.subarray(bas, son + 2));
      this.jpegTampon = this.jpegTampon.subarray(son + 2);
      this.son = kare; this.sonZ = Date.now(); this.kareSayac++;
      for (const r of this.aboneler) {
        if (r.writableNeedDrain) continue;
        for (const p of this.#parca(kare, r)) r.write(p);
      }
    }
  }

  abone(res) {
    this.aboneler.add(res);
    clearTimeout(this.bosZaman);
    if (this.son) for (const p of this.#parca(this.son, res)) res.write(p);
    res.on('close', () => {
      this.aboneler.delete(res);
      if (!this.aboneler.size) this.bosZaman = setTimeout(() => this.durdur(), this.oynatma ? 300 : 4000);
    });
  }

  async ilkKare() { await this.hazir; return this.son; }

  durdur() {
    if (this.durduruldu) return;
    this.durduruldu = true;
    clearTimeout(this.bosZaman); clearInterval(this.bekci);
    try { this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.aboneler) { try { r.end(); } catch {} }
    this.aboneler.clear();
    this.bitince();
  }
}
