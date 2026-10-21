/**
 * Uniview NVR surucusu (LAPI + RTSP).
 * Canli: rtsp://.../unicast/c<N>/s<0|1>/live (H.265). Kayit: rtsp://.../c<N>/b<epoch>/e<epoch>/replay/.
 * Kayit listesi: cihaz yalniz gun bazinda "kayit var" bilgisi veriyor (DailyDistribution); gunler 15 dk'lik dilimlere bolunur.
 * Zaman: arayuz cihazin YEREL saatini kullanir; RTSP/LAPI epoch'u = yerel saat - cihaz saat dilimi (GMT+02:00 gibi).
 */
import { CihazTaban, digestIstek, yerelMetin, yerelSn } from './base.mjs';
import { RtspCihaz } from './rtsp.mjs';

const DILIM = 900;                       // kayit dilimi (sn)
const HAREKET_BITI = 4;

/**
 * Kayit parcalarindan hareketli araliklar (yerel saat metni). 132'li parca hareket olan kanalda cikar, hareketsiz alanda
 * hic cikmaz (cihazda hareket algilama acik, bolge ihlali kapali).
 * Olay parcasi = [hareket basi, hareket sonu + SON KAYIT] (kanal ayari, ornek 60 sn): parcanin tamami isaretlenince 3 sn'lik
 * hareket 70 sn gorunur. Son kayit dusulur. On kayit (10 sn) parcada YOK:
 * en kisa parca 64 sn < 10 + 60; goruntude de hareket parcanin ilk 4 sn'sinde, son 60 sn durgun.
 * Pencere sinirinda kesilen parca: sonu pencere sonundaysa hareket suruyor olabilir, dusulmez; basi pencere basindaysa ve
 * hareket pencereden once bitmisse atilir.
 */
export const univiewHareket = (parcalar, tzSn, sonKayit = 0, pencere = [-Infinity, Infinity]) => (parcalar ?? [])
  .filter((r) => r.RecordType & HAREKET_BITI && r.End > r.Begin)
  .map((r) => ({ b: r.Begin, e: r.End >= pencere[1] ? r.End : r.End - sonKayit }))
  .filter((r) => r.e > r.b || r.b > pencere[0])
  .map((r) => ({ bas: yerelMetin(r.b + tzSn), bit: yerelMetin(Math.max(r.e, r.b + 1) + tzSn) }));

export class Uniview extends RtspCihaz {
  constructor(o) {
    super(o);
    this.httpAna = `http://${this.ayar.ana}:${Number(this.ayar.httpPort ?? 80)}`;
    this.tzSn = 7200;                                  // cihaz saat dilimi; saatFarki() okuyunca guncellenir
    this.bitHizi = {};
    this.kanalSayisi = Number(this.ayar.kanalSayisi ?? 32);
    this.etiket = this.ayar.etiket ?? 'D';
  }

  async lapi(yol, yontem = 'GET', govde) {
    const { durum, metin } = await digestIstek(this.httpAna + yol, { kullanici: this.ayar.kullanici, parola: this.ayar.parola, yontem, govde: govde ? JSON.stringify(govde) : undefined });
    let j; try { j = JSON.parse(metin); } catch { throw new Error(`Cihaz yanıtı okunamadı (HTTP ${durum})`); }
    const y = j.Response;
    if (y?.ResponseCode !== 0) throw new Error(`Cihaz hatası: ${y?.ResponseString ?? durum}`);
    this.sonHata = null;
    return y.Data;
  }

  // ---------- saat ----------
  async saatFarki() {
    const t = await this.lapi('/LAPI/V1.0/System/Time');
    const m = /GMT([+-])(\d\d):(\d\d)/.exec(t.TimeZone ?? '');
    if (m) this.tzSn = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
    const yerel = t.DeviceTime + this.tzSn;
    const sunucu = CihazTaban.yerelZaman();
    this.cihazYerel = { sn: yerel, z: Date.now() };
    return { dvr: yerelMetin(yerel), sunucu, fark: Math.round(yerel - yerelSn(sunucu)) };
  }
  /** Cihaz saatini sunucu saatine (Europe/Istanbul) esitler. Saat dilimi ayari degismez; yalniz DeviceTime (cihazin UTC'si) ayarlanir. */
  async saatiSenkronla() {
    const once = await this.saatFarki();
    const t = await this.lapi('/LAPI/V1.0/System/Time');
    await this.lapi('/LAPI/V1.0/System/Time', 'PUT', { ...t, DeviceTime: Math.round(yerelSn(CihazTaban.yerelZaman())) - this.tzSn });
    await new Promise((r) => setTimeout(r, 1500));
    const sonra = await this.saatFarki();
    return { once: once.dvr, oncekiFark: once.fark, sonra: sonra.dvr, sunucu: sonra.sunucu, sonFark: sonra.fark };
  }
  /** Cihazin su anki yerel saati (sn): son okuma + gecen sure. */
  async cihazSimdi() {
    if (!this.cihazYerel || Date.now() - this.cihazYerel.z > 600_000) await this.saatFarki();
    return this.cihazYerel.sn + (Date.now() - this.cihazYerel.z) / 1000;
  }
  epoch(yerelMetinZ) { return Math.round(yerelSn(yerelMetinZ) - this.tzSn); }   // yerel metin -> cihaz epoch'u (RTSP/LAPI)

  // ---------- bilgi ----------
  async kanalAdlariYukle(kanal) {
    if (this.adOnbellek && Date.now() - this.adOnbellek.z < 3600_000) return this.adOnbellek.liste;
    const liste = new Array(kanal).fill(''), aygit = new Array(kanal).fill('');
    try {
      // NVR'in kanal listesi (cihaz arayuzundeki "D1 (Kanal adı)"): ad + bagli kameranin markasi/modeli/IP'si
      const d = await this.lapi('/LAPI/V1.0/Channels/System/ChannelDetailInfos');
      for (const c of d.DetailInfos ?? []) {
        const k = c.ID - 1; if (k < 0 || k >= kanal) continue;
        liste[k] = c.Name ?? '';
        aygit[k] = [c.Manufacturer, c.DeviceModel, c.AddressInfo?.Address].filter(Boolean).join(' · ');
      }
    } catch {}
    this.adOnbellek = { z: Date.now(), liste, aygit };
    this.kanalAdlari = liste;
    return liste;
  }

  async kayitDurumu() {
    if (this.durumOnbellek && Date.now() - this.durumOnbellek.z < 120_000) return this.durumOnbellek.v;
    const d = await this.lapi('/LAPI/V1.0/Channels/System/RecordStatus');
    const v = new Map((d.Statuses ?? []).map((s) => [s.ID, s]));
    for (const [id, s] of v) this.bitHizi[id - 1] = s.BitRate;
    this.durumOnbellek = { z: Date.now(), v };
    return v;
  }

  async bilgi() {
    const KANAL = this.kanalSayisi;
    const [aygit, saat, adlar, durum, diskVeri, gunTahmin] = await Promise.all([
      this.lapi('/LAPI/V1.0/System/DeviceInfo'),
      this.saatFarki(),
      this.kanalAdlariYukle(KANAL),
      this.kayitDurumu().catch(() => null),
      this.lapi('/LAPI/V1.0/Storage/Containers/DetailInfos').catch(() => null),
      this.lapi('/LAPI/V1.0/Channels/Media/Record/EstimatedDays').catch(() => null),
    ]);
    // Disk sagligi: LAPI yalniz durum kodu + sicaklik verir (SMART ayrintisi yok). 3 = calisiyor (kayit sirasinda saglikli diskte goruldu).
    const diskler = (diskVeri?.LocalHDDList ?? []).map((h) => ({
      ad: `Disk ${h.ID}`, uretici: h.Manufacturer ?? '', toplamMB: h.TotalCapacity ?? 0, bosMB: h.RemainCapacity ?? 0, sicaklik: h.Temperature ?? null,
      durum: h.Status === 3 ? ((h.Temperature ?? 0) > 60 ? 'hata' : (h.Temperature ?? 0) > 50 ? 'uyari' : 'iyi') : 'uyari',
      durumYazi: h.Status === 3 ? 'Normal' : `Durum kodu ${h.Status}`,
      kayitBas: null, kayitSon: null, mevcut: true,
    }));
    const k = aygit.BuildDate ?? {};
    return {
      kanalBos: await this.kanalBosDurum(KANAL),
      sunucuSaat: saat.sunucu,
      ana: this.ayar.ana, model: aygit.DeviceModel, surum: aygit.FirmwareVersion, seriNo: aygit.SerialNumber,
      derleme: k.Year ? `${k.Year}-${String(k.Month).padStart(2, '0')}-${String(k.Day).padStart(2, '0')}` : '',
      calismaSn: 0, saat: saat.dvr, kanal: KANAL,
      kanalAdlari: adlar.map((a, i) => a || `Kanal ${i + 1}`),
      kanalKodlar: adlar.map((_, i) => `${this.etiket}${i + 1}`),
      kanalKamera: this.adOnbellek?.aygit ?? [],
      diskMB: { toplam: diskler.reduce((a, x) => a + x.toplamMB, 0), bos: diskler.reduce((a, x) => a + x.bosMB, 0) },
      diskler, kayitGunTahmini: gunTahmin?.EstimatedDays ?? null,
      kayitAktif: durum ? [...durum.values()].filter((s) => s.RecordStatus === 1).length : null,
    };
  }

  /** Kayit durumu listesinde olmayan kanal (kamera tanimli degil) bostur. */
  async kanalBosDurum(kanal) {
    const zorla = new Set(this.ayar.gizliKanallar ?? []);
    try {
      const durum = await this.kayitDurumu();
      return Array.from({ length: kanal }, (_, k) => zorla.has(k) || !durum.has(k + 1));
    } catch { return Array.from({ length: kanal }, (_, k) => zorla.has(k)); }
  }

  // ---------- kayit listesi ----------
  async kayitlar(kanal, bas, bit) {
    const bGun = bas.slice(0, 10), eGun = bit.slice(0, 10);
    const simdi = await this.cihazSimdi();
    const gunler = [];
    for (let g = Date.parse(`${bGun}T00:00:00Z`); g <= Date.parse(`${eGun}T00:00:00Z`); g += 864e5) gunler.push(new Date(g).toISOString().slice(0, 10));
    const aylar = [...new Set(gunler.map((g) => g.slice(0, 7)))];
    const var_ = new Set();
    await Promise.all(aylar.map(async (ay) => {
      const [y, m] = ay.split('-').map(Number);
      const d = await this.lapi(`/LAPI/V1.0/Channels/${kanal + 1}/Media/Video/Streams/0/Records/DailyDistribution?Year=${y}&Month=${m}`);
      (d.DailyStatus ?? []).forEach((s, i) => { if (s) var_.add(`${ay}-${String(i + 1).padStart(2, '0')}`); });
    }));
    await this.kayitDurumu().catch(() => {});
    const hiz = (this.bitHizi[kanal] ?? 1500) * 125;     // kbit/sn -> bayt/sn (tahmini)
    const sonuc = [];
    for (const g of gunler) {
      if (!var_.has(g)) continue;
      const g0 = yerelSn(`${g} 00:00:00`);
      for (let b = g0; b < g0 + 86400; b += DILIM) {
        if (b >= simdi) break;
        const e = Math.min(b + DILIM, Math.floor(simdi));
        const bm = yerelMetin(b), em = yerelMetin(e);
        if (em < bas || bm > bit) continue;
        sonuc.push({ ad: `/nvr/c${kanal + 1}/${this.epoch(bm)}.h264`, bas: bm, bit: em, boyut: Math.round(hiz * (e - b)), tur: 'R' });
      }
    }
    return sonuc;
  }

  /** Hareketli araliklar (zaman cizelgesinde isaret). Cihazin kayit parcalarindan: tur 128 surekli, 132 = surekli + hareket (bit 4). */
  async hareketler(kanal, bas, bit) {
    await this.cihazSimdi();                             // saat dilimi guncel olsun (epoch <-> yerel)
    const b = this.epoch(bas), e = this.epoch(bit);
    const [d, sonKayit] = await Promise.all([this.lapi(`/LAPI/V1.0/Channels/${kanal + 1}/Media/Video/Streams/0/Records?Begin=${b}&End=${e}`), this.#sonKayit(kanal)]);
    return univiewHareket(d.RecordInfos, this.tzSn, sonKayit, [b, e]);
  }
  /** Kanalin son kayit suresi (sn; kayit plani). Saatte bir okunur; okunamazsa 0 (parca oldugu gibi) ve 5 dk sonra yeniden denenir. */
  async #sonKayit(kanal) {
    this.sonKayitBellek ??= new Map();
    const k = this.sonKayitBellek.get(kanal);
    if (k && Date.now() < k.son) return k.sn;
    let sn = 0, sure = 3_600_000;
    try { sn = Number((await this.lapi(`/LAPI/V1.0/Channels/${kanal + 1}/Storage/Private/Schedule/Record/`)).RecordRule?.PostRecordTime) || 0; }
    catch { sn = k?.sn ?? 0; sure = 300_000; }
    this.sonKayitBellek.set(kanal, { sn, son: Date.now() + sure });
    return sn;
  }

  // ---------- RTSP adresleri ----------
  canliYol(kanal, tur) { return `unicast/c${kanal + 1}/s${tur === 'Extra1' || tur === 'Mini' ? 1 : 0}/live`; }
  oynatYol(kanal, bas, bit) { return `c${kanal + 1}/b${this.epoch(bas)}/e${this.epoch(bit)}/replay/`; }
}
