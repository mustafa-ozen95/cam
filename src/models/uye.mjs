/**
 * Uyelik: kullanici adi + parola. Uyeyi yalniz yetkili olan (uye.yonet) olusturur.
 * Her uyenin bir ROLU (yetki.mjs: yerlesik ya da ozel rol), istege bagli KAPSAMI (hangi kameralari gorebilir),
 * hesap BITIS tarihi ve IP/CIDR listesi vardir.
 * Parolalar scrypt ile tuzlanip saklanir (veri/kullanicilar.json); oturum, gizli anahtarla imzali cerezdir
 * (sunucuda oturum tablosu yok; cerez her istekte dosyadan yeniden dogrulanir: uye silinince, parola degisince, cikis yapilinca
 * ya da ayni adla yeni hesap acilinca eski cerez islemez — cerez uyenin olusturma damgasina ve oturum surumune baglidir).
 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bitisNormalle, ipEslesir, iplerNormalle, kapsamNormalle } from './yetki.mjs';

const AD_KURALI = /^[a-zA-Z0-9._@-]{3,64}$/;   // @: merkezden gelen uye adi e-posta (diger paneller gibi)
const OTURUM_GUN = 30;

const karma = (parola, tuz) => scryptSync(parola, tuz, 32);
/** Giris yolunda zaman uyumsuz karma: scryptSync tek olay dongusunu onlarca ms kilitliyordu (kimliksiz istemci bunu tetikleyebilir). */
const karmaAsync = (parola, tuz) => new Promise((coz, red) => scrypt(parola, tuz, 32, (e, k) => (e ? red(e) : coz(k))));

/** Gizli anahtarla imzalanan her seyin AMACI ayri etiketle baglanir: oturum cerezi, merkez akis cerezi, ... birbirinin yerine gecemez. */
export const ETIKET_OTURUM = 'kamera2/oturum';   // eski adla SABIT (depo cam oldu): degisirse acik oturumlar duser
const HATA_TTL = 15 * 60_000;   // giris hata kaydi bu kadar sure sonra silinir
const HATA_EN_COK = 5000;       // kimliksiz istemci istedigi kadar yeni kullanici adiyla kayit sisirmesin
const AD_UZUN = 64;             // hata anahtarina giren ad bu kadar kirpilir

// Kayit cihazi ayni anda en cok 16 canli goruntu veriyor (17. kareden sonrasi baglanamaz); sayfa bunu asmaz.
export const HEPSI_SAYI = { en: 4, cok: 16, varsayilan: 16 };
const SIRA_EN_COK = 1024;
/** Tercih kaydi: bilinen alanlar, sinirli degerler; disaridan gelen baska alan kayda girmez. */
export function tercihNormalle(t) {
  const g = t && typeof t === 'object' ? t : {};
  const sayi = Number.isInteger(g.hepsiSayi) ? Math.min(HEPSI_SAYI.cok, Math.max(HEPSI_SAYI.en, g.hepsiSayi)) : HEPSI_SAYI.varsayilan;
  const sira = Array.isArray(g.hepsiSira) ? [...new Set(g.hepsiSira.filter((k) => Number.isInteger(k) && k >= 0 && k < 100_000))].slice(0, SIRA_EN_COK) : [];
  return { hepsiSayi: sayi, hepsiSira: sira, arkaPlandaDurdur: g.arkaPlandaDurdur !== false, izgaraAkis: g.izgaraAkis === 'ana' ? 'ana' : 'alt' };
}

export class Uyelik {
  constructor(dosya, gizliDosya) {
    this.dosya = dosya;
    mkdirSync(dirname(dosya), { recursive: true });
    this.liste = existsSync(dosya) ? JSON.parse(readFileSync(dosya, 'utf8')) : [];
    if (existsSync(gizliDosya)) this.gizli = readFileSync(gizliDosya);
    else { this.gizli = randomBytes(32); writeFileSync(gizliDosya, this.gizli, { mode: 0o600 }); }
    this.hatalar = new Map(); // ip|ad -> { sayi, kilitli, z }
    // Eski kayitlarda olusturma damgasi yoksa bir kez verilir ve yazilir: oturum ve KYM bagi bu damgaya baglanir (ad tek basina yeniden kullanilabilir).
    if (this.liste.some((u) => !u.olusturma)) { for (const u of this.liste) u.olusturma ??= new Date().toISOString(); this.#yaz(); }
    this.temizlik = setInterval(() => this.#hataTemizle(), 60_000); this.temizlik.unref?.();
    /** Rol kimligi gecerli mi? sunucu, yetki deposunun rol listesine baglar. */
    this.rolGecerli = (r) => r === 'admin' || r === 'kullanici';
  }

  #yaz() { const g = `${this.dosya}.tmp`; writeFileSync(g, JSON.stringify(this.liste, null, 2), { mode: 0o600 }); renameSync(g, this.dosya); }
  #adminSayisi() { return this.liste.filter((x) => x.rol === 'admin').length; }

  #hataTemizle(simdi = Date.now()) { for (const [k, h] of this.hatalar) if (simdi - h.z > HATA_TTL && !(h.kilitli > simdi)) this.hatalar.delete(k); }

  bos() { return this.liste.length === 0; }
  herkes() { return this.liste.map(({ ad, rol, olusturma, kapsam, bitis, ipler }) => ({ ad, rol, olusturma, kapsam: kapsam ?? null, bitis: bitis ?? null, ipler: ipler ?? [] })); }
  bul(ad) { return this.liste.find((u) => u.ad.toLowerCase() === String(ad).toLowerCase()) ?? null; }
  /** Bu rolu kullanan uye var mi? (rol silmeden once) */
  rolKullanimda(id) { return this.liste.some((u) => u.rol === id); }

  /** Uyenin kendi gorunum tercihleri (canli "Hepsi" sirasi ve sayisi, arka planda durdurma). Yetki tasimaz; yalniz sahibi okur/yazar. */
  tercih(ad) { return tercihNormalle(this.bul(ad)?.tercih); }
  /** Verilen alanlar degisir, verilmeyen kalir. Gecersiz deger hata degil, sinira cekilir ya da yok sayilir. */
  tercihYaz(ad, g) {
    const u = this.bul(ad);
    if (!u) throw new Error('Kullanıcı yok');
    u.tercih = tercihNormalle({ ...u.tercih, ...(g && typeof g === 'object' ? g : {}) });
    this.#yaz();
    return u.tercih;
  }

  ekle(ad, parola, rol, ek = {}) {
    if (!AD_KURALI.test(ad ?? '')) throw new Error('Kullanıcı adı 3-64 karakter olmalı (harf, rakam, . _ - @)');
    if (typeof parola !== 'string' || parola.length < 8 || parola.length > 128) throw new Error('Parola en az 8 karakter olmalı');
    if (!this.rolGecerli(rol)) throw new Error('Rol geçersiz');
    if (this.bul(ad)) throw new Error('Bu kullanıcı adı kullanılıyor');
    const tuz = randomBytes(16);
    this.liste.push({
      ad, rol, tuz: tuz.toString('hex'), karma: karma(parola, tuz).toString('hex'), olusturma: new Date().toISOString(), oturumSurum: 0,
      kapsam: kapsamNormalle(ek.kapsam), bitis: bitisNormalle(ek.bitis), ipler: iplerNormalle(ek.ipler),
    });
    this.#yaz();
  }

  /** g: { parola, rol, kapsam, bitis, ipler } (verilmeyen alan degismez). yapanIp: islemi yapanin IP'si (kendini kilitlemeyi onler). */
  guncelle(ad, g, yapan, yapanIp = null) {
    const { parola, rol } = g;
    const u = this.bul(ad);
    if (!u) throw new Error('Kullanıcı yok');
    const sonAdmin = u.rol === 'admin' && this.#adminSayisi() < 2;
    const yeni = {};
    if (rol !== undefined) {
      if (!this.rolGecerli(rol)) throw new Error('Rol geçersiz');
      if (sonAdmin && rol !== 'admin') throw new Error('Son admin kullanıcıya çevrilemez');
      if (u.ad === yapan && rol !== u.rol) throw new Error('Kendi rolünüzü değiştiremezsiniz');
      yeni.rol = rol;
    }
    if (g.kapsam !== undefined) {
      if (sonAdmin) throw new Error('Son admin hesabına kapsam kısıtı konamaz');
      yeni.kapsam = kapsamNormalle(g.kapsam);
    }
    if (g.bitis !== undefined) {
      const bitis = bitisNormalle(g.bitis);
      if (bitis && (sonAdmin || (u.ad === yapan && u.rol === 'admin' && this.#adminSayisi() < 2))) throw new Error('Son admin hesabına bitiş tarihi konamaz');
      if (bitis && Date.parse(bitis) <= Date.now()) throw new Error('Bitiş tarihi geçmişte');
      yeni.bitis = bitis;
    }
    if (g.ipler !== undefined) {
      const ipler = iplerNormalle(g.ipler);
      if (ipler.length && u.ad === yapan && yapanIp && !ipEslesir(yapanIp, ipler)) throw new Error('Şu anki IP adresiniz listede yok; kendinizi kilitlerdiniz');
      yeni.ipler = ipler;
    }
    if (parola !== undefined) {
      if (typeof parola !== 'string' || parola.length < 8 || parola.length > 128) throw new Error('Parola en az 8 karakter olmalı');
      const tuz = randomBytes(16); yeni.tuz = tuz.toString('hex'); yeni.karma = karma(parola, tuz).toString('hex');
      yeni.oturumSurum = (u.oturumSurum ?? 0) + 1;      // parola degisince eldeki butun cerezler gecersiz
    }
    Object.assign(u, yeni);
    this.#yaz();
  }

  sil(ad, yapan) {
    const u = this.bul(ad);
    if (!u) throw new Error('Kullanıcı yok');
    if (u.ad === yapan) throw new Error('Kendinizi silemezsiniz');
    if (u.rol === 'admin' && this.#adminSayisi() < 2) throw new Error('Son admin silinemez');
    this.liste = this.liste.filter((x) => x !== u);
    this.#yaz();
  }

  /** Cikis / "her yerden cik": uyenin eldeki butun oturum cerezleri gecersiz olur (sunucuda oturum tablosu yok, surum sayaci var). */
  oturumuKapat(ad) { const u = this.bul(ad); if (!u) return; u.oturumSurum = (u.oturumSurum ?? 0) + 1; this.#yaz(); }

  /** Giris denemesi: yanlis parolada artan bekleme (5 hatadan sonra 60 sn kilit). Dondurur kullanici ya da firlatir. */
  async dogrula(ad, parola, ip) {
    const anahtar = `${ip}|${String(ad ?? '').slice(0, AD_UZUN).toLowerCase()}`;
    const h = this.hatalar.get(anahtar);
    if (h?.kilitli > Date.now()) throw new Error(`Çok fazla deneme. ${Math.ceil((h.kilitli - Date.now()) / 1000)} sn sonra tekrar deneyin.`);
    const u = this.bul(ad);
    // kullanici yoksa da ayni isi yap (zamanlama farki kullanici adini sizdirmasin)
    const tuz = u ? Buffer.from(u.tuz, 'hex') : Buffer.alloc(16);
    const k = await karmaAsync(String(parola ?? '').slice(0, 128), tuz);
    const dogru = u && timingSafeEqual(k, Buffer.from(u.karma, 'hex'));
    if (!dogru) {
      const sayi = (h?.sayi ?? 0) + 1;
      if (!h && this.hatalar.size >= HATA_EN_COK) { this.#hataTemizle(); if (this.hatalar.size >= HATA_EN_COK) this.hatalar.delete(this.hatalar.keys().next().value); }   // dolunca en eski kayit gider
      this.hatalar.set(anahtar, { sayi, kilitli: sayi >= 5 ? Date.now() + 60_000 : 0, z: Date.now() });
      throw new Error('Kullanıcı adı ya da parola yanlış');
    }
    this.hatalar.delete(anahtar);
    if (u.bitis && Date.parse(u.bitis) <= Date.now()) throw new Error('Hesabın süresi dolmuş');
    if (u.ipler?.length && !ipEslesir(ip, u.ipler)) throw new Error('Bu IP adresinden giriş yapılamaz');
    return u;
  }

  /** Gunluk zinciri icin HMAC imzasi. Etiketsiz kalir: eski zincir kayitlari dogrulanabilsin (oturum/akis cerezleri etiketli, bununla cakisamaz). */
  imza(metin) { return createHmac('sha256', this.gizli).update(metin).digest('hex'); }
  /** Amaca bagli imza: etiket MAC girdisine eklenir, baska amacla uretilmis imza burada tutmaz. */
  etiketliImza(etiket, yuk) { return createHmac('sha256', this.gizli).update(`${etiket}|${yuk}`).digest('base64url'); }

  /** Uye kimligi: ad + olusturma damgasi. Ayni adla yeniden acilan hesap eskisinin cerezini/bagini devralamaz. */
  static damga(u) { return u.olusturma ?? ''; }

  oturumCerezi(u) {
    // g: acilis ani (ms) — merkezdeki son cikistan once acilan oturum islemez (ortak cikis, bkz. MerkezBaglari.cikisSonrasiMi).
    const yuk = Buffer.from(JSON.stringify({ t: 'oturum', a: u.ad, k: Uyelik.damga(u), s: u.oturumSurum ?? 0, g: Date.now(), e: Date.now() + OTURUM_GUN * 864e5 })).toString('base64url');
    return `${yuk}.${this.etiketliImza(ETIKET_OTURUM, yuk)}`;
  }

  /** Cerezi cozer; gecerliyse GUNCEL kullaniciyi ({ad, rol, kapsam, bitis, ipler}) dondurur (suresi dolmus hesap = null). */
  oturumCoz(cerez) {
    if (!cerez) return null;
    const [yuk, imza, fazla] = cerez.split('.');
    if (!yuk || !imza || fazla !== undefined) return null;
    const beklenen = this.etiketliImza(ETIKET_OTURUM, yuk);
    if (imza.length !== beklenen.length || !timingSafeEqual(Buffer.from(imza), Buffer.from(beklenen))) return null;
    try {
      const { t, a, k, s, g, e } = JSON.parse(Buffer.from(yuk, 'base64url').toString());
      if (t !== 'oturum' || typeof a !== 'string' || typeof e !== 'number' || e < Date.now()) return null;
      const u = this.bul(a);
      if (!u || u.ad !== a || Uyelik.damga(u) !== k || (u.oturumSurum ?? 0) !== s) return null;
      if (u.bitis && Date.parse(u.bitis) <= Date.now()) return null;
      return { ad: u.ad, rol: u.rol, kapsam: u.kapsam ?? null, bitis: u.bitis ?? null, ipler: u.ipler ?? [], acilis: typeof g === 'number' ? g : 0 };
    } catch { return null; }
  }
}

export const cerezOku = (baslik, ad) => {
  for (const p of (baslik ?? '').split(';')) { const [k, ...v] = p.trim().split('='); if (k === ad) return v.join('='); }
  return null;
};
