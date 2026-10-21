/**
 * Denetim gunlugu hizmeti (veri/gunluk.jsonl): giris, indirme, oynatma, cihaz/uye/yetki degisiklikleri; istemci IP/port/UA ile.
 * Zincirleme imza: her kayit onceki kaydin imzasini ve kendi icerigini gizli anahtarla (HMAC) imzalar; araya kayit sokmak/silmek/degistirmek
 * zinciri bozar; dogrula() bunu denetler. Parola/anahtar gizlisi ASLA yazilmaz.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { istemciIp, temizIp } from '../core/http.mjs';

export class Gunluk {
  constructor(dosya, imzala, guvenilenIpBasligi = '') {
    this.dosya = dosya; this.imzala = imzala; this.guvenilenIpBasligi = guvenilenIpBasligi;
    this.sonImza = '';
    try { const s = readFileSync(dosya, 'utf8').trim().split('\n').filter(Boolean); if (s.length) this.sonImza = JSON.parse(s.at(-1)).imza ?? ''; } catch {}
  }

  /** olay, kullanici (gunluk adi: "ali" | "anahtar:ab12" | "sistem"), istek (null olabilir), ayrinti */
  yaz(olay, kullanici, istek, ayrinti = {}) {
    try {
      const simdi = new Date(), ileri = {};
      for (const b of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ray', 'cf-ipcountry']) if (istek?.headers[b]) ileri[b] = String(istek.headers[b]).slice(0, 120);
      const kayit = {
        z: simdi.toISOString(), yerel: `${simdi.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' })} Europe/Istanbul`,
        olay, kullanici,
        ip: istek ? istemciIp(istek, this.guvenilenIpBasligi) : null, port: istek?.socket.remotePort ?? null,
        yerelIp: istek ? temizIp(istek.socket.localAddress) : null, yerelPort: istek?.socket.localPort ?? null, tls: !!istek?.socket.encrypted,
        istek: istek ? `${istek.method} ${String(istek.url).split('?')[0]}`.slice(0, 200) : null,
        ...(Object.keys(ileri).length ? { ileri } : {}),
        ua: String(istek?.headers['user-agent'] ?? '').slice(0, 160),
        ...ayrinti,
        onceki: this.sonImza,
      };
      kayit.imza = this.imzala(this.sonImza + JSON.stringify(kayit));
      this.sonImza = kayit.imza;
      appendFileSync(this.dosya, JSON.stringify(kayit) + '\n');
    } catch (e) { console.error('gunluk yazilamadi', e.message); }
  }

  oku() { try { return readFileSync(this.dosya, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)); } catch { return []; } }

  /** Suzgec + sayfalama; en yeni ustte. */
  listele({ olay = '', kullanici = '', ip = '', gun = '', sayfa = 1, boyut = 50 }) {
    const k = kullanici.toLowerCase();
    const suz = this.oku().reverse().filter((g) => (!olay || g.olay === olay)
      && (!k || String(g.kullanici ?? '').toLowerCase().includes(k))
      && (!ip || String(g.ip ?? '').includes(ip) || JSON.stringify(g.ileri ?? '').includes(ip))
      && (!gun || String(g.yerel ?? g.z).startsWith(gun)));
    return { toplam: suz.length, sayfa, boyut, kayitlar: suz.slice((sayfa - 1) * boyut, sayfa * boyut) };
  }

  dogrula() {
    let onceki = '', n = 0, satirlar = [];
    try { satirlar = readFileSync(this.dosya, 'utf8').trim().split('\n').filter(Boolean); } catch { return { tamam: true, kayit: 0 }; }
    for (const s of satirlar) {
      n++;
      let k; try { k = JSON.parse(s); } catch { return { tamam: false, kayit: n, hata: `${n}. satır okunamıyor` }; }
      const { imza, ...gerisi } = k;
      if (k.onceki !== onceki || this.imzala(onceki + JSON.stringify(gerisi)) !== imza) return { tamam: false, kayit: n, hata: `${n}. kayıtta zincir bozuk (${k.z})` };
      onceki = imza;
    }
    return { tamam: true, kayit: n };
  }
}
