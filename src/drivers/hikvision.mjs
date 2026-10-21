/**
 * Hikvision NVR surucusu (ISAPI + RTSP).
 * Canli: rtsp://.../Streaming/Channels/<kanal*100+1|2> (1 = ana akis, 2 = alt akis). Kayit: .../Streaming/tracks/<kanal*100+1>?starttime=..Z&endtime=..Z
 * Kayit listesi: ISAPI /ContentMgmt/search gercek kayit araliklarini verir; araliklar 15 dk'lik dilimlere bolunur (liste/indirme icin).
 * Zaman: cihaz yerel saati "Z" ekiyle yazar ve okur (UTC degil); panel de yerel saat kullanir, donusum gerekmez.
 */
import { CihazTaban, digestIstek, yerelMetin, yerelSn } from './base.mjs';
import { RtspCihaz } from './rtsp.mjs';

const DILIM = 900;
const coz = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const al = (xml, etiket) => { const m = new RegExp(`<${etiket}>([^<]*)</${etiket}>`).exec(xml); return m ? coz(m[1]).trim() : ''; };
const bloklar = (xml, etiket) => [...xml.matchAll(new RegExp(`<${etiket}[\\s>][\\s\\S]*?</${etiket}>`, 'g'))].map((m) => m[0]);
/**
 * Olay gunlugundeki hareket baslangic/bitislerinden kanal basina araliklar. Kayit surekli (CMR) oldugu icin kayit aramasi
 * hareketi ayirmiyor; NVR gunlugu ayiriyor: metaId "log.hikvision.com/Alarm/motionStart/7" (7 = kanal no, 1'den).
 * Bitisi gelmemis baslangic: aralik sonuna (ya da su ana) kadar; baslangici araliktan once kalan bitis: aralik basindan.
 */
export function hikHareketEslestir(olaylar, bas, bit) {
  const kanallar = new Map();
  for (const o of [...olaylar].sort((x, y) => x.t.localeCompare(y.t))) {
    const k = kanallar.get(o.kanal) ?? { acik: null, araliklar: [] };
    kanallar.set(o.kanal, k);
    if (o.basla) { if (k.acik === null) k.acik = o.t; }
    else { k.araliklar.push({ bas: k.acik ?? bas, bit: o.t }); k.acik = null; }
  }
  for (const k of kanallar.values()) if (k.acik !== null) k.araliklar.push({ bas: k.acik, bit });
  return new Map([...kanallar].map(([n, k]) => [n, k.araliklar.filter((a) => a.bit > a.bas)]));
}
const HAREKET_OLAY = /\/Alarm\/motion(Start|Stop)\/(\d+)$/;
const rtspZaman = (yerel) => `${yerel.slice(0, 10).replaceAll('-', '')}T${yerel.slice(11, 19).replaceAll(':', '')}Z`;

export class Hikvision extends RtspCihaz {
  constructor(o) {
    super(o);
    this.httpAna = `http://${this.ayar.ana}:${Number(this.ayar.httpPort ?? 80)}`;
    this.kanalSayisi = Number(this.ayar.kanalSayisi ?? 16);
    this.etiket = this.ayar.etiket ?? 'H';
  }

  async isapi(yol, yontem = 'GET', xml) {
    const { durum, metin } = await digestIstek(this.httpAna + yol, { kullanici: this.ayar.kullanici, parola: this.ayar.parola, yontem, govde: xml, tur: 'application/xml' });
    if (durum >= 400) throw new Error(`Cihaz hatası: HTTP ${durum}`);
    this.sonHata = null;
    return metin;
  }

  // ---------- saat ----------
  async saatFarki() {
    const t = await this.isapi('/ISAPI/System/time');
    const yerel = al(t, 'localTime').slice(0, 19).replace('T', ' ');          // 2026-10-05T10:48:16+03:00 -> cihaz yerel saati
    if (!yerel) throw new Error('Cihaz saati okunamadı');
    const sunucu = CihazTaban.yerelZaman();
    this.cihazYerel = { sn: yerelSn(yerel), z: Date.now() };
    return { dvr: yerel, sunucu, fark: Math.round(yerelSn(yerel) - yerelSn(sunucu)) };
  }
  /** Cihaz saatini sunucu saatine esitler. Cihaz NTP modundaysa elle (manual) moda gecer: NTP kaynagi sapmaliysa ayar kalici olarak elle olur. */
  async saatiSenkronla() {
    const once = await this.saatFarki();
    const t = await this.isapi('/ISAPI/System/time');
    const ofset = /([+-]\d\d:\d\d)$/.exec(al(t, 'localTime'))?.[1] ?? '+03:00', tz = al(t, 'timeZone') || 'CST-3:00:00';
    const xml = `<Time version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><timeMode>manual</timeMode><localTime>${CihazTaban.yerelZaman().replace(' ', 'T')}${ofset}</localTime><timeZone>${tz}</timeZone></Time>`;
    const y = await this.isapi('/ISAPI/System/time', 'PUT', xml);
    if (al(y, 'statusCode') !== '1') throw new Error(`Cihaz saati ayarlamadı (${al(y, 'statusString') || 'bilinmeyen hata'})`);
    await new Promise((r) => setTimeout(r, 1500));
    const sonra = await this.saatFarki();
    return { once: once.dvr, oncekiFark: once.fark, sonra: sonra.dvr, sunucu: sonra.sunucu, sonFark: sonra.fark };
  }
  async cihazSimdi() {
    if (!this.cihazYerel || Date.now() - this.cihazYerel.z > 600_000) await this.saatFarki();
    return this.cihazYerel.sn + (Date.now() - this.cihazYerel.z) / 1000;
  }

  // ---------- bilgi ----------
  async kanallar() {
    if (this.kanalOnbellek && Date.now() - this.kanalOnbellek.z < 300_000) return this.kanalOnbellek.v;
    const n = this.kanalSayisi;
    const ad = new Array(n).fill(''), kamera = new Array(n).fill(''), cevrimici = new Array(n).fill(false), tanimli = new Array(n).fill(false);
    const liste = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels');
    for (const b of bloklar(liste, 'InputProxyChannel')) {
      const k = Number(al(b, 'id')) - 1; if (!(k >= 0 && k < n)) continue;
      tanimli[k] = true; ad[k] = al(b, 'name');
      kamera[k] = ['Hikvision', al(b, 'model'), al(b, 'ipAddress')].filter(Boolean).join(' · ');
    }
    try {
      const durum = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels/status');
      for (const b of bloklar(durum, 'InputProxyChannelStatus')) { const k = Number(al(b, 'id')) - 1; if (k >= 0 && k < n) cevrimici[k] = al(b, 'online') === 'true'; }
    } catch { cevrimici.fill(true); }
    const v = { ad, kamera, cevrimici, tanimli };
    this.kanalOnbellek = { z: Date.now(), v };
    this.kanalAdlari = ad;
    return v;
  }

  async bilgi() {
    const n = this.kanalSayisi;
    const [aygit, saat, kanal, depo] = await Promise.all([
      this.isapi('/ISAPI/System/deviceInfo'),
      this.saatFarki(),
      this.kanallar(),
      this.isapi('/ISAPI/ContentMgmt/Storage').catch(() => ''),
    ]);
    // Disk sagligi: cihazin SMART ozeti (sicaklik, calisma gunu, oz degerlendirme, bozuk/yeniden atanan sektor)
    const diskler = await Promise.all(bloklar(depo, 'hdd').map(async (h) => {
      const id = al(h, 'id'), durum = al(h, 'status'), tp = Number(al(h, 'capacity')) || 0;
      const sm = await this.isapi(`/ISAPI/ContentMgmt/Storage/hdd/${id}/SMARTTest/status`).catch(() => '');
      const sic = sm && al(sm, 'temprature') !== '' ? Number(al(sm, 'temprature')) : null;
      const gun = sm && al(sm, 'powerOnDay') !== '' ? Number(al(sm, 'powerOnDay')) : null;
      const oz = al(sm, 'selfEvaluaingStatus');
      const oznitelikler = bloklar(sm, 'TestResult');
      const bozuk = oznitelikler.filter((a) => al(a, 'attributeID') !== '0' && !['ok', 'illegal'].includes(al(a, 'status'))).length;   // id 0 / illegal = bos oznitelik yuvasi
      const ham = (no) => Number(al(oznitelikler.find((a) => al(a, 'attributeID') === String(no)) ?? '', 'rawValue')) || 0;
      const atanan = ham(5), bekleyen = ham(197), duzeltilemeyen = ham(198);
      const hata = durum !== 'ok' || (oz && oz !== 'ok') || (sic ?? 0) > 60;
      const uyari = (sic ?? 0) > 50 || bozuk > 0 || atanan > 0 || bekleyen > 0 || duzeltilemeyen > 0;
      const ayrinti = sm ? [`SMART: ${oz || '—'}`, gun !== null ? `${gun} gün çalışıyor` : '', `yeniden atanan sektör ${atanan}`, bekleyen ? `bekleyen sektör ${bekleyen}` : '', duzeltilemeyen ? `düzeltilemeyen ${duzeltilemeyen}` : '', bozuk ? `${bozuk} SMART özniteliği eşik dışı` : ''].filter(Boolean).join(' · ') : 'SMART okunamadı';
      return {
        ad: `Disk ${id}`, uretici: al(h, 'hddType'), toplamMB: tp, bosMB: Number(al(h, 'freeSpace')) || 0, sicaklik: sic, calismaGun: gun,
        durum: hata ? 'hata' : uyari ? 'uyari' : 'iyi', durumYazi: hata ? 'Arıza' : uyari ? 'Dikkat' : 'Normal', ayrinti,
        kayitBas: null, kayitSon: null, mevcut: true,
      };
    }));
    const zorla = new Set(this.ayar.gizliKanallar ?? []);
    return {
      kanalBos: Array.from({ length: n }, (_, k) => zorla.has(k) || !kanal.tanimli[k] || !kanal.cevrimici[k]),
      sunucuSaat: saat.sunucu,
      ana: this.ayar.ana, model: al(aygit, 'model'), surum: `${al(aygit, 'firmwareVersion')} ${al(aygit, 'firmwareReleasedDate')}`.trim(), seriNo: al(aygit, 'serialNumber'),
      derleme: al(aygit, 'firmwareReleasedDate'),
      calismaSn: 0, saat: saat.dvr, kanal: n,
      kanalAdlari: kanal.ad.map((a, i) => a || `Kanal ${i + 1}`),
      kanalKodlar: kanal.ad.map((_, i) => `${this.etiket}${i + 1}`),
      kanalKamera: kanal.kamera,
      diskMB: { toplam: diskler.reduce((a, x) => a + x.toplamMB, 0), bos: diskler.reduce((a, x) => a + x.bosMB, 0) },
      diskler, kayitGunTahmini: null,
    };
  }

  /**
   * NVR'a IP kamera kaydeder (kayit NVR'da yapilir). Bos kanal numarasi (1..kanalSayisi) otomatik secilir; yalniz EKLER, mevcut kanallara dokunmaz.
   * protokol: HIKVISION (port 8000) ya da ONVIF (port 80). Dondurur { kanal (0 tabanli yerel), cevrimici }.
   */
  async kameraEkle({ ad, ip, kullanici, parola, protokol = 'HIKVISION', port }) {
    if (!['HIKVISION', 'ONVIF'].includes(protokol)) throw new Error('Protokol geçersiz');
    const xml = (m) => String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const liste = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels');
    const dolu = new Set(bloklar(liste, 'InputProxyChannel').map((b) => Number(al(b, 'id'))));
    if ([...dolu].some((id) => al(bloklar(liste, 'InputProxyChannel').find((b) => Number(al(b, 'id')) === id) ?? '', 'ipAddress') === ip)) throw new Error('Bu IP adresli bir kamera NVR\'da zaten kayıtlı');
    let id = 0; for (let i = 1; i <= this.kanalSayisi; i++) if (!dolu.has(i)) { id = i; break; }
    if (!id) throw new Error('NVR\'da boş kanal yok');
    const govde = `<InputProxyChannel version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><id>${id}</id><name>${xml(ad)}</name><sourceInputPortDescriptor><proxyProtocol>${protokol}</proxyProtocol><addressingFormatType>ipaddress</addressingFormatType><ipAddress>${xml(ip)}</ipAddress><managePortNo>${Number(port) || (protokol === 'ONVIF' ? 80 : 8000)}</managePortNo><srcInputPort>1</srcInputPort><userName>${xml(kullanici)}</userName><password>${xml(parola)}</password><streamType>auto</streamType></sourceInputPortDescriptor></InputProxyChannel>`;
    const y = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels', 'POST', govde);
    if (al(y, 'statusCode') && al(y, 'statusCode') !== '1') throw new Error(`NVR kamerayı kabul etmedi (${al(y, 'statusString') || 'bilinmeyen hata'})`);
    this.kanalOnbellek = null;
    await new Promise((r) => setTimeout(r, 4000));                       // NVR kameraya baglanip durumu guncellesin
    const k = await this.kanallar().catch(() => null);
    return { kanal: id - 1, cevrimici: !!k?.cevrimici[id - 1] };
  }

  // ---------- kayit listesi ----------
  async kayitlar(kanal, bas, bit) {
    const iz = (kanal + 1) * 100 + 1;
    const aralik = [];
    for (let konum = 0, tur = 0; tur < 60; tur++) {
      const xml = `<CMSearchDescription><searchID>{${crypto.randomUUID().toUpperCase()}}</searchID><trackIDList><trackID>${iz}</trackID></trackIDList>`
        + `<timeSpanList><timeSpan><startTime>${bas.replace(' ', 'T')}Z</startTime><endTime>${bit.replace(' ', 'T')}Z</endTime></timeSpan></timeSpanList>`
        + `<maxResults>40</maxResults><searchResultPostion>${konum}</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
      const y = await this.isapi('/ISAPI/ContentMgmt/search', 'POST', xml);
      const ogeler = bloklar(y, 'searchMatchItem');
      for (const o of ogeler) {
        const b = al(o, 'startTime').slice(0, 19).replace('T', ' '), e = al(o, 'endTime').slice(0, 19).replace('T', ' ');
        const boyut = Number(/[?&;]size=(\d+)/.exec(coz(al(o, 'playbackURI')))?.[1]) || 0;
        if (b && e && e > b) aralik.push({ b, e, boyut });
      }
      if (ogeler.length < 40 || al(y, 'responseStatusStrg') !== 'MORE') break;
      konum += ogeler.length;
    }
    // gercek araliklar 15 dk dilimlere bolunur (dilim sinirlari duvar saatine hizali)
    const sonuc = [];
    for (const a of aralik) {
      const as = yerelSn(a.b), ae = yerelSn(a.e), sure = ae - as;
      for (let t = as; t < ae; t = (Math.floor(t / DILIM) + 1) * DILIM) {
        const bitis = Math.min(ae, (Math.floor(t / DILIM) + 1) * DILIM);
        const bm = yerelMetin(t), em = yerelMetin(bitis);
        if (em < bas || bm > bit) continue;
        sonuc.push({ ad: `/hik/c${kanal + 1}/${t}.h264`, bas: bm, bit: em, boyut: Math.round(a.boyut * ((bitis - t) / sure)), tur: 'R' });
      }
    }
    return sonuc.sort((x, y) => x.bas.localeCompare(y.bas));
  }

  /**
   * Hareketli araliklar (zaman cizelgesinde isaret). Gunluk cihazin tamami icin tek: ayni gun icin her kanal ayri sorsa da
   * cihaz bir kez taranir (bugun 30 sn, gecmis gun 10 dk saklanir).
   */
  async hareketler(kanal, bas, bit) {
    this.hareketBellek ??= new Map();
    const anahtar = `${bas}|${bit}`, simdi = Date.now();
    for (const [a, v] of this.hareketBellek) if (v.son < simdi) this.hareketBellek.delete(a);
    let k = this.hareketBellek.get(anahtar);
    if (!k) {
      // Bitisi gelmemis hareket su ana kadar (gun sonuna uzayip gelecegi isaretlemesin)
      const cihazSimdi = yerelMetin(Math.floor(await this.cihazSimdi())), bugun = bit >= cihazSimdi;
      k = { son: simdi + (bugun ? 30_000 : 600_000), soz: this.#hareketTara(bas, bit, bugun ? cihazSimdi : bit) };
      this.hareketBellek.set(anahtar, k);
      k.soz.catch(() => this.hareketBellek.delete(anahtar));
    }
    return (await k.soz).get(kanal + 1) ?? [];
  }
  async #hareketTara(bas, bit, acikSon) {
    const olaylar = [];
    for (let konum = 0, tur = 0; tur < 200; tur++) {
      const xml = `<CMSearchDescription><searchID>{${crypto.randomUUID().toUpperCase()}}</searchID><metaId>log.std-cgi.com/Alarm</metaId>`
        + `<timeSpanList><timeSpan><startTime>${bas.replace(' ', 'T')}Z</startTime><endTime>${bit.replace(' ', 'T')}Z</endTime></timeSpan></timeSpanList>`
        + `<maxResults>50</maxResults><searchResultPostion>${konum}</searchResultPostion></CMSearchDescription>`;
      const y = await this.isapi('/ISAPI/ContentMgmt/logSearch', 'POST', xml);
      const ogeler = bloklar(y, 'searchMatchItem');
      for (const o of ogeler) {
        const m = HAREKET_OLAY.exec(al(o, 'metaId')), t = al(o, 'StartDateTime').slice(0, 19).replace('T', ' ');
        if (m && t) olaylar.push({ kanal: Number(m[2]), basla: m[1] === 'Start', t });
      }
      if (!ogeler.length || al(y, 'responseStatusStrg') !== 'MORE') break;
      konum += ogeler.length;
    }
    return hikHareketEslestir(olaylar, bas, acikSon);
  }

  // ---------- RTSP adresleri ----------
  canliYol(kanal, tur) { return `Streaming/Channels/${(kanal + 1) * 100 + (tur === 'Extra1' || tur === 'Mini' ? 2 : 1)}`; }
  oynatYol(kanal, bas, bit) { return `Streaming/tracks/${(kanal + 1) * 100 + 1}?starttime=${rtspZaman(bas)}&endtime=${rtspZaman(bit)}`; }
}
