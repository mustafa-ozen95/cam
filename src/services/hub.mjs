/**
 * Kimlik Yonetim Merkezi (KYM) ile konusan istemci ve merkez baglari.
 *
 * AKIS: Authorization Code + PKCE. Kullanici merkezin kendi sayfasinda giris yapar, buraya tek kullanimlik bir
 * kod doner; kod sunucu tarafinda jetona cevrilir ve /oauth/kullanici ile kimlik okunur. Parola bu panele ugramaz.
 * EYS/NYS panellerindeki MerkezIstemcisi ile ayni protokol (bkz. KYM Uygulamalar ekrani).
 *
 * BAGLAR (merkez_baglari tablosu): merkezdeki kimlik (sub) -> buradaki uye adi. Merkezde erisimi kalkan ya da
 * rolu degisen kisi burada da ayni anda degismeli; durum, giriste ve her N dakikada bir arka kanaldan
 * (/api/kimlik-durumu) sorulur, merkez bildirim gonderirse (/api/kimlik/tazele) hemen sorulur.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Kilit, Koleksiyon, yazGeriAl } from '../core/tables.mjs';
import { MERKEZ_BAGLARI } from '../database/schema.mjs';

export class MerkezYetkisizHatasi extends Error {}

export class MerkezIstemcisi {
  constructor(kimlik) { this.k = kimlik; }

  /** Dort alan da doluysa acik. Yarim yapilandirma dugmeyi bile cizdirmez. */
  acikMi() { return !!(this.k.adres && this.k.istemci && this.k.sir && this.k.donus); }

  dogrulayici() { return randomBytes(48).toString('base64url'); }                         // RFC 7636: 43-128 karakter
  meydanOkuma(dogrulayici) { return createHash('sha256').update(dogrulayici).digest('base64url'); }

  girisAdresi(durum, meydanOkuma) {
    const u = new URL(this.k.adres + '/oauth/authorize');
    for (const [a, d] of Object.entries({ client_id: this.k.istemci, redirect_uri: this.k.donus, response_type: 'code', scope: '', state: durum, code_challenge: meydanOkuma, code_challenge_method: 'S256' })) u.searchParams.set(a, d);
    return u.href;
  }

  async #istek(yol, secenek) {
    const ctrl = new AbortController(); const z = setTimeout(() => ctrl.abort(), 15_000);
    try { return await fetch(this.k.adres + yol, { ...secenek, signal: ctrl.signal }); } finally { clearTimeout(z); }
  }

  /** Kodu jetona cevirir. */
  async jeton(kod, dogrulayici) {
    const govde = new URLSearchParams({ grant_type: 'authorization_code', client_id: this.k.istemci, client_secret: this.k.sir, redirect_uri: this.k.donus, code_verifier: dogrulayici, code: kod });
    const y = await this.#istek('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: govde });
    if (!y.ok) throw new Error(`Merkez jetonu vermedi (${y.status})`);
    const j = await y.json();
    if (!j.access_token) throw new Error('Merkezden jeton gelmedi');
    return j;
  }

  /** Jetonun kime ait oldugu. 403: merkez bu uygulamaya kapiyi kapatmis (rol izinli degil) — ayri hata. */
  async kullanici(jeton) {
    const y = await this.#istek('/oauth/kullanici', { headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' } });
    if (y.status === 403) { const j = await y.json().catch(() => ({})); throw new MerkezYetkisizHatasi(j.hata ?? 'Bu panele erişim yetkiniz yok.'); }
    if (!y.ok) throw new Error(`Merkez kimliği vermedi (${y.status})`);
    const v = await y.json();
    if (!v.sub || !v.email) throw new Error('Merkezden gelen kimlik eksik');
    return { sub: String(v.sub), ad: String(v.name ?? ''), eposta: String(v.email), epostaDogrulandi: !!v.email_verified, rol: v.rol ? String(v.rol) : null, hesapAcilabilir: !!v.hesap_acilabilir };
  }

  /** Merkezdeki kimliklerin SU ANKI durumu (arka kanal; istemci kimligi ve sirriyla). Yalnizca sorulanlar doner. */
  async kimlikDurumlari(kimlikler) {
    if (!kimlikler.length) return {};
    const y = await this.#istek('/api/kimlik-durumu', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: this.k.istemci, client_secret: this.k.sir, kimlikler }) });
    if (!y.ok) throw new Error(`Merkez kimlik durumlarını vermedi (${y.status})`);
    return (await y.json()).kimlikler ?? {};
  }

  /** Ortak cikis: "bu kisi bende cikti" (merkez: /api/oturum-kapandi). Merkez ani yazar, kendi oturumunu ve diger panelleri kapatir. */
  async oturumKapandi(subject) {
    const y = await this.#istek('/api/oturum-kapandi', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: this.k.istemci, client_secret: this.k.sir, subject }) });
    if (!y.ok) throw new Error(`Merkez çıkışı almadı (${y.status})`);
  }

  /** Merkezin cikis bildirimi: imza ANI da kapsar (`cikis|<subject>|<an>`), boylece an merkeze yeniden sorulmadan uygulanir. */
  cikisImzaliMi(subject, an, imza) {
    if (!this.k.bildirimSirri || !subject || !Number.isSafeInteger(an) || an <= 0 || !imza) return false;
    const beklenen = createHmac('sha256', this.k.bildirimSirri).update(`cikis|${subject}|${an}`).digest('hex');
    return imza.length === beklenen.length && timingSafeEqual(Buffer.from(imza), Buffer.from(beklenen));
  }

  /** Merkezden gelen bildirimin imzasi dogru mu? (HMAC-SHA256, bildirim sirriyla; sir bossa hicbir bildirim kabul edilmez) */
  bildirimImzaliMi(subject, imza) {
    if (!this.k.bildirimSirri || !subject || !imza) return false;
    const beklenen = createHmac('sha256', this.k.bildirimSirri).update(subject).digest('hex');
    return imza.length === beklenen.length && timingSafeEqual(Buffer.from(imza), Buffer.from(beklenen));
  }
}

/**
 * Merkez baglari: sub -> { ad, eposta, rol (merkezdeki), girebilir, kontrol (son sorgu), sonGiris }.
 * Erisim karari burada degil merkezde: `girebilir` merkezin son soyledigidir; false ise oturum cerezi islemez.
 *
 * BAG UYENIN ADINA DEGIL, UYENIN KENDISINE baglidir: `uyeKimlik` = uyenin olusturma damgasi. Ad silinip yeniden kullanilabilir; damga
 * tutmayan (ayni adli ama baska) bir uye bagi devralamaz, merkezdeki rolu ona uygulanmaz. Uye silinince bag da silinir (uyeyiBirak).
 * Eski kayitlarda (damgasiz) bag, yuklenirken ADIN GUNCEL uyesinin damgasini alir; uyesi olmayan eski bag atilir.
 */
export class MerkezBaglari {
  constructor(vt, { merkez, uyeler, gunluk, yapilandirma }) {
    this.vt = vt; this.kol = new Koleksiyon(vt, MERKEZ_BAGLARI); this.kilit = new Kilit();
    this.merkez = merkez; this.uyeler = uyeler; this.gunluk = gunluk; this.k = yapilandirma.kimlik;
    this.veri = {};
    this.sonDeneme = new Map();   // sub -> ms (merkeze ulasilamayinca bir dakika beklenir; her istekte denenmez)
    this.surenler = new Map();    // sub -> Promise (ayni kimlik icin es zamanli ikinci sorgu acilmaz)
  }

  /** Acilista veritabanindan bellege (uyeler once yuklenmis olmali). */
  async yukle() {
    this.veri = this.#sozluk(await this.kol.yukle());
    await this.#damgala();
    return this;
  }
  #sozluk(liste) { return Object.fromEntries(liste.map(({ sub, ...b }) => [sub, b])); }
  /** Bellek degisikligi (fn, esinkron) + veritabani yazimi tek parca ve sirayla; yazim basarisizsa bellek son basarili haline doner. */
  #islem(fn) {
    return this.kilit.calistir(async () => {
      const sonuc = fn();
      await yazGeriAl(() => this.kol.kaydet(Object.entries(this.veri).map(([sub, b]) => ({ sub, ...b }))), () => { this.veri = this.#sozluk(this.kol.geriAl()); }, 'merkez_baglari');
      return sonuc;
    });
  }

  /** Damgasiz (eski bicim) baglari mevcut uyeye damgalar; uyesi olmayanlari atar. Degisiklik varsa yazilir. */
  async #damgala() {
    if (!Object.values(this.veri).some((b) => !b.uyeKimlik)) return;
    await this.#islem(() => {
      for (const [sub, b] of Object.entries(this.veri)) {
        if (b.uyeKimlik) continue;
        const u = this.uyeler.bul(b.ad);
        if (u) b.uyeKimlik = u.olusturma; else delete this.veri[sub];
      }
    });
  }
  /** Bagin gercekten bagli oldugu uye (ad VE damga tutuyorsa), yoksa null. */
  #uyesi(bag) { const u = bag && this.uyeler.bul(bag.ad); return u && bag.uyeKimlik && bag.uyeKimlik === u.olusturma ? u : null; }
  /** Uye silinince: o uyeye bagli (ya da ayni adi tutan) butun baglar dusurulur. */
  uyeyiBirak(ad) {
    const k = String(ad).toLowerCase();
    return this.#islem(() => { for (const [sub, b] of Object.entries(this.veri)) if (b.ad.toLowerCase() === k) delete this.veri[sub]; });
  }
  bul(sub) { return this.veri[sub] ?? null; }
  /** Bu adli UYEYE bagli bag (damga tutmayan eski/yabanci bag sayilmaz). */
  adaGore(ad) { const k = String(ad).toLowerCase(); for (const [sub, b] of Object.entries(this.veri)) if (b.ad.toLowerCase() === k && this.#uyesi(b)) return { sub, ...b }; return null; }
  herkes() { return Object.entries(this.veri).map(([sub, b]) => ({ sub, ...b })); }

  /**
   * Merkezdeki rolun buradaki karsiligi. Roller DC panelleriyle ayni kimliklerde (admin, network, teknik, muhasebe):
   * eslemede yazmiyorsa ayni ad denenir, o da yoksa varsayilan rol. Hicbiri gecerli degilse null: hesap ACILMAZ —
   * eksik bilgi yetki uretmemeli.
   */
  yerelRol(merkezRolu) {
    for (const r of [merkezRolu && this.k.rolEsleme[merkezRolu], merkezRolu, this.k.varsayilanRol]) if (r && this.uyeler.rolGecerli(r)) return r;
    return null;
  }

  /**
   * Giriste: bagli uyeyi dondurur; bag yoksa ve merkez "hesap acilabilir" diyorsa uye acar.
   * Uye adi e-postanin kendisidir (diger paneller gibi; member.mjs kurali: 3-64, harf/rakam/._-@); catisirsa @ oncesine sayi eklenir.
   */
  async girisYap(kimlik, istek) {
    let bag = this.bul(kimlik.sub);
    if (bag && !this.#uyesi(bag)) { await this.#islem(() => { delete this.veri[kimlik.sub]; }); bag = null; }   // uye silinmis (ya da ayni adla baska uye): bag olu
    if (!bag) {
      if (!kimlik.hesapAcilabilir || !kimlik.epostaDogrulandi) throw new MerkezYetkisizHatasi('Bu panelde hesabınız yok; yöneticiye başvurun.');
      const ad = this.#bosAd(kimlik.eposta);
      const rol = this.yerelRol(kimlik.rol);
      if (!rol) throw new MerkezYetkisizHatasi('Merkezdeki rolünüzün bu panelde karşılığı yok; yöneticiye başvurun.');
      await this.uyeler.ekle(ad, randomBytes(24).toString('base64url'), rol);          // parola rastgele: giris yalniz merkezden
      this.gunluk.yaz('merkez-hesap-acildi', ad, istek, { eposta: kimlik.eposta, merkezRolu: kimlik.rol, rol });
      bag = { ad, uyeKimlik: this.uyeler.bul(ad).olusturma, eposta: kimlik.eposta, rol: kimlik.rol, girebilir: true, kontrol: null, sonGiris: null };
    }
    await this.#roluUygula(bag, kimlik.rol, istek);
    await this.#islem(() => {
      bag.eposta = kimlik.eposta; bag.girebilir = true; bag.kontrol = new Date().toISOString(); bag.sonGiris = bag.kontrol; bag.rol = kimlik.rol;
      this.veri[kimlik.sub] = bag;
    });
    return this.uyeler.bul(bag.ad);
  }

  #bosAd(eposta) {
    const temiz = String(eposta).toLowerCase().replace(/[^a-z0-9._@-]/g, '');
    const [yerel, alan] = temiz.split('@');
    const ek = alan ? `@${alan}` : '';
    const taban = (yerel || 'merkez').slice(0, 58 - ek.length);
    const yap = (i = '') => `${taban.length < 3 ? `${taban}-kym` : taban}${i}${ek}`;
    let ad = yap();
    const bagliAd = (x) => Object.values(this.veri).some((b) => b.ad.toLowerCase() === x);
    for (let i = 2; this.uyeler.bul(ad) || bagliAd(ad); i++) ad = yap(i);   // baglarin tuttugu adlar da dolu sayilir
    return ad;
  }

  /** Merkezdeki rolun buradaki uyeye yansimasi (uyenin rolu); bagin kendi rol alani cagiranin islemiyle yazilir. */
  async #roluUygula(bag, merkezRolu, istek = null) {
    const u = this.#uyesi(bag); if (!u) return;
    const yeni = this.yerelRol(merkezRolu);
    if (!yeni || u.rol === yeni) return;
    try { await this.uyeler.guncelle(bag.ad, { rol: yeni }, null); this.gunluk.yaz('merkez-rol', bag.ad, istek, { eski: u.rol, yeni, merkezRolu }); }
    catch (e) { this.gunluk.yaz('merkez-rol-hata', bag.ad, istek, { neden: e.message, merkezRolu }); }
  }

  /** Merkezin verdigi durumu uygular: girebilir / rol. */
  async durumUygula(sub, durum) {
    const bag = this.bul(sub); if (!bag) return;
    const girebilir = !!durum.girebilir;
    if (bag.girebilir && !girebilir) this.gunluk.yaz('merkez-erisim-kapandi', bag.ad, null, { merkezDurumu: durum.durum ?? 'bilinmiyor' });
    if (!bag.girebilir && girebilir) this.gunluk.yaz('merkez-erisim-acildi', bag.ad, null, {});
    if (girebilir && durum.rol !== undefined) await this.#roluUygula(bag, durum.rol ?? null);
    await this.#islem(() => {
      bag.girebilir = girebilir; bag.kontrol = new Date().toISOString();
      if (girebilir && durum.rol !== undefined) bag.rol = durum.rol ?? null;
      // Ortak cikis: bildirim kaybolduysa an buradan gelir (bkz. cikisIsle).
      if (Number.isSafeInteger(durum.son_cikis) && durum.son_cikis > (bag.sonCikis ?? 0)) bag.sonCikis = durum.son_cikis;
    });
  }

  /**
   * ORTAK CIKIS (bir panelden cikis merkezden ve oteki panellerden de cikistir): merkezdeki son cikis ani (ms).
   * Bu andan ONCE acilmis oturum cerezi islemez. An yalniz ILERI gider: gec gelen eski bildirim yeni girisi kapatmaz.
   */
  async cikisIsle(sub, an) {
    const bag = this.bul(sub);
    if (!bag || !Number.isSafeInteger(an) || an <= (bag.sonCikis ?? 0)) return false;
    await this.#islem(() => { bag.sonCikis = an; });
    return true;
  }

  /** Bu oturum (acilis ani ms) bagli uyenin merkezdeki son cikisindan once mi acildi? Bagsiz uye: hayir. */
  cikisSonrasiMi(ad, acilis) {
    const bag = this.adaGore(ad);
    return !!bag && (bag.sonCikis ?? 0) > 0 && (acilis ?? 0) < bag.sonCikis;
  }

  /** Oturum cerezi islemeli mi? Bagsiz uye: evet. Bagli uye: merkezin son dedigi; sure dolduysa arka planda yeniden sorulur. */
  erisebilirMi(ad) {
    const bag = this.adaGore(ad);
    if (!bag) return true;
    if (this.merkez.acikMi()) this.#gerekirseTazele(bag.sub, bag);
    return bag.girebilir !== false;
  }

  #gerekirseTazele(sub, bag) {
    const simdi = Date.now();
    const eskidi = !bag.kontrol || simdi - Date.parse(bag.kontrol) > this.k.dogrulamaDakika * 60_000;
    if (!eskidi || this.surenler.has(sub) || (this.sonDeneme.get(sub) ?? 0) > simdi - 60_000) return;
    this.tazele(sub).catch(() => {});
  }

  /** Merkeze sorup uygular; cagiran beklemek zorunda degil. Hata: bir dakika yeniden denenmez (merkez yoksa panel durmaz). */
  tazele(sub) {
    if (this.surenler.has(sub)) return this.surenler.get(sub);
    const is = (async () => {
      try { const d = await this.merkez.kimlikDurumlari([sub]); if (d[sub]) await this.durumUygula(sub, d[sub]); }
      catch (e) { this.sonDeneme.set(sub, Date.now()); console.error('merkez durumu sorulamadı:', e.message); }
      finally { this.surenler.delete(sub); }
    })();
    this.surenler.set(sub, is);
    return is;
  }
}
