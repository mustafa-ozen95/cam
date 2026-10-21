/**
 * DVR/NVR yoneticisi: kalici denetim oturumu (giris + canli tutma + yeniden baglanma), canli yayin dagitici
 * (kanal basina tek ffmpeg, cok izleyici), kayit sorgusu, kayitli oynatma (fMP4), kayit indirme (mp4).
 * Cihazin TCP baglanti siniri 10: izleyiciler yayini paylasir, her yayin yalniz 1 ek baglanti (claim) acar.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Baglanti, CerceveAyirici } from './xiongmai-dvrip.mjs';

const JPEG_BAS = Buffer.from([0xff, 0xd8]);
const JPEG_SON = Buffer.from([0xff, 0xd9]);

export class Dvr {
  constructor({ ayar, ffmpeg, veriKlasoru }) {
    this.ayar = ayar; this.ffmpeg = ffmpeg;
    this.denetim = null; this.girisSozu = null; this.kilit = Promise.resolve();
    this.yayinlar = new Map(); this.indirSayac = 0;
    this.kanalAdlari = null; this.sonHata = null;
    this.oynatSayac = 0;
    this.oynatMax = Number(process.env.KAMERA_OYNATMA_MAX ?? 4);                  // ayni anda cihazdan en fazla bu kadar kayit oynatma
    this.indirMax = Number(process.env.KAMERA_INDIRME_MAX ?? 2);                  // ayni anda cihazdan en fazla bu kadar kayit indirme (digerleri sirada bekler)
    this.olay = null;   // saat yalniz elle (Esitle dugmesi) ayarlanir
  }

  /** Goruntu orani [en, boy] ya da null (kaynak oranini koru). ayar.oran: "16:9" | "4:3" | "kaynak"; KAMERA_ORAN ile de verilir. */
  get oran() {
    const o = String(process.env.KAMERA_ORAN ?? this.ayar.oran ?? '16:9');
    const m = /^(\d+):(\d+)$/.exec(o);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** ffmpeg olcek suzgeci: genislik w, oran duzeltilmis yukseklik. */
  olcek(w) { const o = this.oran; return o ? `scale=${w}:${Math.max(2, Math.round((w * o[1]) / o[0] / 2) * 2)}` : `scale='min(${w},iw)':-2`; }

  // ---------- cihaz saati ----------
  static yerelZaman(d = new Date()) { return d.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }); }
  async saatFarki() {
    const dvr = await this.istek(1452, 'OPTimeQuery').then((y) => y.OPTimeQuery);
    const sunucu = Dvr.yerelZaman();
    return { dvr, sunucu, fark: Math.round((Date.parse(dvr.replace(' ', 'T') + 'Z') - Date.parse(sunucu.replace(' ', 'T') + 'Z')) / 1000) };
  }
  /** Cihaz saatini sunucu saatine (Europe/Istanbul) esitler. fark: cihaz - sunucu (sn). */
  async saatiSenkronla() {
    const once = await this.saatFarki();
    const y = await this.istek(1450, 'OPTimeSetting', Dvr.yerelZaman(), 10_000);
    if (y.Ret !== 100) throw new Error(`Cihaz saati ayarlamadı (Ret ${y.Ret})`);
    await new Promise((r) => setTimeout(r, 1200));
    const sonra = await this.saatFarki();
    return { once: once.dvr, oncekiFark: once.fark, sonra: sonra.dvr, sunucu: sonra.sunucu, sonFark: sonra.fark };
  }

  /** Cihaz TCP baglanti butcesi (10): denetim 1 + canli yayin basina 1 + oynatma/indirme basina 2 (ayri oturum + veri soketi). */
  butceVar() { return 1 + this.yayinlar.size + 2 * (this.oynatSayac + this.indirSayac) + 2 <= 10; }
  oynatabilir() { return this.oynatSayac < this.oynatMax && this.butceVar(); }
  indirabilir() { return this.indirSayac < this.indirMax && this.butceVar(); }

  // ---------- denetim oturumu ----------
  async oturum() {
    if (this.denetim && !this.denetim.kapandi) return this.denetim;
    this.girisSozu ??= (async () => {
      try {
        const b = new Baglanti(this.ayar.ana, this.ayar.port);
        await b.baglan();
        await b.giris(this.ayar.kullanici, this.ayar.parola);
        b.kapanisDinleyici = () => { clearInterval(b.canli); if (this.denetim === b) this.denetim = null; };
        b.canli = setInterval(() => { if (!b.kapandi) b.gonder(1006, { Name: 'KeepAlive', SessionID: b.oturumKimlik }); }, 10_000);
        b.veriDinleyici = (m) => m === 1007;
        this.denetim = b; this.sonHata = null;
        return b;
      } catch (e) { this.sonHata = e.message; throw e; } finally { this.girisSozu = null; }
    })();
    return this.girisSozu;
  }

  /** Denetim isteklerini sirayla yurutur (ayni mesaj numarasi cakismasin). */
  istek(msj, ad, ic, zamanAsimi) {
    const calis = async () => {
      const b = await this.oturum();
      const govde = { Name: ad, SessionID: b.oturumKimlik };
      if (ic !== undefined) govde[ad] = ic;
      return b.istek(msj, govde, zamanAsimi);
    };
    const s = this.kilit.then(calis, calis);
    this.kilit = s.catch(() => {});
    return s;
  }

  async ayarAl(ad) {
    const y = await this.istek(1042, ad);
    if (y.Ret !== 100) throw new Error(`${ad}: Ret ${y.Ret}`);
    return y[ad];
  }

  async bilgi() {
    const [sis, disk, saat] = await Promise.all([
      this.istek(1020, 'SystemInfo').then((y) => y.SystemInfo),
      this.istek(1020, 'StorageInfo').then((y) => y.StorageInfo).catch(() => null),
      this.istek(1452, 'OPTimeQuery').then((y) => y.OPTimeQuery).catch(() => null),
    ]);
    const kanal = sis.VideoInChannel ?? this.ayar.kanalSayisi;
    this.kanalAdlari ??= await this.ayarAl('AVEnc.VideoWidget').then((v) => v.map((k) => k?.ChannelTitle?.Name)).catch(() => []);
    let toplam = 0, bos = 0;
    for (const p of disk ?? []) for (const x of p.Partition ?? []) { toplam += parseInt(x.TotalSpace, 16) || 0; bos += parseInt(x.RemainSpace, 16) || 0; }
    const kanalBos = await this.kanalBosDurum(kanal);
    const diskler = [];
    for (const [pi, p] of (disk ?? []).entries()) for (const [xi, x] of (p.Partition ?? []).entries()) {
      const tp = parseInt(x.TotalSpace, 16) || 0; if (!tp) continue;
      const gecerli = (z) => (z && !z.startsWith('0000') && !z.startsWith('2000') ? z : null);
      diskler.push({ ad: `Disk ${pi + 1}${(p.Partition ?? []).filter((y) => parseInt(y.TotalSpace, 16)).length > 1 ? `.${xi + 1}` : ''}`, uretici: '', toplamMB: tp, bosMB: parseInt(x.RemainSpace, 16) || 0, sicaklik: null,
        durum: x.Status === 0 ? 'iyi' : 'hata', durumYazi: x.Status === 0 ? 'Normal' : `Durum kodu ${x.Status}`, kayitBas: gecerli(x.NewStartTime), kayitSon: gecerli(x.NewEndTime), mevcut: !!x.IsCurrent });
    }
    return {
      diskler,
      kanalBos,
      sunucuSaat: Dvr.yerelZaman(),
      ana: this.ayar.ana, model: sis.HardWare, surum: sis.SoftWareVersion, seriNo: sis.SerialNo, derleme: sis.BuildTime,
      calismaSn: (parseInt(sis.DeviceRunTime, 16) || 0) * 1, saat, kanal,
      kanalAdlari: Array.from({ length: kanal }, (_, i) => this.kanalAdlari[i] || `Kanal ${i + 1}`),
      diskMB: { toplam, bos },
    };
  }

  // ---------- bos (kamera takili olmayan) kanal tespiti ----------
  /** Dondurur: kanal basina true = bos. ayar.gizliKanallar (0 tabanli) kesin gizler; ayar.otomatikGizle=false tespiti kapatir. */
  async kanalBosDurum(kanal) {
    const zorla = new Set(this.ayar.gizliKanallar ?? []);
    const bas = (k) => zorla.has(k);
    if (this.ayar.otomatikGizle === false) return Array.from({ length: kanal }, (_, k) => bas(k));
    const simdi = Date.now();
    if (this.bosOnbellek && simdi - this.bosOnbellek.z < 5 * 60_000 && this.bosOnbellek.n === kanal) return this.bosOnbellek.liste.map((b, k) => b || bas(k));
    const hesapla = async () => {
      // Her kanal: 'bos' (siyah goruntu), 'canli' ya da 'yok' (akistan kare alinamadi: bagli kamera yok ya da gecici hata)
      const sonuc = await Promise.all(Array.from({ length: kanal }, async (_, k) => {
        if (bas(k)) return 'bos';
        this.canliGorulen ??= new Set();
        if (this.canliGorulen.has(k)) return 'canli';   // bir kez goruntu verdi: asla gizleme (gece/karanlik sahne yaniltmasin)
        try {
          // Alt akisin ilk karesi bozuk gelebiliyor: ana akistan iki ayri kare (1.5 sn arayla), ikisi de siyahsa bos
          const [x, y] = await this.ikiKare(k);
          const [px, py] = [await this.parlaklik(x), await this.parlaklik(y)];
          if (px >= 6 || py >= 6) { this.canliGorulen.add(k); return 'canli'; }
          return 'bos';
        } catch { return 'yok'; }
      }));
      // Bazi ffmpeg surumleri bos kanaldan hic kare uretmez: baska kanallar goruntu veriyorsa, kare vermeyen ve hic goruntu gormemis kanal bostur.
      const biriCanli = sonuc.includes('canli');
      const liste = sonuc.map((r, k) => r === 'bos' || (r === 'yok' && biriCanli && !this.canliGorulen.has(k)));
      this.bosOnbellek = { z: Date.now(), n: kanal, liste };
      return liste;
    };
    // Ilk seferde bekle (arayuz bos kanali hic cizmesin); sonra arka planda tazele, eski sonucu dondur.
    if (!this.bosOnbellek || this.bosOnbellek.n !== kanal) return hesapla();
    this.bosHesap ??= hesapla().finally(() => { this.bosHesap = null; });
    return this.bosOnbellek.liste.map((b, k) => b || bas(k));
  }

  /** Ana akistan iki kare: ilk kare + 1.5 sn sonraki. */
  async ikiKare(kanal) {
    const y = this.yayin(kanal, 'Main', 320);
    try {
      const a = await y.ilkKare();
      if (!a) throw new Error('kare yok');
      await new Promise((r) => setTimeout(r, 1500));
      return [a, y.son ?? a];
    } finally { if (!y.aboneler.size) { clearTimeout(y.bosZaman); y.bosZaman = setTimeout(() => y.durdur(), 1500); } }
  }

  /** Bir kanaldan tek kare (JPEG) alir ve akisi hemen birakir. */
  async anlikKare(kanal, tur, genislik) {
    const y = this.yayin(kanal, tur, genislik);
    try { return await y.ilkKare(); } finally { if (!y.aboneler.size) { clearTimeout(y.bosZaman); y.bosZaman = setTimeout(() => y.durdur(), 1500); } }
  }

  /** JPEG'in ortalama parlakligi (0-255): ffmpeg signalstats YAVG. */
  parlaklik(jpeg) {
    return new Promise((coz, red) => {
      const ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      ff.on('error', red);          // baslatilamazsa dinleyicisiz 'error' paneli dusurur
      let cikti = '';
      ff.stdout.on('data', (b) => (cikti += b));
      ff.stdin.on('error', () => {});
      ff.on('close', () => { const m = /YAVG=([\d.]+)/.exec(cikti); m ? coz(Number(m[1])) : red(new Error('parlaklik okunamadi')); });
      ff.stdin.end(jpeg);
    });
  }

  // ---------- kayit sorgusu ----------
  async kayitlar(kanal, bas, bit) {
    const sonuc = new Map();
    let b = bas;
    for (let tur = 0; tur < 40; tur++) {
      const y = await this.istek(1440, 'OPFileQuery', { BeginTime: b, EndTime: bit, Channel: kanal, DriveNo: '0', Event: '*', StreamType: '0x00000000', Type: 'h264' }, 15_000);
      const liste = Array.isArray(y.OPFileQuery) ? y.OPFileQuery : [];
      for (const f of liste) sonuc.set(f.FileName, f);
      if (liste.length < 64) break;
      const son = liste[liste.length - 1].EndTime;
      if (!son || son <= b) break;
      b = son;
    }
    return [...sonuc.values()].map((f) => ({
      ad: f.FileName, bas: f.BeginTime, bit: f.EndTime, boyut: (parseInt(f.FileLength, 16) || 0) * 1024,
      tur: /\[([RMAH])\]/.exec(f.FileName)?.[1] ?? 'R',
    })).sort((x, y) => x.bas.localeCompare(y.bas));
  }

  // ---------- akis (claim soketi + baslat) ----------
  /** ic(eylem) -> komut govdesi. Veri paketleri `veri(buf)`'a gider. Dondurur { soket, durdur() }. */
  async akisAc({ ad, claimMsj, baslatMsj, ic, veriMsj, veri, kapandi, ayriOturum = false }) {
    let ana, ozel = null;
    if (ayriOturum) {
      ozel = new Baglanti(this.ayar.ana, this.ayar.port);
      await ozel.baglan();
      try { await ozel.giris(this.ayar.kullanici, this.ayar.parola); } catch (e) { ozel.kapat(); throw e; }
      ozel.veriDinleyici = (m) => m === 1007;
      ozel.canli = setInterval(() => { if (!ozel.kapandi) ozel.gonder(1006, { Name: 'KeepAlive', SessionID: ozel.oturumKimlik }); }, 10_000);
      ana = ozel;
    } else ana = await this.oturum();
    const baslat = (eylem, ms) => (ozel ? ozel.istek(baslatMsj, { Name: ad, SessionID: ozel.oturumKimlik, [ad]: ic(eylem) }, ms) : this.istek(baslatMsj, ad, ic(eylem), ms));
    const kapatOzel = () => { if (ozel) { clearInterval(ozel.canli); setTimeout(() => ozel.kapat(), 150); } };
    const s = new Baglanti(this.ayar.ana, this.ayar.port);
    await s.baglan();
    s.oturum = ana.oturum;
    let claimCoz;
    const claim = new Promise((coz, red) => { claimCoz = coz; setTimeout(() => red(new Error('Akış sahiplenme yanıtı gelmedi')), 6000); });
    s.veriDinleyici = (m, g) => {
      if (veriMsj.includes(m)) { veri(g); return true; }
      if (m === claimMsj + 1) { try { claimCoz(JSON.parse(g.toString().replace(/[\0\n]+$/, ''))); } catch { claimCoz({ Ret: -1 }); } }
      return true;
    };
    s.kapanisDinleyici = () => { kapandi?.(); kapatOzel(); };
    try {
      s.gonder(claimMsj, { Name: ad, SessionID: ana.oturumKimlik, [ad]: ic('Claim') });
      const c = await claim;
      if (c.Ret !== 100) throw new Error(`Akış reddedildi (Ret ${c.Ret}; bağlantı sınırı dolu olabilir)`);
      const y = await baslat('Start', 8000);
      if (y.Ret !== 100) throw new Error(`Akış başlatılamadı (Ret ${y.Ret})`);
    } catch (e) { s.kapat(); kapatOzel(); throw e; }
    let bitti = false;
    return {
      baglanti: s,
      durdur: () => {
        if (bitti) return; bitti = true;
        baslat('Stop', 2000).catch(() => {});
        setTimeout(() => s.kapat(), 100);
        kapatOzel();
      },
    };
  }

  izleIc = (kanal, tur) => (eylem) => ({ Action: eylem, Parameter: { Channel: kanal, CombinMode: 'NONE', StreamType: tur, TransMode: 'TCP' } });
  oynatIc = (kanal, bas, bit, dosya) => (eylem) => ({
    Action: eylem, StartTime: bas, EndTime: bit,
    Parameter: { PlayMode: dosya ? 'ByName' : 'ByTime', FileName: dosya ?? '', StreamType: 0, Value: 0, TransMode: 'TCP', Channel: kanal, Type: 'h264' },
  });

  // ---------- canli yayin (MJPEG, paylasimli) ----------
  yayin(kanal, tur, _genislik) {
    // Genislik tur basina SABIT (istemci ne isterse): her kanal/tur icin cihaza tek baglanti, tum izleyiciler paylasir.
    const genislik = tur === 'Extra1' ? 480 : 1280;
    const anahtar = `${kanal}/${tur}/${genislik}`;
    let y = this.yayinlar.get(anahtar);
    if (!y) { y = new CanliYayin(this, kanal, tur, genislik, () => this.yayinlar.delete(anahtar)); this.yayinlar.set(anahtar, y); y.baslat(); }
    return y;
  }

  // ---------- kayitli oynatma (MJPEG, izleyici basina; tum tarayicilarda calisir) ----------
  oynatMjpeg(res, kanal, bas, bit, genislik) {
    if (!this.oynatabilir()) { try { res.end(); } catch {} return null; }   // cihaz bagli kalmasin: sinir doluysa istemci birazdan yeniden dener
    this.oynatSayac++;
    res.on('close', () => { this.oynatSayac = Math.max(0, this.oynatSayac - 1); });
    // Cihaz ByTime oynatmada kanal parametresini yok sayiyor (hep CAM01): kanal klasorundeki dosya adiyla (ByName) oynatilir.
    const mod = { oynatma: { kanal, bas } };
    const y = new CanliYayin(this, kanal, 'oynat', genislik, () => {}, mod);
    y.baslat();
    y.abone(res);
    // Kayit bitince (cihaz akisi kapatir ya da sessizlesir) yaniti kapat: istemci "kayit sonu" gorur.
    let son = Date.now(), sayac = -1;
    const bekci = setInterval(() => {
      if (y.durduruldu) return clearInterval(bekci);
      if (y.kareSayac !== sayac) { sayac = y.kareSayac; son = Date.now(); } else if (Date.now() - son > 8000) { clearInterval(bekci); y.durdur(); }
    }, 1000);
    res.on('close', () => { clearInterval(bekci); });
    return y;
  }

  // ---------- kayit indirme: cihazdan dogrudan indirenin tarayicisina AKAR; sunucu diskine hicbir sey yazilmaz ----------
  indirAdi(kanal, kayit) {
    // Kamera adi + tarih + baslangic-bitis saati: CAM01_2026-01-01_10.00.00-10.01.00.mp4
    const kamera = String(this.adlarGecersiz?.[kanal] || this.kanalAdlari?.[kanal] || `K${kanal + 1}`).replace(/[ıİğĞüÜşŞöÖçÇ]/g, (c) => ({ ı: 'i', İ: 'I', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ş: 's', Ş: 'S', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' })[c]).replace(/\s+/g, '-').replace(/[^\w-]+/g, '') || `K${kanal + 1}`;
    return `${kamera}_${kayit.bas.slice(0, 10)}_${kayit.bas.slice(11).replaceAll(':', '.')}-${kayit.bit.slice(11).replaceAll(':', '.')}.mp4`;
  }

  /** Kuyrukta sirasini bekler, sonra DownloadStart ile cihazdan cekip parcali mp4 olarak res'e yazar. bitince({ tamam, bayt }) */
  async indirAkit(res, kanal, kayit, ad, bitince) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${ad}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    let ff = null, akis = null, kapali = false, bayt = 0, bitirildi = false, sonZ = Date.now(), alinan = 0, sayildi = false;
    const bekci = setInterval(() => {
      if (!akis || bitirildi) return;
      const sessiz = Date.now() - sonZ;
      if (alinan > 0 && sessiz > 4000) tamamla(true);            // dosya sonunda cihaz akisi kapatmaz, yalniz veri kesilir
      else if (sessiz > 20_000) tamamla(false);
    }, 1000);
    const say = (art) => { if (art && !sayildi) { sayildi = true; this.indirSayac++; } else if (!art && sayildi) { sayildi = false; this.indirSayac = Math.max(0, this.indirSayac - 1); } };
    const sonlan = (tamam) => { if (bitirildi) return; bitirildi = true; clearInterval(bekci); say(false); try { akis?.durdur(); } catch {} bitince?.({ tamam, bayt }); };
    function tamamla(tamam) { if (bitirildi) return; try { akis?.durdur(); } catch {} if (ff && tamam) { try { ff.stdin.end(); } catch {} } else { try { ff?.kill('SIGKILL'); } catch {} try { res.end(); } catch {} } sonlan(tamam && alinan > 0); }
    res.on('close', () => { kapali = true; if (!bitirildi) { try { ff?.stdin.destroy(); ff?.kill('SIGKILL'); } catch {} sonlan(false); } });
    // sira: ayni anda en fazla indirMax; cihaz baglanti butcesi doluysa bekle
    for (let t = 0; !this.indirabilir(); t++) { if (kapali || t > 900) { sonlan(false); try { res.end(); } catch {} return; } await new Promise((r) => setTimeout(r, 1000)); }
    if (kapali) return sonlan(false);
    say(true);
    const ayirici = new CerceveAyirici((v) => {
      if (bitirildi) return;
      if (!ff) {
        const fps = ayirici.bilgi.fps || 25;
        ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-framerate', String(fps), '-i', 'pipe:0', ...(this.oran ? ['-aspect', this.oran.join(':')] : []),
          '-c:v', 'copy', '-bsf:v', `setts=ts=N/${fps}/TB`, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        ff.on('error', () => tamamla(false));          // baslatilamazsa dinleyicisiz 'error' paneli dusurur
        ff.stdin.on('error', () => {}); ff.stderr.on('data', () => {});
        ff.stdout.on('data', (b) => { bayt += b.length; });
        ff.stdout.pipe(res);
        ff.on('close', () => { try { res.end(); } catch {} if (!bitirildi) sonlan(alinan > 0); });
      }
      if (!ff.stdin.write(v)) { akis?.baglanti.soket.pause(); ff.stdin.once('drain', () => akis?.baglanti.soket.resume()); }
    }, null);
    const eylem = (e) => ({ ...this.oynatIc(kanal, kayit.bas, kayit.bit, kayit.ad)(e), Action: e === 'Start' ? 'DownloadStart' : e === 'Stop' ? 'DownloadStop' : e });
    try {
      akis = await this.akisAc({ ad: 'OPPlayBack', claimMsj: 1424, baslatMsj: 1420, ic: eylem, veriMsj: [1426, 1422], ayriOturum: true,
        veri: (g) => { alinan += g.length; sonZ = Date.now(); ayirici.ekle(g); }, kapandi: () => { if (!bitirildi && alinan > 0) tamamla(true); } });
      if (bitirildi) akis.durdur();
    } catch (e) { sonZ = 0; try { res.end(); } catch {} sonlan(false); throw e; }
  }

  /** DVR diskindeki TUM kayitlari siler (bicimlendirme). Cihaz tek tek dosya silmeyi desteklemez. */
  async diskiTemizle() {
    return this.istek(1450, 'OPStorageManager', { Action: 'Clear', PartNo: 0, PlysicalNo: 0, Type: 'Data' }, 60_000);
  }

  kapat() { for (const y of [...this.yayinlar.values()]) y.durdur(); this.denetim?.kapat(); }
}

class CanliYayin {
  constructor(dvr, kanal, tur, genislik, bitince, mod = null) {
    Object.assign(this, { dvr, kanal, tur, genislik, bitince, mod });
    this.aboneler = new Set(); this.sonZ = Date.now(); this.son = null; this.durduruldu = false; this.jpegTampon = Buffer.alloc(0); this.hata = null;
  }

  baslat() {
    this.hazir = this.#kur().catch((e) => { this.hata = e.message; this.durdur(); });
    // Kare akisi 10 sn durursa (kamera/cihaz takildi) yayini kapat: izleyiciler kendiliginden yeniden baglanir.
    this.bekci = setInterval(() => { if (this.son && Date.now() - this.sonZ > 10_000) this.durdur(); }, 2000);
  }

  async #kur() {
    const { dvr } = this;
    const ayirici = new CerceveAyirici((v) => {
      if (this.durduruldu) return;
      if (!this.ff.stdin.write(v)) { this.akis?.baglanti.soket.pause(); this.ff.stdin.once('drain', () => this.akis?.baglanti.soket.resume()); }
    }, null);
    const w = Math.max(160, Math.min(1920, this.genislik || 640));
    this.ff = spawn(dvr.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0', '-an', '-vf', dvr.olcek(w), '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', () => this.durdur());       // baslatilamazsa dinleyicisiz 'error' paneli dusurur
    this.ff.stdin.on('error', () => {}); this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#jpeg(b));
    this.ff.on('close', () => this.durdur());
    if (this.mod?.oynatma) { this.ayirici = ayirici; await this.#oynatKur(); }
    else {
      this.akis = await dvr.akisAc({ ad: 'OPMonitor', claimMsj: 1413, baslatMsj: 1410, ic: dvr.izleIc(this.kanal, this.tur), veriMsj: [1412], veri: (g) => ayirici.ekle(g), kapandi: () => this.durdur() });
      if (this.durduruldu) { this.akis.durdur(); return; }
    }
    const t0 = Date.now();
    while (!this.son && !this.durduruldu) {
      if (Date.now() - t0 > 8000) throw new Error('Kameradan görüntü gelmedi');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Kayitli oynatma: hedef andan baslayarak kanalin dosyalarini sirayla (ByName + dosya ici baslangic zamani) oynatir. */
  async #oynatKur() {
    const { dvr } = this; const { kanal, bas } = this.mod.oynatma;
    const gun = bas.slice(0, 10);
    const ertesi = new Date(Date.parse(`${gun}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    this.dosyalar = (await dvr.kayitlar(kanal, `${gun} 00:00:00`, `${ertesi} 23:59:59`)).filter((f) => f.bit > bas);
    if (!this.dosyalar.length) throw new Error('Bu anda kayıt yok');
    this.sira = 0; this.hedef = bas; this.jeton = 0; this.alinan = 0; this.sonVeriZ = Date.now();
    await this.#dosyaOynat();
    // dosya sonunda cihaz akisi kapatmaz, yalniz veri kesilir: 4 sn sessizlikte siradaki dosyaya gec
    this.dosyaBekci = setInterval(() => { if (this.akis && this.alinan > 0 && Date.now() - this.sonVeriZ > 4000) this.#dosyaOynat().catch(() => this.durdur()); }, 1000);
  }
  async #dosyaOynat() {
    if (this.gecis || this.durduruldu) return;
    this.gecis = true;
    try {
      const jeton = ++this.jeton;
      this.akis?.durdur(); this.akis = null;
      const f = this.dosyalar[this.sira++];
      if (!f) { this.durdur(); return; }
      const baslangic = f.bas > this.hedef ? f.bas : this.hedef;
      this.alinan = 0; this.sonVeriZ = Date.now();
      this.akis = await this.dvr.akisAc({
        ad: 'OPPlayBack', claimMsj: 1424, baslatMsj: 1420, ic: this.dvr.oynatIc(this.kanal, baslangic, f.bit, f.ad), veriMsj: [1422, 1426], ayriOturum: true,
        veri: (g) => { this.alinan += g.length; this.sonVeriZ = Date.now(); this.ayirici.ekle(g); },
        kapandi: () => { if (jeton === this.jeton && !this.gecis) this.#dosyaOynat().catch(() => this.durdur()); },
      });
      if (this.durduruldu) this.akis.durdur();
    } finally { this.gecis = false; }
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
      this.son = kare; this.sonZ = Date.now(); this.kareSayac = (this.kareSayac ?? 0) + 1;
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
      if (!this.aboneler.size) this.bosZaman = setTimeout(() => this.durdur(), this.mod ? 300 : 4000);
    });
  }

  /** Ilk kare gelene dek bekler (anlik goruntu icin). */
  async ilkKare() {
    await this.hazir;
    return this.son;
  }

  durdur() {
    if (this.durduruldu) return;
    this.durduruldu = true;
    clearTimeout(this.bosZaman); clearInterval(this.bekci); clearInterval(this.dosyaBekci);
    this.akis?.durdur();
    try { this.ff?.stdin.destroy(); this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.aboneler) { try { r.end(); } catch {} }
    this.aboneler.clear();
    this.bitince();
  }
}
