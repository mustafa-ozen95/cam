/**
 * Tek IP kamera (RTSP): adres + kullanici + parola ile eklenir. Yalniz CANLI izleme ve anlik goruntu; kayit listesi/oynatma/indirme yoktur
 * (kayit kameranin kendi SD kartindaysa kameranin kendi arayuzunden izlenir). Marka sablonlari ana/alt akis adreslerini verir.
 */
import { spawn } from 'node:child_process';
import { RtspDevice } from './rtsp.mjs';
import { DeviceBase } from './base.mjs';

export const TEMPLATES = {
  hikvision: { name: 'Hikvision', host: 'Streaming/Channels/101', sub: 'Streaming/Channels/102' },
  dahua: { name: 'Dahua', host: 'cam/realmonitor?channel=1&subtype=0', sub: 'cam/realmonitor?channel=1&subtype=1' },
  uniview: { name: 'Uniview', host: 'unicast/c1/s0/live', sub: 'unicast/c1/s1/live' },
  custom: { name: 'Özel adres', host: '', sub: '' },
};

export class IpCamera extends RtspDevice {
  constructor(o) {
    super(o);
    this.channelCount = 1;
    this.label = this.setting.label ?? 'K';
    this.template = TEMPLATES[this.setting.template] ? this.setting.template : 'hikvision';
    this.check = null;     // { z, ok, hata }: kameraya erisim sonucu (bilgi() her 30 sn cagrilir; ffmpeg her seferinde calismasin)
  }

  getPath(type) {
    const s = TEMPLATES[this.template], custom = String(this.setting.path ?? '').replace(/^\/+/, '');
    if (this.template === 'custom') return custom;
    return type === 'Main' ? s.host : s.sub;      // Extra1 ve Mini alt akis
  }
  livePath(_channel, type) { return this.getPath(type); }

  /** Kameradan tek kare almayi dener (kimlik/adres/yol dogrulamasi). */
  #attempt() {
    return new Promise((resolve) => {
      const ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', this.rtspUrl(this.getPath('Extra1')), '-frames:v', '1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      ff.on('error', (e) => { clearTimeout(time); resolve({ ok: false, error: `ffmpeg başlatılamadı (${e.code ?? e.message})` }); });
      let error = ''; ff.stderr.on('data', (b) => { error += b; });
      const time = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 15_000);
      ff.on('close', (code) => { clearTimeout(time); resolve(code === 0 ? { ok: true } : { ok: false, error: /401|Unauthorized/i.test(error) ? 'kullanıcı adı/parola reddedildi' : /404|Not Found/i.test(error) ? 'RTSP adresi bulunamadı (yol/şablon yanlış olabilir)' : 'kameraya erişilemedi (adres/port kontrol edin)' }); });
    });
  }

  async info() {
    const fresh = !this.check || Date.now() - this.check.z > (this.check.ok ? 300_000 : 60_000);
    if (fresh) this.check = { z: Date.now(), ...(await this.#attempt()) };
    if (!this.check.ok) throw new Error(`Kameraya bağlanılamadı: ${this.check.error}`);
    const name = this.setting.name || this.setting.host;
    return {
      channelEmpty: [false], serverClock: DeviceBase.localTime(),
      host: this.setting.host, model: `IP Kamera · ${TEMPLATES[this.template].name}`, version: '—', serialNo: '—', build: '—',
      uptimeSec: 0, clock: null, channel: 1,
      channelNames: [name], channelCodes: [`${this.label}1`], channelCamera: [`${this.setting.host}`],
      diskMB: { total: 0, empty: 0 }, disks: [], recordDayEstimated: null,
    };
  }

  // kayit yok
  async records() { return []; }
  playMjpeg(res) { try { res.end(); } catch {} return null; }
  async pipeDownload(res, _k, _record, _name, onEnd) { try { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"hata":"Bu kameranın panelde kaydı yok"}'); } catch {} onEnd?.({ ok: false, byte: 0 }); }
  async syncClock() { throw new Error('Tek kamerada saat ayarı yok'); }
}
