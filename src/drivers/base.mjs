/**
 * Cihaz tabani: tum cihaz suruculerinin (Uniview, Hikvision, grup) ortak parcalari.
 * Zaman kurali: arayuz cihazin YEREL saatini (goruntudeki yazi) kullanir. "yerel metin" = "YYYY-MM-DD HH:MM:SS";
 * localSec(metin) onu UTC gibi okuyup saniyeye cevirir (yalniz fark/dizge hesabi icin), localText(sn) tersi.
 */
export const localText = (sec) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
export const localSec = (text) => Date.parse(text.replace(' ', 'T') + 'Z') / 1000;

const TR = { ı: 'i', İ: 'I', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ş: 's', Ş: 'S', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };

export class DeviceBase {
  constructor({ setting, ffmpeg, dataDir }) {
    this.setting = setting; this.ffmpeg = ffmpeg; this.dataDir = dataDir;
    this.feeds = new Map(); this.downloadCounter = 0; this.playCounter = 0;
    this.channelNames = null; this.lastError = null; this.event = null;
    this.playMax = Number(process.env.CAM_PLAYBACK_MAX ?? 4);          // ayni anda cihazdan en fazla bu kadar kayit oynatma
    this.downloadMax = Number(process.env.CAM_DOWNLOAD_MAX ?? 2);          // ayni anda en fazla bu kadar indirme (digerleri sirada bekler)
    this.streamMax = Number(process.env.CAM_STREAM_MAX ?? 24);             // cihaz basina toplam eszamanli akis
  }

  static localTime(d = new Date()) { return d.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }); }

  /** Goruntu orani [en, boy] ya da null (kaynak oranini koru). CAM_RATIO: "16:9" | "4:3" | "kaynak". */
  get ratio() {
    const m = /^(\d+):(\d+)$/.exec(String(process.env.CAM_RATIO ?? this.setting.ratio ?? '16:9'));
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** ffmpeg olcek suzgeci: genislik w, oran duzeltilmis yukseklik. */
  scale(w) { const o = this.ratio; return o ? `scale=${w}:${Math.max(2, Math.round((w * o[1]) / o[0] / 2) * 2)}` : `scale='min(${w},iw)':-2`; }

  budgetVar() { return this.feeds.size + this.playCounter + this.downloadCounter < this.streamMax; }
  canPlay() { return this.playCounter < this.playMax && this.budgetVar(); }
  canDownload() { return this.downloadCounter < this.downloadMax && this.budgetVar(); }

  /** Indirilen dosya adi: kamera adi + tarih + baslangic-bitis saati, Turkce karaktersiz: Kamera-1_2026-01-01_10.00.00-10.01.00.mp4 */
  downloadName(channel, record) {
    const raw = String(this.nameOverrides?.[channel] || this.channelNames?.[channel] || `K${channel + 1}`);
    const camera = raw.replace(/[ıİğĞüÜşŞöÖçÇ]/g, (c) => TR[c]).replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || `K${channel + 1}`;
    return `${camera}_${record.from.slice(0, 10)}_${record.from.slice(11).replaceAll(':', '.')}-${record.to.slice(11).replaceAll(':', '.')}.mp4`;
  }

  async syncClock() { throw new Error('Bu cihazın saati panelden ayarlanmıyor (cihazın kendi arayüzünden yapın)'); }
  async diskClear() { throw new Error('Bu cihazda kayıt silme panelden yapılmıyor'); }
  close() { for (const y of [...this.feeds.values()]) y.stop(); }
}

/** Digest kimlik dogrulamali HTTP istegi (Uniview LAPI ve Hikvision ISAPI ikisi de Digest kullanir). Dondurur { durum, metin }. */
import { createHash, randomBytes } from 'node:crypto';
const MD5 = (s) => createHash('md5').update(s).digest('hex');
export async function requestDigest(url, { username, password, method = 'GET', body, type, timeOverflow = 15_000 }) {
  const u = new URL(url), pathPart = u.pathname + u.search;
  const attempt = (permissions) => fetch(url, {
    method: method, signal: AbortSignal.timeout(timeOverflow), body: body,
    headers: { ...(permissions ? { Authorization: permissions } : {}), ...(body ? { 'Content-Type': type ?? 'application/json' } : {}) },
  });
  let r = await attempt();
  if (r.status === 401) {
    const k = Object.fromEntries([...(r.headers.get('www-authenticate') ?? '').matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const cnonce = randomBytes(8).toString('hex'), nc = '00000001';
    const ha1 = MD5(`${username}:${k.realm}:${password}`), ha2 = MD5(`${method}:${pathPart}`);
    const response = k.qop ? MD5(`${ha1}:${k.nonce}:${nc}:${cnonce}:auth:${ha2}`) : MD5(`${ha1}:${k.nonce}:${ha2}`);
    r = await attempt(`Digest username="${username}", realm="${k.realm}", nonce="${k.nonce}", uri="${pathPart}", response="${response}"${k.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${k.opaque ? `, opaque="${k.opaque}"` : ''}`);
    if (r.status === 401) throw new Error('Cihaz kullanıcı adı/parolayı reddetti');
  }
  return { status: r.status, text: await r.text() };
}
