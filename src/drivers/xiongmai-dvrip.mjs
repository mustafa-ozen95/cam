/**
 * Xiongmai (XM / NetSurveillance / Sofia) "DVR-IP" protokolu, 34567 portu. Bagimliliksiz.
 * Paket: 20 bayt baslik (0xFF, surum, 2 yedek, oturum u32, sira u32, toplam, gecerli, mesajNo u16, uzunluk u32) + govde.
 */
import net from 'node:net';
import { createHash } from 'node:crypto';

const ALFA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function sofiaHash(parola) {
  const md5 = createHash('md5').update(parola, 'latin1').digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFA[(md5[2 * i] + md5[2 * i + 1]) % 62];
  return s;
}

export const MSJ = {
  GIRIS: 1000, SISTEM: 1020, AYAR_AL: 1042, DISK: 1020, IZLE_BASLAT: 1410, IZLE_VERI: 1412, IZLE_SAHIPLEN: 1413,
  OYNAT: 1420, OYNAT_SAHIPLEN: 1424, OYNAT_VERI: 1426, DOSYA_SORGU: 1440, YONETIM: 1450, KEEPALIVE: 1006, GENEL: 1450,
};

export class Baglanti {
  constructor(ana, kapı = 34567) { this.ana = ana; this.kapı = kapı; this.tampon = Buffer.alloc(0); this.sira = 0; this.oturum = 0; this.bekleyen = new Map(); this.veriDinleyici = null; }

  baglan(zamanAsimi = 5000) {
    return new Promise((coz, red) => {
      const s = (this.soket = net.createConnection({ host: this.ana, port: this.kapı }));
      s.setNoDelay(true);
      const t = setTimeout(() => { s.destroy(); red(new Error('Bağlantı zaman aşımı')); }, zamanAsimi);
      s.once('connect', () => { clearTimeout(t); coz(this); });
      s.once('error', (e) => { clearTimeout(t); red(e); });
      s.on('data', (b) => this.#al(b));
      s.on('close', () => { this.kapandi = true; for (const [, b] of this.bekleyen) b.red(new Error('Bağlantı kapandı')); this.bekleyen.clear(); this.kapanisDinleyici?.(); });
      s.on('error', () => {});
    });
  }

  #al(b) {
    this.tampon = this.tampon.length ? Buffer.concat([this.tampon, b]) : b;
    while (this.tampon.length >= 20) {
      const uz = this.tampon.readUInt32LE(16);
      if (this.tampon.length < 20 + uz) break;
      const msj = this.tampon.readUInt16LE(14);
      const govde = this.tampon.subarray(20, 20 + uz);
      this.tampon = this.tampon.subarray(20 + uz);
      if (this.veriDinleyici?.(msj, govde)) continue;
      const bek = this.bekleyen.get(msj - 1) ?? this.bekleyen.get(msj);
      if (bek) {
        this.bekleyen.delete(msj - 1); this.bekleyen.delete(msj); clearTimeout(bek.t);
        bek.coz({ msj, govde });
      }
    }
  }

  gonder(msj, nesne, govdeHam) {
    const g = govdeHam ?? Buffer.from(JSON.stringify(nesne) + '\n\0', 'utf8');
    const h = Buffer.alloc(20);
    h[0] = 0xff; h.writeUInt32LE(this.oturum, 4); h.writeUInt32LE(this.sira++, 8); h.writeUInt16LE(msj, 14); h.writeUInt32LE(g.length, 16);
    this.soket.write(Buffer.concat([h, g]));
  }

  /** Istek gonder, ayni numarali (+1) yaniti bekle. JSON dondurur. */
  istek(msj, nesne, zamanAsimi = 8000) {
    return new Promise((coz, red) => {
      const t = setTimeout(() => { this.bekleyen.delete(msj); red(new Error(`Yanıt gelmedi (${msj})`)); }, zamanAsimi);
      this.bekleyen.set(msj, { t, red, coz: ({ govde }) => { try { coz(JSON.parse(govde.toString('utf8').replace(/\0+$/, '').replace(/[\x00-\x09\x0b-\x1f]/g, ''))); } catch (e) { red(e); } } });
      this.gonder(msj, nesne);
    });
  }

  async giris(kullanici, parola) {
    const y = await this.istek(MSJ.GIRIS, { EncryptType: 'MD5', LoginType: 'DVRIP-Web', PassWord: sofiaHash(parola), UserName: kullanici });
    if (y.Ret !== 100 && y.Ret !== 515) throw new Error(`Giriş reddedildi (Ret ${y.Ret})`);
    this.oturum = parseInt(y.SessionID, 16);
    this.oturumKimlik = y.SessionID;
    this.bilgi = y;
    return y;
  }

  kapat() { try { this.soket?.destroy(); } catch {} }
}

/**
 * XM akisindan ham H.264 (Annex B) ayiklar: I (FC, 16 bayt baslik), P (FD, 8), ses (FA, 8), bilgi (F9, 8) cerceveleri.
 * Paket sinirlari cerceveyle ortusmez; tampon biriktirilir. Videoyu `video(buf)`, sesi `ses(buf)` ile verir.
 */
export class CerceveAyirici {
  constructor(video, ses) { this.video = video; this.ses = ses; this.t = Buffer.alloc(0); this.bilgi = { fps: 25, genislik: 0, yukseklik: 0 }; }
  ekle(b) {
    this.t = this.t.length ? Buffer.concat([this.t, b]) : b;
    let i = 0;
    const t = this.t;
    for (;;) {
      if (t.length - i < 8) break;
      if (t[i] !== 0 || t[i + 1] !== 0 || t[i + 2] !== 1) { // eşleşme kaybi: sonraki baslangic kodunu ara
        const j = t.indexOf(Buffer.from([0, 0, 1]), i + 1);
        if (j < 0) { i = t.length - 2; break; }
        i = j; continue;
      }
      const tur = t[i + 3];
      let baslik, uz;
      if (tur === 0xfc) { if (t.length - i < 16) break; baslik = 16; uz = t.readUInt32LE(i + 12); const fps = t[i + 5] & 0x1f; if (fps) this.bilgi.fps = fps; this.bilgi.genislik = t[i + 6] * 8; this.bilgi.yukseklik = t[i + 7] * 8; }
      else if (tur === 0xfd) { baslik = 8; uz = t.readUInt32LE(i + 4); }
      else if (tur === 0xfa || tur === 0xf9) { baslik = 8; uz = t.readUInt16LE(i + 6); }
      else { const j = t.indexOf(Buffer.from([0, 0, 1]), i + 1); if (j < 0) { i = t.length - 2; break; } i = j; continue; }
      if (uz > 4_000_000) { i += 4; continue; }
      if (t.length - i < baslik + uz) break;
      const yuk = t.subarray(i + baslik, i + baslik + uz);
      if (tur === 0xfc || tur === 0xfd) this.video(yuk); else if (tur === 0xfa) this.ses?.(yuk);
      i += baslik + uz;
    }
    this.t = this.t.subarray(Math.max(0, i));
  }
}
