/**
 * Xiongmai / NetSurveillance DVR-NVR surucusu (DVR-IP, TCP 34567): canli, kayitli oynatma, indirme, saat esitleme.
 * dvr.mjs/dvrip.mjs'deki Dvr sinifini cihaz grubunun bekledigi alanlarla (kanalSayisi, kanal kodlari) sarar.
 */
import { Dvr } from './xiongmai-dvr.mjs';

export class Xiongmai extends Dvr {
  constructor(o) {
    super({ ...o, ayar: { ...o.ayar, port: o.ayar.port ?? 34567 } });
    this.kanalSayisi = Number(this.ayar.kanalSayisi ?? 4);
    this.etiket = this.ayar.etiket ?? 'C';
    this.akisMax = 10;                  // cihaz TCP baglanti siniri
  }

  async bilgi() {
    const b = await super.bilgi();
    return { ...b, kanalKodlar: b.kanalAdlari.map((_, i) => `${this.etiket}${i + 1}`), kanalKamera: [] };
  }
}
