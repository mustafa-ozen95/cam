/**
 * Denetim gunlugu hizmeti (audit_log tablosu): giris, indirme, oynatma, cihaz/uye/yetki degisiklikleri; istemci IP/port/UA ile.
 * Zincirleme imza: her kayit onceki kaydin imzasini ve kendi icerigini gizli anahtarla (HMAC) imzalar; araya kayit sokmak/silmek/degistirmek
 * zinciri bozar; dogrula() bunu denetler. Parola/anahtar gizlisi ASLA yazilmaz.
 *
 * Her kayit satir olarak yazilir: imzalanan JSON metni `record` sutununda birebir durur (dogrulama bunu okur); event, username, ip, ts, local_time
 * suzme icin ayri sutunlardadir. Ekleme sirasi TEK SIRALI kuyrukla korunur (imza zinciri): kuyrukta her kayit, oncekinin yazilmasini bekler.
 */
import { istemciIp, temizIp } from '../core/http.mjs';

const KAYAN = 500;   // dogrulama ve aktarimda bir seferde okunan satir

const likeKacis = (m) => String(m).replace(/[\\%_]/g, (x) => `\\${x}`);

export class Gunluk {
  constructor(vt, imzala, guvenilenIpBasligi = '') {
    this.vt = vt; this.imzala = imzala; this.guvenilenIpBasligi = guvenilenIpBasligi;
    this.sonImza = '';
    this.kuyruk = Promise.resolve();
  }

  /** Acilista zincirin son imzasi. */
  async yukle() {
    const [r] = await this.vt.havuz.query('SELECT signature FROM audit_log ORDER BY id DESC LIMIT 1');
    this.sonImza = r.length ? r[0].signature : '';
    return this;
  }

  /** Kuyrukta bekleyen tum yazimlar bitene kadar bekler (okuma/kapanis oncesi). */
  async bekle() { await this.kuyruk; }

  /**
   * olay, kullanici (gunluk adi: "ali" | "anahtar:ab12" | "sistem"), istek (null olabilir), ayrinti.
   * Dondurur: yazim sozu (true: yazildi). Veritabanina yazilamazsa sunucu gunlugune (stderr) bildirir ve false doner; cagiran beklemek zorunda degil.
   */
  yaz(olay, kullanici, istek, ayrinti = {}) {
    let govde;
    try {
      const simdi = new Date(), ileri = {};
      for (const b of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ray', 'cf-ipcountry']) if (istek?.headers[b]) ileri[b] = String(istek.headers[b]).slice(0, 120);
      govde = {
        z: simdi.toISOString(), yerel: `${simdi.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' })} Europe/Istanbul`,
        olay, kullanici,
        ip: istek ? istemciIp(istek, this.guvenilenIpBasligi) : null, port: istek?.socket.remotePort ?? null,
        yerelIp: istek ? temizIp(istek.socket.localAddress) : null, yerelPort: istek?.socket.localPort ?? null, tls: !!istek?.socket.encrypted,
        istek: istek ? `${istek.method} ${String(istek.url).split('?')[0]}`.slice(0, 200) : null,
        ...(Object.keys(ileri).length ? { ileri } : {}),
        ua: String(istek?.headers['user-agent'] ?? '').slice(0, 160),
        ...ayrinti,
      };
    } catch (e) { console.error('gunluk kaydi hazirlanamadi', e.message); return Promise.resolve(false); }
    const sira = this.kuyruk.then(async () => {
      const kayit = { ...govde, onceki: this.sonImza };
      kayit.imza = this.imzala(this.sonImza + JSON.stringify(kayit));
      await this.vt.havuz.query(
        'INSERT INTO audit_log (ts, local_time, event, username, ip, forwarded, previous_signature, signature, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [kayit.z, kayit.yerel ?? null, String(kayit.olay).slice(0, 100), kayit.kullanici == null ? null : String(kayit.kullanici).slice(0, 512), kayit.ip == null ? null : String(kayit.ip).slice(0, 100),
          kayit.ileri ? JSON.stringify(kayit.ileri) : null, kayit.onceki, kayit.imza, JSON.stringify(kayit)]);
      this.sonImza = kayit.imza;   // zincir yalniz yazim basarili olunca ilerler
      return true;
    }).catch((e) => { console.error('gunluk yazilamadi', e?.code ?? '', e?.message ?? e); return false; });
    this.kuyruk = sira;
    return sira;
  }

  /** Suzgec + sayfalama; en yeni ustte. */
  async listele({ olay = '', kullanici = '', ip = '', gun = '', sayfa = 1, boyut = 50 }) {
    await this.bekle();
    const kosul = [], p = [];
    if (olay) { kosul.push('event = ?'); p.push(olay); }
    if (kullanici) { kosul.push('username LIKE ?'); p.push(`%${likeKacis(kullanici)}%`); }
    if (ip) { kosul.push('(ip LIKE ? OR forwarded LIKE ?)'); p.push(`%${likeKacis(ip)}%`, `%${likeKacis(ip)}%`); }
    if (gun) { kosul.push('COALESCE(local_time, ts) LIKE ?'); p.push(`${likeKacis(gun)}%`); }
    const nerede = kosul.length ? `WHERE ${kosul.join(' AND ')}` : '';
    const [[t]] = await this.vt.havuz.query(`SELECT COUNT(*) AS n FROM audit_log ${nerede}`, p);
    const [satirlar] = await this.vt.havuz.query(`SELECT record FROM audit_log ${nerede} ORDER BY id DESC LIMIT ? OFFSET ?`, [...p, boyut, (sayfa - 1) * boyut]);
    return { toplam: Number(t.n), sayfa, boyut, kayitlar: satirlar.map((s) => JSON.parse(s.record)) };
  }

  /** Zinciri veritabanindaki kayitlardan dogrular (artan sirayla, parca parca okur). */
  async dogrula() {
    await this.bekle();
    let onceki = '', n = 0, son = 0;
    for (;;) {
      const [satirlar] = await this.vt.havuz.query('SELECT id, record FROM audit_log WHERE id > ? ORDER BY id LIMIT ?', [son, KAYAN]);
      if (!satirlar.length) break;
      for (const s of satirlar) {
        n++; son = s.id;
        let k; try { k = JSON.parse(s.record); } catch { return { tamam: false, kayit: n, hata: `${n}. satır okunamıyor` }; }
        const { imza, ...gerisi } = k;
        if (k.onceki !== onceki || this.imzala(onceki + JSON.stringify(gerisi)) !== imza) return { tamam: false, kayit: n, hata: `${n}. kayıtta zincir bozuk (${k.z})` };
        onceki = imza;
      }
    }
    return { tamam: true, kayit: n };
  }
}
