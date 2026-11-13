/**
 * Xiongmai / NetSurveillance DVR-NVR surucusu (DVR-IP, TCP 34567): canli, kayitli oynatma, indirme, saat esitleme.
 * dvr.mjs/dvrip.mjs'deki Dvr sinifini cihaz grubunun bekledigi alanlarla (channelCount, kanal kodlari) sarar.
 * Canli MP4 ve /live cihazin RTSP'sinden (554; kimlik adreste: user=..&password=..): H.264, yeniden kodlanmaz.
 */
import { Dvr } from './xiongmai-dvr.mjs';
import { sharedMp4 } from './mp4-stream.mjs';

export class Xiongmai extends Dvr {
  constructor(o) {
    super({ ...o, setting: { ...o.setting, port: o.setting.port ?? 34567 } });
    this.channelCount = Number(this.setting.channelCount ?? 4);
    this.label = this.setting.label ?? 'C';
    this.rtspPort = Number(this.setting.rtspPort) || 554;
    this.streamMax = 10;                  // cihaz TCP baglanti siniri
  }

  async info() {
    const b = await super.info();
    return { ...b, channelCodes: b.channelNames.map((_, i) => `${this.label}${i + 1}`), channelCamera: [] };
  }

  rtspUrl(path) {
    const u = encodeURIComponent(this.setting.username), p = encodeURIComponent(this.setting.password);
    return `rtsp://${this.setting.host}:${this.rtspPort}/user=${u}&password=${p}&${path}`;
  }
  livePath(channel, type) { return `channel=${channel + 1}&stream=${type === 'Main' ? 0 : 1}.sdp?real_stream`; }

  /**
   * Canli MP4 (RtspDevice.feedMp4 ile ayni sozlesme, kanal/tur basina tek baglanti). Goruntu anamorfik (944x1080, 352x288): -aspect kapta en-boy
   * oranini verir, tarayici kareyi CAM_RATIO'ya (varsayilan 16:9) acar; kopya yayinda yeniden kodlama yok.
   */
  feedMp4(channel, type, convert = false, label = null) {
    return sharedMp4(this.feeds, {
      ffmpeg: this.ffmpeg, channel, type, convert,
      input: () => ['-rtsp_transport', 'tcp', '-i', this.rtspUrl(this.livePath(channel, type))],
      extra: this.ratio ? ['-aspect', this.ratio.join(':')] : [],
      label: label ?? ((cv) => `${this.setting.host} mp4:${channel}/${type}${cv ? '/h264' : ''}`),
    });
  }
}
