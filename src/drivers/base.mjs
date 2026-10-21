/**
 * Cihaz tabani: tum cihaz suruculerinin (Uniview, Hikvision, grup) ortak parcalari.
 * Zaman kurali: arayuz cihazin YEREL saatini (goruntudeki yazi) kullanir. "yerel metin" = "YYYY-MM-DD HH:MM:SS";
 * yerelSn(metin) onu UTC gibi okuyup saniyeye cevirir (yalniz fark/dizge hesabi icin), yerelMetin(sn) tersi.
 */
export const yerelMetin = (sn) => new Date(sn * 1000).toISOString().slice(0, 19).replace('T', ' ');
export const yerelSn = (metin) => Date.parse(metin.replace(' ', 'T') + 'Z') / 1000;

const TR = { ı: 'i', İ: 'I', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ş: 's', Ş: 'S', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };

export class CihazTaban {
  constructor({ ayar, ffmpeg, veriKlasoru }) {
    this.ayar = ayar; this.ffmpeg = ffmpeg; this.veriKlasoru = veriKlasoru;
    this.yayinlar = new Map(); this.indirSayac = 0; this.oynatSayac = 0;
    this.kanalAdlari = null; this.sonHata = null; this.olay = null;
    this.oynatMax = Number(process.env.KAMERA_OYNATMA_MAX ?? 4);          // ayni anda cihazdan en fazla bu kadar kayit oynatma
    this.indirMax = Number(process.env.KAMERA_INDIRME_MAX ?? 2);          // ayni anda en fazla bu kadar indirme (digerleri sirada bekler)
    this.akisMax = Number(process.env.KAMERA_AKIS_MAX ?? 24);             // cihaz basina toplam eszamanli akis
  }

  static yerelZaman(d = new Date()) { return d.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }); }

  /** Goruntu orani [en, boy] ya da null (kaynak oranini koru). KAMERA_ORAN: "16:9" | "4:3" | "kaynak". */
  get oran() {
    const m = /^(\d+):(\d+)$/.exec(String(process.env.KAMERA_ORAN ?? this.ayar.oran ?? '16:9'));
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** ffmpeg olcek suzgeci: genislik w, oran duzeltilmis yukseklik. */
  olcek(w) { const o = this.oran; return o ? `scale=${w}:${Math.max(2, Math.round((w * o[1]) / o[0] / 2) * 2)}` : `scale='min(${w},iw)':-2`; }

  butceVar() { return this.yayinlar.size + this.oynatSayac + this.indirSayac < this.akisMax; }
  oynatabilir() { return this.oynatSayac < this.oynatMax && this.butceVar(); }
  indirabilir() { return this.indirSayac < this.indirMax && this.butceVar(); }

  /** Indirilen dosya adi: kamera adi + tarih + baslangic-bitis saati, Turkce karaktersiz: Kamera-1_2026-01-01_10.00.00-10.01.00.mp4 */
  indirAdi(kanal, kayit) {
    const ham = String(this.adlarGecersiz?.[kanal] || this.kanalAdlari?.[kanal] || `K${kanal + 1}`);
    const kamera = ham.replace(/[ıİğĞüÜşŞöÖçÇ]/g, (c) => TR[c]).replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || `K${kanal + 1}`;
    return `${kamera}_${kayit.bas.slice(0, 10)}_${kayit.bas.slice(11).replaceAll(':', '.')}-${kayit.bit.slice(11).replaceAll(':', '.')}.mp4`;
  }

  async saatiSenkronla() { throw new Error('Bu cihazın saati panelden ayarlanmıyor (cihazın kendi arayüzünden yapın)'); }
  async diskiTemizle() { throw new Error('Bu cihazda kayıt silme panelden yapılmıyor'); }
  kapat() { for (const y of [...this.yayinlar.values()]) y.durdur(); }
}

/** Digest kimlik dogrulamali HTTP istegi (Uniview LAPI ve Hikvision ISAPI ikisi de Digest kullanir). Dondurur { durum, metin }. */
import { createHash, randomBytes } from 'node:crypto';
const MD5 = (s) => createHash('md5').update(s).digest('hex');
export async function digestIstek(url, { kullanici, parola, yontem = 'GET', govde, tur, zamanAsimi = 15_000 }) {
  const u = new URL(url), yolKisim = u.pathname + u.search;
  const dene = (yetki) => fetch(url, {
    method: yontem, signal: AbortSignal.timeout(zamanAsimi), body: govde,
    headers: { ...(yetki ? { Authorization: yetki } : {}), ...(govde ? { 'Content-Type': tur ?? 'application/json' } : {}) },
  });
  let r = await dene();
  if (r.status === 401) {
    const k = Object.fromEntries([...(r.headers.get('www-authenticate') ?? '').matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const cnonce = randomBytes(8).toString('hex'), nc = '00000001';
    const ha1 = MD5(`${kullanici}:${k.realm}:${parola}`), ha2 = MD5(`${yontem}:${yolKisim}`);
    const yanit = k.qop ? MD5(`${ha1}:${k.nonce}:${nc}:${cnonce}:auth:${ha2}`) : MD5(`${ha1}:${k.nonce}:${ha2}`);
    r = await dene(`Digest username="${kullanici}", realm="${k.realm}", nonce="${k.nonce}", uri="${yolKisim}", response="${yanit}"${k.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${k.opaque ? `, opaque="${k.opaque}"` : ''}`);
    if (r.status === 401) throw new Error('Cihaz kullanıcı adı/parolayı reddetti');
  }
  return { durum: r.status, metin: await r.text() };
}
