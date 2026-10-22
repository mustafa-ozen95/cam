/**
 * Xiongmai / NetSurveillance DVR-NVR surucusu (DVR-IP, TCP 34567): canli, kayitli oynatma, indirme, saat esitleme.
 * dvr.mjs/dvrip.mjs'deki Dvr sinifini cihaz grubunun bekledigi alanlarla (channelCount, kanal kodlari) sarar.
 */
import { Dvr } from './xiongmai-dvr.mjs';

export class Xiongmai extends Dvr {
  constructor(o) {
    super({ ...o, setting: { ...o.setting, port: o.setting.port ?? 34567 } });
    this.channelCount = Number(this.setting.channelCount ?? 4);
    this.label = this.setting.label ?? 'C';
    this.streamMax = 10;                  // cihaz TCP baglanti siniri
  }

  async info() {
    const b = await super.info();
    return { ...b, channelCodes: b.channelNames.map((_, i) => `${this.label}${i + 1}`), channelCamera: [] };
  }
}
