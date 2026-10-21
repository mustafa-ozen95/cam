/**
 * Yetkilendirme cekirdegi (saf mantik; HTTP'den bagimsiz, birim testli).
 *
 *  - IZINLER: ince taneli izin katalogu ("grup.eylem"); "*" her sey, "grup.*" bir grubun tumu.
 *  - ROLLER: yerlesik (degismez) + ozel roller (veri/yetki.json).
 *  - KAPSAM: kamera erisim listesi { cihazlar:[id], kanallar:[n] }; null = kisitsiz.
 *  - API ANAHTARLARI: kp_<id>_<gizli>; yalniz HMAC ozeti saklanir, gizli bir kez gosterilir; sona erme, IP/CIDR listesi, hiz siniri, eszamanli akis siniri.
 *  - HIZ SINIRI ve kimlik dogrulama hata kisiti (IP basina kaba kuvvet korumasi).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export class YetkiHatasi extends Error {
  /** kod: makine okunur (YETKI_YOK...), durum: HTTP kodu, ekstra: yanita eklenecek alanlar */
  constructor(kod, mesaj, durum = 403, ekstra = {}) { super(mesaj); this.kod = kod; this.durum = durum; this.ekstra = ekstra; }
}

// ---------------------------------------------------------------- izinler ve roller
export const IZINLER = {
  'canli.izle': { grup: 'izleme', tr: 'Canlı görüntü ve anlık görüntü (kare)', en: 'Live view and snapshots' },
  'kayit.listele': { grup: 'izleme', tr: 'Kayıt listesini görme', en: 'List recordings' },
  'kayit.izle': { grup: 'izleme', tr: 'Kayıttan oynatma', en: 'Play back recordings' },
  'kayit.indir': { grup: 'izleme', tr: 'Kayıt indirme', en: 'Download recordings' },
  'cihaz.oku': { grup: 'cihaz', tr: 'Cihaz, disk ve saat bilgisini görme', en: 'View device, disk and clock information' },
  'cihaz.saat': { grup: 'cihaz', tr: 'Cihaz saatini sunucu saatine eşitleme', en: 'Synchronise device clocks to the server clock' },
  'cihaz.yonet': { grup: 'cihaz', tr: 'Cihaz ekleme/düzenleme/silme ve NVR\'a kamera ekleme', en: 'Add, edit and remove devices; add cameras to NVRs' },
  'kanal.yonet': { grup: 'cihaz', tr: 'Kanal adı ve görünürlük ayarı', en: 'Edit channel names and visibility' },
  'uye.yonet': { grup: 'yonetim', tr: 'Üyeleri yönetme', en: 'Manage members' },
  'gunluk.oku': { grup: 'yonetim', tr: 'Denetim günlüğünü okuma ve doğrulama', en: 'Read and verify the audit log' },
  'yetki.yonet': { grup: 'yonetim', tr: 'Rolleri ve tüm API anahtarlarını yönetme', en: 'Manage roles and all API keys' },
  'api.anahtar': { grup: 'yonetim', tr: 'Yalnız kendi API anahtarlarını yönetme', en: 'Manage own API keys only' },
  'guncelleme.denetle': { grup: 'yonetim', tr: 'Güncelleme durumunu görme ve kontrol etme', en: 'View and check for updates' },
};
export const IZIN_GRUPLARI = {
  izleme: { tr: 'İzleme', en: 'Viewing' },
  cihaz: { tr: 'Cihaz', en: 'Devices' },
  yonetim: { tr: 'Yönetim', en: 'Administration' },
};

/**
 * YERLESIK ROLLER = DC PANELLERININ ROLLERI.
 * Kimlikler KYM/EYS ile ayni (admin, network, teknik, muhasebe, kamera): merkezdeki rol buraya birebir eslenir.
 *
 * admin her seyi yapar ve degismez. Digerlerinin izinleri BOS dogar
 * ve panelden verilir (Yetki → Roller → Düzenle): ad/kimlik sabit, yalniz izin listesi degisir ve yetki.json'da
 * saklanir (veri.yerlesikIzinler). Bos izinli role sahip uye giris yapar ama hicbir bolum gormez.
 */
export const YERLESIK_ROLLER = {
  admin: { ad: { tr: 'Yönetici', en: 'Administrator' }, aciklama: { tr: 'Her şeyi yapar.', en: 'Can do everything.' }, izinler: ['*'], yerlesik: true },
  network: { ad: { tr: 'Network', en: 'Network' }, aciklama: { tr: 'Ağ ekibi. İzinleri buradan verilir.', en: 'Network team. Permissions are granted here.' }, izinler: [], yerlesik: true, izinDuzenlenir: true },
  teknik: { ad: { tr: 'Teknik', en: 'Technical' }, aciklama: { tr: 'Teknik ekip. İzinleri buradan verilir.', en: 'Technical team. Permissions are granted here.' }, izinler: [], yerlesik: true, izinDuzenlenir: true },
  muhasebe: { ad: { tr: 'Muhasebe', en: 'Accounting' }, aciklama: { tr: 'Muhasebe. İzinleri buradan verilir.', en: 'Accounting. Permissions are granted here.' }, izinler: [], yerlesik: true, izinDuzenlenir: true },
  // Kamera rolu: merkezde yalniz bu panele girer; burada izleme izinleriyle dogar, panelden daraltilabilir.
  kamera: { ad: { tr: 'Kamera', en: 'Camera' }, aciklama: { tr: 'Kamera ekibi: canlı izleme ve kayıtlar. İzinleri buradan verilir.', en: 'Camera team: live view and recordings. Permissions are granted here.' }, izinler: ['canli.izle', 'kayit.listele', 'kayit.izle', 'kayit.indir'], yerlesik: true, izinDuzenlenir: true },
};

const IZIN_ADLARI = Object.keys(IZINLER);
const GRUP_ADLARI = new Set(Object.values(IZINLER).map((i) => i.grup));
const GRUP_IZIN = (g) => IZIN_ADLARI.filter((i) => IZINLER[i].grup === g);

/** Gecerli izin metni mi? ("*", "grup.*" ya da katalogdaki bir izin) */
export function izinGecerli(izin) {
  if (izin === '*') return true;
  if (typeof izin !== 'string') return false;
  if (IZINLER[izin]) return true;
  const m = /^([a-z]+)\.\*$/.exec(izin);
  return !!m && IZIN_ADLARI.some((i) => i.startsWith(`${m[1]}.`));
}
export function izinKumesi(liste) { return liste instanceof Set ? liste : new Set(liste ?? []); }
/** izinler (dizi/Set; "*" ve "grup.*" icerebilir) gereken izni veriyor mu? */
export function izinVar(izinler, gereken) {
  const k = izinKumesi(izinler);
  if (k.has('*') || k.has(gereken)) return true;
  const i = gereken.indexOf('.');
  return i > 0 && k.has(`${gereken.slice(0, i)}.*`);
}
/** "*" ve "grup.*" kalibini somut izinlere acar (gosterim ve alt-kume denetimi icin). */
export function izinGenislet(liste) {
  const cikti = new Set();
  for (const i of liste ?? []) {
    if (i === '*') IZIN_ADLARI.forEach((x) => cikti.add(x));
    else if (i.endsWith('.*')) IZIN_ADLARI.filter((x) => x.startsWith(i.slice(0, -1))).forEach((x) => cikti.add(x));
    else if (IZINLER[i]) cikti.add(i);
  }
  return [...cikti];
}
/** cocuk izinleri ebeveynin izinlerinin alt kumesi mi? (yetki yukseltmeyi onler) */
export function izinAltKume(cocuk, ebeveyn) {
  const e = izinKumesi(ebeveyn);
  return izinGenislet(cocuk).every((i) => izinVar(e, i));
}
export function izinKesisim(a, b) {
  const kb = izinKumesi(b);
  return izinGenislet(a).filter((i) => izinVar(kb, i));
}

// ---------------------------------------------------------------- IP / CIDR
function ipv4Sayi(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const temizIp = (ip) => String(ip ?? '').replace(/^::ffff:/i, '').toLowerCase();
/** IPv4, IPv4/CIDR ya da tam IPv6 adresi mi? */
export function ipKuraliGecerli(kural) {
  if (typeof kural !== 'string') return false;
  if (kural.includes('/')) { const [ag, bit] = kural.split('/'); const b = Number(bit); return ipv4Sayi(ag) !== null && /^\d{1,2}$/.test(bit) && b >= 0 && b <= 32; }
  return ipv4Sayi(kural) !== null || /^[0-9a-f:]{2,39}$/i.test(kural) && kural.includes(':');
}
/** ip, kurallardan (bos liste = kisitsiz) birine uyuyor mu? */
export function ipEslesir(ip, kurallar) {
  if (!kurallar?.length) return true;
  const a = temizIp(ip), n = ipv4Sayi(a);
  for (const k of kurallar) {
    if (k.includes('/')) {
      const [ag, bit] = k.split('/'), g = ipv4Sayi(ag), b = Number(bit);
      if (n === null || g === null) continue;
      const maske = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
      if (((n & maske) >>> 0) === ((g & maske) >>> 0)) return true;
    } else if (temizIp(k) === a) return true;
  }
  return false;
}

// ---------------------------------------------------------------- kapsam (kamera erisim listesi)
/** Kapsami dogrular/normallestirir. null/undefined = kisitsiz; { cihazlar:[], kanallar:[] } = hicbir kanal. */
export function kapsamNormalle(k) {
  if (k === null || k === undefined) return null;
  if (typeof k !== 'object' || Array.isArray(k)) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Kapsam bir nesne olmalı ({cihazlar, kanallar})', 400);
  const cihazlar = [...new Set((k.cihazlar ?? []).map(String))];
  if (cihazlar.some((c) => !/^[A-Za-z0-9_-]{2,64}$/.test(c))) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Kapsamdaki cihaz kimliği geçersiz', 400);
  const kanallar = [...new Set((k.kanallar ?? []).map(Number))];
  if (kanallar.some((n) => !Number.isInteger(n) || n < 0 || n > 1023)) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Kapsamdaki kanal numarası geçersiz', 400);
  return { cihazlar, kanallar: kanallar.sort((a, b) => a - b) };
}
/** kanal, kapsama giriyor mu? cihazIdOf(kanal) -> cihaz kimligi. */
export function kapsamKanalIzinli(kapsam, kanal, cihazIdOf) {
  if (!kapsam) return true;
  if (kapsam.kanallar?.includes(kanal)) return true;
  if (kapsam.cihazlar?.length) { const id = cihazIdOf?.(kanal); if (id && kapsam.cihazlar.includes(id)) return true; }
  return false;
}
export function kapsamKumesi(kapsam, kanalToplam, cihazIdOf) {
  const s = new Set();
  for (let k = 0; k < kanalToplam; k++) if (kapsamKanalIzinli(kapsam, k, cihazIdOf)) s.add(k);
  return s;
}
/** cocuk kapsam ebeveyn kapsamin icinde mi? (kisitli bir sahip, kapsamindan genis anahtar uretemez) */
export function kapsamIcinde(cocuk, ebeveyn, kanalToplam, cihazIdOf) {
  if (!ebeveyn) return true;
  const e = kapsamKumesi(ebeveyn, kanalToplam, cihazIdOf);
  // Acik kanal numarasi mevcut bir kanala denk gelmeli: "henuz olmayan" kanal numarasi onceden verilemez (sonradan eklenen cihaz o kapsama girerdi).
  if (cocuk?.kanallar?.some((k) => !e.has(k))) return false;
  for (const k of kapsamKumesi(cocuk, kanalToplam, cihazIdOf)) if (!e.has(k)) return false;
  return true;
}
/** iki kapsamin kesisimi. Sonuc acik kanal listesidir. */
export function kapsamKesisim(a, b, kanalToplam, cihazIdOf) {
  if (!a && !b) return null;
  if (!a) return { cihazlar: [], kanallar: [...kapsamKumesi(b, kanalToplam, cihazIdOf)] };
  if (!b) return { cihazlar: [], kanallar: [...kapsamKumesi(a, kanalToplam, cihazIdOf)] };
  const sb = kapsamKumesi(b, kanalToplam, cihazIdOf);
  return { cihazlar: [], kanallar: [...kapsamKumesi(a, kanalToplam, cihazIdOf)].filter((k) => sb.has(k)) };
}

// ---------------------------------------------------------------- hiz siniri / hata kisiti
/** Kayan pencere hiz siniri (anahtar basina istek/dakika). */
export class HizSiniri {
  constructor() { this.kayit = new Map(); }
  /** { tamam, kalan, sifirlanmaSn } */
  dene(anahtar, limit, pencereMs = 60_000, simdi = Date.now()) {
    let d = this.kayit.get(anahtar);
    if (!d) { d = []; this.kayit.set(anahtar, d); }
    while (d.length && d[0] <= simdi - pencereMs) d.shift();
    if (d.length >= limit) return { tamam: false, kalan: 0, sifirlanmaSn: Math.max(1, Math.ceil((d[0] + pencereMs - simdi) / 1000)) };
    d.push(simdi);
    return { tamam: true, kalan: limit - d.length, sifirlanmaSn: Math.ceil(pencereMs / 1000) };
  }
  temizle(simdi = Date.now(), pencereMs = 60_000) { for (const [k, d] of this.kayit) { while (d.length && d[0] <= simdi - pencereMs) d.shift(); if (!d.length) this.kayit.delete(k); } }
}
/** Kimlik dogrulama hatalari icin IP basina kilit: pencerede en cok `en` hata, sonra kilit. */
export class HataKisiti {
  constructor({ en = 10, pencereMs = 600_000, kilitMs = 300_000 } = {}) { Object.assign(this, { en, pencereMs, kilitMs }); this.ipler = new Map(); }
  kilitliMi(ip, simdi = Date.now()) { const d = this.ipler.get(ip); return d?.kilit > simdi ? Math.ceil((d.kilit - simdi) / 1000) : 0; }
  hata(ip, simdi = Date.now()) {
    let d = this.ipler.get(ip);
    if (!d || simdi - d.ilk > this.pencereMs) { d = { n: 0, ilk: simdi, kilit: 0 }; this.ipler.set(ip, d); }
    d.n++; if (d.n >= this.en) d.kilit = simdi + this.kilitMs;
  }
  basari(ip) { this.ipler.delete(ip); }
}

// ---------------------------------------------------------------- yardimcilar
const esit = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const ISO_TARIH = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/;
/** bitis metnini ISO'ya cevirir (yalniz tarih verilirse o gunun sonu, UTC). null = suresiz. */
export function bitisNormalle(b) {
  if (b === null || b === undefined || b === '') return null;
  if (typeof b !== 'string' || !ISO_TARIH.test(b)) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bitiş tarihi geçersiz (YYYY-AA-GG ya da ISO)', 400);
  const t = Date.parse(b.length === 10 ? `${b}T23:59:59Z` : b);
  if (Number.isNaN(t)) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bitiş tarihi geçersiz', 400);
  return new Date(t).toISOString();
}
export function iplerNormalle(l) {
  if (l === null || l === undefined) return [];
  if (!Array.isArray(l) || l.length > 20) throw new YetkiHatasi('GECERSIZ_ISTEK', 'IP listesi en çok 20 öğe olabilir', 400);
  const t = l.map((x) => String(x).trim()).filter(Boolean);
  const kotu = t.find((x) => !ipKuraliGecerli(x));
  if (kotu) throw new YetkiHatasi('GECERSIZ_ISTEK', `IP/CIDR geçersiz: ${kotu}`, 400);
  return [...new Set(t)];
}

// ---------------------------------------------------------------- asal (kimlik sahibi: uye ya da anahtar)
/**
 * Asal: bir istegi yapan taraf. tur: 'uye' | 'anahtar'. yontem: 'cerez' | 'anahtar'.
 * ctx: { cihazIdOf(kanal), kanalToplam() }  (kapsam hesabi icin)
 */
export class Asal {
  constructor(o, ctx) {
    Object.assign(this, { tur: 'uye', yontem: 'cerez', ad: '', sahip: null, kimlik: '', rol: null, izinler: [], kapsam: null, bitis: null, ipler: [], hizLimiti: 600, eszamanliAkis: 8, anahtarId: null }, o);
    this.ctx = ctx; this.kume = new Set(this.izinler);
  }
  izinVar(g) { return izinVar(this.kume, g); }
  /** izinlerden herhangi biri */
  herhangiIzin(liste) { return liste.some((g) => this.izinVar(g)); }
  kanalIzinli(kanal) { return kapsamKanalIzinli(this.kapsam, kanal, this.ctx?.cihazIdOf); }
  kapsamsiz() { return !this.kapsam; }
  /**
   * Bu asalin ADINA islem yaptigi uye: uyede kendisi, API anahtarinda anahtar kaydindaki SAHIP. `ad` anahtarin serbest metin goruntu adidir
   * (olusturan belirler) — sahiplik/yetki kararlarinda ASLA kullanilmaz.
   */
  get uyeAdi() { return this.tur === 'anahtar' ? this.sahip : this.ad; }
  /** Gunluge yazilacak kisa kimlik: "admin" ya da "anahtar:a1b2c3d4" */
  get gunlukAdi() { return this.tur === 'anahtar' ? `anahtar:${this.anahtarId}` : this.ad; }
  acik() {
    return { tur: this.tur, ad: this.ad, kimlik: this.kimlik, rol: this.rol, yontem: this.yontem, izinler: izinGenislet(this.izinler), izinHam: this.izinler, kapsam: this.kapsam, bitis: this.bitis, ipler: this.ipler, hizLimiti: this.hizLimiti, anahtarId: this.anahtarId };
  }
}

// ---------------------------------------------------------------- yetki deposu (roller + API anahtarlari)
const ANAHTAR_BICIMI = /^kp_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const ROL_KIMLIK = /^[a-z][a-z0-9_-]{1,31}$/;

const sinirAs = (mesaj) => { throw new YetkiHatasi('YETKI_YUKSELTME', mesaj, 403); };
/**
 * Bir kaydin IP listesi ve bitisi `sinir`dan gevsek olamaz. sinir.ipler bos = IP kisiti yok; sinir.bitis null = suresiz.
 * varsayilanla=true (olusturma): eksik deger sinirdan alinir; false (guncelleme): eksik/gevsek deger reddedilir.
 * IP karsilastirmasi metin esitligiyle yapilir (CIDR kapsama hesabi yok): fazla siki, ama asla gevsek degil.
 */
function baglariSinirla({ ipler, bitis }, sinir, varsayilanla) {
  if (sinir.ipler?.length) {
    if (!ipler.length && varsayilanla) ipler = [...sinir.ipler];
    if (!ipler.length || ipler.some((k) => !sinir.ipler.includes(k))) sinirAs('IP listeniz dışında ya da IP kısıtsız anahtar/hesap veremezsiniz');
  }
  if (sinir.bitis) {
    if (!bitis && varsayilanla) bitis = sinir.bitis;
    if (!bitis || Date.parse(bitis) > Date.parse(sinir.bitis)) sinirAs('Kendi bitişinizden uzun ya da süresiz anahtar/hesap veremezsiniz');
  }
  return { ipler, bitis };
}
export { baglariSinirla };

export class YetkiDeposu {
  /**
   * dosya: veri/yetki.json; gizli: panelin gizli anahtari (Buffer).
   * secenek.rolKullanimda(rolId) -> bool (uye/anahtar bu rolu kullaniyor mu)
   */
  constructor(dosya, gizli, secenek = {}) {
    this.dosya = dosya; this.secenek = secenek;
    // Etiket eski adla SABIT (depo cam oldu): degisirse verilmis API anahtarlarinin hicbiri dogrulanmaz.
    this.karmaAnahtari = createHmac('sha256', gizli).update('kamera2/api-anahtar').digest();
    this.veri = { surum: 1, roller: {}, anahtarlar: [], yerlesikIzinler: {} };
    if (existsSync(dosya)) { try { this.veri = { surum: 1, roller: {}, anahtarlar: [], yerlesikIzinler: {}, ...JSON.parse(readFileSync(dosya, 'utf8')) }; } catch (e) { throw new Error(`yetki.json okunamadı: ${e.message}`); } }
    this.hata = new HataKisiti(); this.hiz = new HizSiniri(); this.akislar = new Map();
    this.kirli = false; this.zamanlayici = null;
    // bellek: hiz penceresi ve hata kisiti kayitlari periyodik temizlenir (unref: sureci acik tutmaz)
    this.temizlik = setInterval(() => { this.hiz.temizle(); for (const [ip, d] of this.hata.ipler) if (Date.now() - d.ilk > this.hata.pencereMs && d.kilit < Date.now()) this.hata.ipler.delete(ip); }, 60_000); this.temizlik.unref?.();
  }

  #yaz() { const g = `${this.dosya}.tmp`; writeFileSync(g, JSON.stringify(this.veri, null, 2), { mode: 0o600 }); renameSync(g, this.dosya); this.kirli = false; }
  /** Sik degisen alanlar (son kullanim) icin ertelenmis yazim. */
  #ertele() {
    this.kirli = true;
    if (this.zamanlayici) return;
    this.zamanlayici = setTimeout(() => { this.zamanlayici = null; if (this.kirli) try { this.#yaz(); } catch {} }, 15_000);
    this.zamanlayici.unref?.();
  }
  kapat() { clearInterval(this.temizlik); if (this.zamanlayici) { clearTimeout(this.zamanlayici); this.zamanlayici = null; } if (this.kirli) try { this.#yaz(); } catch {} }

  // ---------- roller
  roller() {
    return [...Object.entries(YERLESIK_ROLLER).map(([id, r]) => ({ id, ...r, izinler: r.izinDuzenlenir ? (this.veri.yerlesikIzinler?.[id] ?? r.izinler) : r.izinler })),
      ...Object.entries(this.veri.roller).map(([id, r]) => ({ id, ad: r.ad, aciklama: r.aciklama, izinler: r.izinler, yerlesik: false, olusturan: r.olusturan, olusturma: r.olusturma }))];
  }
  rolBul(id) { return this.roller().find((r) => r.id === id) ?? null; }
  rolVar(id) { return !!this.rolBul(id); }
  rolIzinleri(id) { return this.rolBul(id)?.izinler ?? []; }

  #rolDogrula(g, mevcut = null) {
    const ad = typeof g.ad === 'string' ? { tr: g.ad, en: g.ad } : g.ad;
    if (!ad || typeof ad !== 'object' || !String(ad.tr ?? ad.en ?? '').trim()) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Rol adı gerekli', 400);
    const adTemiz = { tr: String(ad.tr ?? ad.en).trim().slice(0, 60), en: String(ad.en ?? ad.tr).trim().slice(0, 60) };
    const aciklama = typeof g.aciklama === 'string' ? { tr: g.aciklama.slice(0, 200), en: g.aciklama.slice(0, 200) } : (g.aciklama ? { tr: String(g.aciklama.tr ?? '').slice(0, 200), en: String(g.aciklama.en ?? g.aciklama.tr ?? '').slice(0, 200) } : { tr: '', en: '' });
    const izinler = [...new Set(g.izinler ?? mevcut?.izinler ?? [])];
    if (!izinler.length) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Rolde en az bir izin olmalı', 400);
    const kotu = izinler.find((i) => !izinGecerli(i));
    if (kotu) throw new YetkiHatasi('GECERSIZ_ISTEK', `Bilinmeyen izin: ${kotu}`, 400);
    if (izinler.includes('*')) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Özel rollerde "*" kullanılamaz (tam yetki için yerleşik admin rolü vardır)', 400);
    return { ad: adTemiz, aciklama, izinler };
  }
  rolEkle(g, olusturan, ebeveynIzinler = ['*']) {
    const id = String(g.id ?? '').trim();
    if (!ROL_KIMLIK.test(id)) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Rol kimliği küçük harf/rakam/-/_ ile başlamalı (2-32 karakter)', 400);
    if (this.rolVar(id)) throw new YetkiHatasi('CAKISMA', 'Bu rol kimliği kullanılıyor', 409);
    const r = this.#rolDogrula(g);
    if (!izinAltKume(r.izinler, ebeveynIzinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
    this.veri.roller[id] = { ...r, olusturan, olusturma: new Date().toISOString() }; this.#yaz();
    return this.rolBul(id);
  }
  rolGuncelle(id, g, ebeveynIzinler = ['*']) {
    // DC rolleri (network/teknik/muhasebe): ad sabit, yalniz izinler degisir; bos liste gecerli (izinsiz rol).
    if (YERLESIK_ROLLER[id]?.izinDuzenlenir) {
      const izinler = [...new Set(g.izinler ?? [])];
      const kotu = izinler.find((i) => !izinGecerli(i));
      if (kotu) throw new YetkiHatasi('GECERSIZ_ISTEK', `Bilinmeyen izin: ${kotu}`, 400);
      if (izinler.includes('*')) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bu rolde "*" kullanılamaz (tam yetki yalnız admin rolünde)', 400);
      if (!izinAltKume(izinler, ebeveynIzinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
      this.veri.yerlesikIzinler = { ...(this.veri.yerlesikIzinler ?? {}), [id]: izinler }; this.#yaz();
      return this.rolBul(id);
    }
    if (YERLESIK_ROLLER[id]) throw new YetkiHatasi('YERLESIK_DEGISMEZ', 'Yerleşik roller değiştirilemez', 403);
    const mevcut = this.veri.roller[id]; if (!mevcut) throw new YetkiHatasi('BULUNAMADI', 'Rol yok', 404);
    const r = this.#rolDogrula({ ad: g.ad ?? mevcut.ad, aciklama: g.aciklama ?? mevcut.aciklama, izinler: g.izinler ?? mevcut.izinler }, mevcut);
    if (!izinAltKume(r.izinler, ebeveynIzinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri bir role veremezsiniz', 403);
    this.veri.roller[id] = { ...mevcut, ...r }; this.#yaz();
    return this.rolBul(id);
  }
  rolSil(id) {
    if (YERLESIK_ROLLER[id]) throw new YetkiHatasi('YERLESIK_DEGISMEZ', 'Yerleşik roller silinemez', 403);
    if (!this.veri.roller[id]) throw new YetkiHatasi('BULUNAMADI', 'Rol yok', 404);
    if (this.veri.anahtarlar.some((a) => a.rol === id) || this.secenek.rolKullanimda?.(id)) throw new YetkiHatasi('CAKISMA', 'Bu rol bir üye ya da anahtar tarafından kullanılıyor', 409);
    delete this.veri.roller[id]; this.#yaz();
  }

  // ---------- API anahtarlari
  #acik(a) { const { karma, ...g } = a; return { ...g, izinlerEfektif: izinGenislet(this.anahtarIzinleri(a)), aktif: this.aktifMi(a) }; }
  anahtarIzinleri(a) { return [...new Set([...(a.rol ? this.rolIzinleri(a.rol) : []), ...(a.izinler ?? [])])]; }
  aktifMi(a, simdi = Date.now()) { return !a.iptal && !(a.bitis && Date.parse(a.bitis) <= simdi); }
  anahtarlar(sahip = null) { return this.veri.anahtarlar.filter((a) => !sahip || a.sahip === sahip).map((a) => this.#acik(a)); }
  anahtarBul(id) { const a = this.veri.anahtarlar.find((x) => x.id === id); return a ? this.#acik(a) : null; }
  /** Ham kayit (karma dahil) — yalniz kimlik ara katmani icin. */
  anahtarHam(id) { return this.veri.anahtarlar.find((x) => x.id === id) ?? null; }
  #karma(gizli) { return createHmac('sha256', this.karmaAnahtari).update(gizli).digest('hex'); }
  #yeniGizli() { return randomBytes(32).toString('base64url'); }

  /**
   * Yeni anahtar. sahip: anahtarin sahibi (uye adi). olusturanAsal: yetki yukseltmeyi denetlemek icin (izin ve kapsam alt kume olmali).
   * Dondurur { kayit, anahtar } — anahtar (gizli) BIR KEZ doner.
   */
  anahtarOlustur(g, olusturan, { ebeveynIzinler = ['*'], ebeveynKapsam = null, kanalToplam = 0, cihazIdOf = null, ebeveynIpler = [], ebeveynBitis = null, ebeveynHiz = null, ebeveynAkis = null } = {}) {
    const ad = String(g.ad ?? '').trim();
    if (!ad || ad.length > 60) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Anahtar adı gerekli (en çok 60 karakter)', 400);
    const rol = g.rol ? String(g.rol) : null;
    if (rol && !this.rolVar(rol)) throw new YetkiHatasi('GECERSIZ_ISTEK', `Rol bulunamadı: ${rol}`, 400);
    const izinler = [...new Set(g.izinler ?? [])];
    const kotu = izinler.find((i) => !izinGecerli(i));
    if (kotu) throw new YetkiHatasi('GECERSIZ_ISTEK', `Bilinmeyen izin: ${kotu}`, 400);
    if (!rol && !izinler.length) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bir rol ya da en az bir izin gerekli', 400);
    const kapsam = kapsamNormalle(g.kapsam);
    const efektif = [...new Set([...(rol ? this.rolIzinleri(rol) : []), ...izinler])];
    if (!izinAltKume(efektif, ebeveynIzinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri bir anahtara veremezsiniz', 403);
    if (ebeveynKapsam && !kapsamIcinde(kapsam, ebeveynKapsam, kanalToplam, cihazIdOf)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Kapsamınızın dışındaki kameraları bir anahtara veremezsiniz', 403);
    if (ebeveynKapsam && !kapsam) throw new YetkiHatasi('YETKI_YUKSELTME', 'Kapsamınız kısıtlı: anahtar da kısıtlı olmalı', 403);
    let bitis = bitisNormalle(g.bitis);
    if (bitis && Date.parse(bitis) <= Date.now()) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bitiş tarihi geçmişte', 400);
    let ipler = iplerNormalle(g.ipler);
    const sayi = (v, v0, alt, ust, ad2) => { const n = v === undefined || v === null ? v0 : Number(v); if (!Number.isInteger(n) || n < alt || n > ust) throw new YetkiHatasi('GECERSIZ_ISTEK', `${ad2} ${alt}-${ust} arasında tam sayı olmalı`, 400); return n; };
    // varsayilan, anahtar uretene anahtar ise onun sinirini asmaz
    let hizLimiti = sayi(g.hizLimiti, ebeveynHiz != null ? Math.min(120, ebeveynHiz) : 120, 1, 6000, 'Hız limiti');
    let eszamanliAkis = sayi(g.eszamanliAkis, ebeveynAkis != null ? Math.min(4, ebeveynAkis) : 4, 0, 32, 'Eşzamanlı akış');
    // Olusturanin kendi baglari (IP listesi, bitis, hiz/akis siniri) anahtara tasinir: kisitli bir olusturan kisitsiz anahtar uretemez.
    ({ ipler, bitis } = baglariSinirla({ ipler, bitis }, { ipler: ebeveynIpler, bitis: ebeveynBitis }, true));
    if (ebeveynHiz != null && hizLimiti > ebeveynHiz) sinirAs('Hız limiti sizinkini aşamaz');
    if (ebeveynAkis != null && eszamanliAkis > ebeveynAkis) sinirAs('Akış sınırı sizinkini aşamaz');
    let id; do { id = randomBytes(4).toString('hex'); } while (this.veri.anahtarlar.some((a) => a.id === id));
    const gizli = this.#yeniGizli();
    const kayit = {
      id, ad, onek: `kp_${id}_${gizli.slice(0, 4)}…`, karma: this.#karma(gizli), rol, izinler, kapsam, bitis, ipler, hizLimiti, eszamanliAkis,
      sahip: g.sahip ?? olusturan, olusturan, olusturma: new Date().toISOString(), sonKullanim: null, sayac: 0, iptal: null, notlar: String(g.notlar ?? '').slice(0, 200),
    };
    this.veri.anahtarlar.push(kayit); this.#yaz();
    return { kayit: this.#acik(kayit), anahtar: `kp_${id}_${gizli}` };
  }
  anahtarGuncelle(id, g, { ebeveynIzinler = ['*'], ebeveynKapsam = null, kanalToplam = 0, cihazIdOf = null, kisitli = false, ebeveynIpler = [], ebeveynBitis = null } = {}) {
    const a = this.veri.anahtarlar.find((x) => x.id === id); if (!a) throw new YetkiHatasi('BULUNAMADI', 'Anahtar yok', 404);
    if (a.iptal) throw new YetkiHatasi('CAKISMA', 'İptal edilmiş anahtar değiştirilemez', 409);
    const yeni = { ...a };
    if (g.ad !== undefined) { const ad = String(g.ad).trim(); if (!ad || ad.length > 60) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Anahtar adı gerekli', 400); yeni.ad = ad; }
    if (g.rol !== undefined) { if (g.rol && !this.rolVar(g.rol)) throw new YetkiHatasi('GECERSIZ_ISTEK', `Rol bulunamadı: ${g.rol}`, 400); yeni.rol = g.rol || null; }
    if (g.izinler !== undefined) { const iz = [...new Set(g.izinler)]; const kotu = iz.find((i) => !izinGecerli(i)); if (kotu) throw new YetkiHatasi('GECERSIZ_ISTEK', `Bilinmeyen izin: ${kotu}`, 400); yeni.izinler = iz; }
    if (g.kapsam !== undefined) yeni.kapsam = kapsamNormalle(g.kapsam);
    if (g.bitis !== undefined) yeni.bitis = bitisNormalle(g.bitis);
    if (g.ipler !== undefined) yeni.ipler = iplerNormalle(g.ipler);
    if (g.hizLimiti !== undefined) { const n = Number(g.hizLimiti); if (!Number.isInteger(n) || n < 1 || n > 6000) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Hız limiti 1-6000 arasında olmalı', 400); yeni.hizLimiti = n; }
    if (g.eszamanliAkis !== undefined) { const n = Number(g.eszamanliAkis); if (!Number.isInteger(n) || n < 0 || n > 32) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Eşzamanlı akış 0-32 arasında olmalı', 400); yeni.eszamanliAkis = n; }
    if (g.notlar !== undefined) yeni.notlar = String(g.notlar).slice(0, 200);
    const efektif = this.anahtarIzinleri(yeni);
    if (!efektif.length) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Bir rol ya da en az bir izin gerekli', 400);
    if (!izinAltKume(efektif, ebeveynIzinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri bir anahtara veremezsiniz', 403);
    if (ebeveynKapsam && (!yeni.kapsam || !kapsamIcinde(yeni.kapsam, ebeveynKapsam, kanalToplam, cihazIdOf))) throw new YetkiHatasi('YETKI_YUKSELTME', 'Kapsamınızın dışındaki kameraları bir anahtara veremezsiniz', 403);
    if (kisitli) {
      // yetki.yonet'siz cagiran: DEGISEN bag hem kendi baglarini hem kaydin MEVCUT baglarini (admin koymus olabilir) gevsetemez.
      const ayni = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      if (!ayni(yeni.ipler, a.ipler)) for (const i of [ebeveynIpler, a.ipler]) baglariSinirla({ ipler: yeni.ipler, bitis: null }, { ipler: i, bitis: null }, false);
      if (!ayni(yeni.bitis, a.bitis)) for (const b of [ebeveynBitis, a.bitis]) baglariSinirla({ ipler: [], bitis: yeni.bitis }, { ipler: [], bitis: b }, false);
      if (yeni.hizLimiti > a.hizLimiti) sinirAs('Hız limiti yetki.yonet olmadan artırılamaz');
      if (yeni.eszamanliAkis > a.eszamanliAkis) sinirAs('Akış sınırı yetki.yonet olmadan artırılamaz');
    }
    Object.assign(a, yeni); this.#yaz();
    return this.#acik(a);
  }
  /** Gizliyi degistirir: eski gizli hemen gecersiz olur (anahtar kimligi ayni kalir). */
  anahtarYenile(id) {
    const a = this.veri.anahtarlar.find((x) => x.id === id); if (!a) throw new YetkiHatasi('BULUNAMADI', 'Anahtar yok', 404);
    if (a.iptal) throw new YetkiHatasi('CAKISMA', 'İptal edilmiş anahtar yenilenemez', 409);
    const gizli = this.#yeniGizli();
    a.karma = this.#karma(gizli); a.onek = `kp_${id}_${gizli.slice(0, 4)}…`; a.surum = (a.surum ?? 1) + 1; this.#yaz();
    return { kayit: this.#acik(a), anahtar: `kp_${id}_${gizli}` };
  }
  anahtarIptal(id, kim) {
    const a = this.veri.anahtarlar.find((x) => x.id === id); if (!a) throw new YetkiHatasi('BULUNAMADI', 'Anahtar yok', 404);
    if (!a.iptal) { a.iptal = { z: new Date().toISOString(), kim }; this.#yaz(); }
    return this.#acik(a);
  }
  anahtarSil(id) {
    const n = this.veri.anahtarlar.length;
    this.veri.anahtarlar = this.veri.anahtarlar.filter((a) => a.id !== id);
    if (this.veri.anahtarlar.length === n) throw new YetkiHatasi('BULUNAMADI', 'Anahtar yok', 404);
    this.#yaz();
  }

  /**
   * Bearer metnindeki API anahtarini dogrular. Basarisizlikta YetkiHatasi (401/429). Dondurur ham kayit.
   * ip: istemci IP'si (kaba kuvvet kisiti ve IP listesi icin).
   */
  anahtarDogrula(metin, ip) {
    const bekle = this.hata.kilitliMi(ip);
    if (bekle) throw new YetkiHatasi('COK_FAZLA_DENEME', `Çok fazla başarısız deneme. ${bekle} sn sonra tekrar deneyin.`, 429, { yenidenDenemeSn: bekle });
    const m = ANAHTAR_BICIMI.exec(String(metin ?? '').trim());
    const a = m ? this.veri.anahtarlar.find((x) => x.id === m[1]) : null;
    // zamanlama farki anahtar kimliginin varligini sizdirmasin: her durumda ayni isi yap
    const beklenen = a?.karma ?? this.#karma('yok');
    const gelen = this.#karma(m ? m[2] : 'yok');
    const dogru = !!a && esit(beklenen, gelen);
    if (!dogru) { this.hata.hata(ip); throw new YetkiHatasi('GECERSIZ_ANAHTAR', 'API anahtarı geçersiz', 401); }
    this.hata.basari(ip);
    if (a.iptal) throw new YetkiHatasi('ANAHTAR_IPTAL', 'API anahtarı iptal edilmiş', 401);
    if (a.bitis && Date.parse(a.bitis) <= Date.now()) throw new YetkiHatasi('SURESI_DOLDU', 'API anahtarının süresi dolmuş', 401);
    if (!ipEslesir(ip, a.ipler)) throw new YetkiHatasi('IP_ENGELLI', 'Bu IP adresinden bu anahtar kullanılamaz', 403, { ip });
    return a;
  }
  kullanimiKaydet(id, ip) {
    const a = this.veri.anahtarlar.find((x) => x.id === id); if (!a) return;
    a.sonKullanim = { z: new Date().toISOString(), ip }; a.sayac = (a.sayac ?? 0) + 1; this.#ertele();
  }

  // ---------- hiz siniri ve akis siniri
  hizDene(asal, simdi = Date.now()) {
    const r = this.hiz.dene(asal.kimlik, asal.hizLimiti, 60_000, simdi);
    if (!r.tamam) throw new YetkiHatasi('HIZ_SINIRI', `Hız sınırı aşıldı (${asal.hizLimiti} istek/dk)`, 429, { yenidenDenemeSn: r.sifirlanmaSn });
    return r;
  }
  /**
   * Eszamanli akis hakki ister; dondurulen fonksiyon hakki birakir.
   * ortak: sunucuda paylasilan akisin anahtari (canli). Ayni akisi ikinci sekme/ekran izlerse yeni hak harcanmaz:
   * sunucu kameraya yine tek baglanti acar. Anahtarsiz akis (oynatma/indirme) her istekte ayri sayilir.
   */
  akisAc(asal, ortak = null) {
    const sinir = asal.eszamanliAkis;
    const m = this.akislar.get(asal.kimlik) ?? new Map();
    const k = ortak ?? Symbol('akis');
    if (!m.has(k) && sinir !== undefined && sinir !== null && m.size >= sinir) throw new YetkiHatasi('AKIS_SINIRI', `Eşzamanlı akış sınırı aşıldı (${sinir})`, 429, { yenidenDenemeSn: 5 });
    m.set(k, (m.get(k) ?? 0) + 1); this.akislar.set(asal.kimlik, m);
    let birakildi = false;
    return () => {
      if (birakildi) return; birakildi = true;
      const n = (m.get(k) ?? 1) - 1;
      if (n <= 0) m.delete(k); else m.set(k, n);
      if (!m.size && this.akislar.get(asal.kimlik) === m) this.akislar.delete(asal.kimlik);
    };
  }

}


