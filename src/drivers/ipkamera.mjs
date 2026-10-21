/**
 * Tek IP kamera (RTSP): adres + kullanici + parola ile eklenir. Yalniz CANLI izleme ve anlik goruntu; kayit listesi/oynatma/indirme yoktur
 * (kayit kameranin kendi SD kartindaysa kameranin kendi arayuzunden izlenir). Marka sablonlari ana/alt akis adreslerini verir.
 */
import { spawn } from 'node:child_process';
import { RtspCihaz } from './rtsp.mjs';
import { CihazTaban } from './taban.mjs';

export const SABLONLAR = {
  hikvision: { ad: 'Hikvision', ana: 'Streaming/Channels/101', alt: 'Streaming/Channels/102' },
  dahua: { ad: 'Dahua', ana: 'cam/realmonitor?channel=1&subtype=0', alt: 'cam/realmonitor?channel=1&subtype=1' },
  uniview: { ad: 'Uniview', ana: 'unicast/c1/s0/live', alt: 'unicast/c1/s1/live' },
  ozel: { ad: 'Özel adres', ana: '', alt: '' },
};

export class IpKamera extends RtspCihaz {
  constructor(o) {
    super(o);
    this.kanalSayisi = 1;
    this.etiket = this.ayar.etiket ?? 'K';
    this.sablon = SABLONLAR[this.ayar.sablon] ? this.ayar.sablon : 'hikvision';
    this.kontrol = null;     // { z, ok, hata }: kameraya erisim sonucu (bilgi() her 30 sn cagrilir; ffmpeg her seferinde calismasin)
  }

  yolAl(tur) {
    const s = SABLONLAR[this.sablon], ozel = String(this.ayar.yol ?? '').replace(/^\/+/, '');
    if (this.sablon === 'ozel') return ozel;
    return tur === 'Main' ? s.ana : s.alt;      // Extra1 ve Mini alt akis
  }
  canliYol(_kanal, tur) { return this.yolAl(tur); }

  /** Kameradan tek kare almayi dener (kimlik/adres/yol dogrulamasi). */
  #dene() {
    return new Promise((coz) => {
      const ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', this.rtspUrl(this.yolAl('Extra1')), '-frames:v', '1', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      ff.on('error', (e) => { clearTimeout(zaman); coz({ ok: false, hata: `ffmpeg başlatılamadı (${e.code ?? e.message})` }); });
      let hata = ''; ff.stderr.on('data', (b) => { hata += b; });
      const zaman = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 15_000);
      ff.on('close', (kod) => { clearTimeout(zaman); coz(kod === 0 ? { ok: true } : { ok: false, hata: /401|Unauthorized/i.test(hata) ? 'kullanıcı adı/parola reddedildi' : /404|Not Found/i.test(hata) ? 'RTSP adresi bulunamadı (yol/şablon yanlış olabilir)' : 'kameraya erişilemedi (adres/port kontrol edin)' }); });
    });
  }

  async bilgi() {
    const yeni = !this.kontrol || Date.now() - this.kontrol.z > (this.kontrol.ok ? 300_000 : 60_000);
    if (yeni) this.kontrol = { z: Date.now(), ...(await this.#dene()) };
    if (!this.kontrol.ok) throw new Error(`Kameraya bağlanılamadı: ${this.kontrol.hata}`);
    const ad = this.ayar.ad || this.ayar.ana;
    return {
      kanalBos: [false], sunucuSaat: CihazTaban.yerelZaman(),
      ana: this.ayar.ana, model: `IP Kamera · ${SABLONLAR[this.sablon].ad}`, surum: '—', seriNo: '—', derleme: '—',
      calismaSn: 0, saat: null, kanal: 1,
      kanalAdlari: [ad], kanalKodlar: [`${this.etiket}1`], kanalKamera: [`${this.ayar.ana}`],
      diskMB: { toplam: 0, bos: 0 }, diskler: [], kayitGunTahmini: null,
    };
  }

  // kayit yok
  async kayitlar() { return []; }
  oynatMjpeg(res) { try { res.end(); } catch {} return null; }
  async indirAkit(res, _k, _kayit, _ad, bitince) { try { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"hata":"Bu kameranın panelde kaydı yok"}'); } catch {} bitince?.({ tamam: false, bayt: 0 }); }
  async saatiSenkronla() { throw new Error('Tek kamerada saat ayarı yok'); }
}
