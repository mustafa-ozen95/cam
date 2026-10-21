/**
 * SAHTE cihaz (yalniz testler): KAMERA_TEST=1 iken kullanilabilir. Gercek cihaza baglanmadan canli akis, kayit listesi,
 * oynatma ve indirme taklidi yapar; yetkilendirme/API entegrasyon testleri bununla kosar.
 */
import { CihazTaban } from './base.mjs';
import { MP4_CIKIS, Mp4Yayin } from './mp4-stream.mjs';

// SOI + APP0 + EOI: bayt duzeyinde gecerli en kucuk "JPEG" (sunucu kareyi cozmez, yalniz tasir)
export const SAHTE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

class SahteYayin {
  constructor(bitince, omurMs = 0) {
    this.aboneler = new Set(); this.son = SAHTE_JPEG; this.kareSayac = 0; this.durduruldu = false; this.hata = null; this.hazir = Promise.resolve(); this.bitince = bitince;
    this.zaman = setInterval(() => {
      this.kareSayac++;
      for (const r of this.aboneler) { if (r.writableNeedDrain) continue; r.write(r.ham ? SAHTE_JPEG : `--kare\r\nContent-Type: image/jpeg\r\nContent-Length: ${SAHTE_JPEG.length}\r\n\r\n`); if (!r.ham) { r.write(SAHTE_JPEG); r.write('\r\n'); } }
    }, 50);
    if (omurMs) this.omur = setTimeout(() => this.durdur(), omurMs);
  }
  abone(res) { this.aboneler.add(res); res.on('close', () => { this.aboneler.delete(res); if (!this.aboneler.size) this.bosZaman = setTimeout(() => this.durdur(), 200); }); }
  async ilkKare() { return this.son; }
  durdur() {
    if (this.durduruldu) return; this.durduruldu = true;
    clearInterval(this.zaman); clearTimeout(this.omur); clearTimeout(this.bosZaman);
    for (const r of this.aboneler) { try { r.end(); } catch {} } this.aboneler.clear(); this.bitince?.();
  }
}

export class Sahte extends CihazTaban {
  constructor(o) {
    super(o);
    this.kanalSayisi = Number(this.ayar.kanalSayisi ?? 4); this.etiket = this.ayar.etiket ?? 'T';
  }
  async bilgi() {
    const n = this.kanalSayisi;
    return {
      kanalBos: new Array(n).fill(false), sunucuSaat: CihazTaban.yerelZaman(),
      ana: this.ayar.ana, model: 'SAHTE-1', surum: '1.0', seriNo: `S-${this.ayar.ana}`, derleme: '2026-01-01',
      calismaSn: 1, saat: CihazTaban.yerelZaman(), kanal: n,
      kanalAdlari: Array.from({ length: n }, (_, i) => `Kamera ${i + 1}`), kanalKodlar: Array.from({ length: n }, (_, i) => `${this.etiket}${i + 1}`), kanalKamera: new Array(n).fill('sahte'),
      diskMB: { toplam: 1000, bos: 500 }, diskler: [{ ad: 'Disk 1', uretici: 'SAHTE', toplamMB: 1000, bosMB: 500, sicaklik: 30, durum: 'iyi', durumYazi: 'Normal', kayitBas: null, kayitSon: null, mevcut: true }], kayitGunTahmini: null,
    };
  }
  async kayitlar(kanal, bas) {
    const gun = bas.slice(0, 10);
    return [0, 1, 2].map((i) => ({ ad: `/sahte/c${kanal}/${gun}-${i}.h264`, bas: `${gun} 10:${i}0:00`, bit: `${gun} 10:${i}9:59`, boyut: 1000 + i, tur: 'R' }));
  }
  yayin(kanal, tur) {
    const anahtar = `${kanal}/${tur}`;
    let y = this.yayinlar.get(anahtar);
    if (!y) { y = new SahteYayin(() => this.yayinlar.delete(anahtar)); this.yayinlar.set(anahtar, y); }
    return y;
  }
  /** Canli MP4: ffmpeg'in deneme goruntusu H.264'e kodlanir (gercek fMP4; tarayici sinamasi oynatabilsin). cevir: ayri yayin (RtspCihaz gibi). */
  yayinMp4(kanal, tur, cevir = false) {
    const anahtar = `mp4:${kanal}/${tur}${cevir ? '/h264' : ''}`;
    let y = this.yayinlar.get(anahtar);
    if (!y) {
      const girdi = ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '10', '-pix_fmt', 'yuv420p'];
      y = new Mp4Yayin({ ffmpeg: this.ffmpeg, argumanlar: [...girdi, ...MP4_CIKIS], bitince: () => this.yayinlar.delete(anahtar) });
      this.yayinlar.set(anahtar, y); y.baslat();
    }
    return y;
  }
  oynatMjpeg(res) {
    if (!this.oynatabilir()) { try { res.end(); } catch {} return null; }
    this.oynatSayac++; res.on('close', () => { this.oynatSayac = Math.max(0, this.oynatSayac - 1); });
    const y = new SahteYayin(() => {}, 600); y.abone(res); return y;
  }
  async indirAkit(res, kanal, kayit, ad, bitince) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${ad}"` });
    res.end(Buffer.alloc(1000, 1)); bitince?.({ tamam: true, bayt: 1000 });
  }
  async saatiSenkronla() { const t = CihazTaban.yerelZaman(); return { once: t, sonra: t, sunucu: t }; }
}
