/**
 * Uye yonetimi (uye.yonet izni). Yetki yukseltme engeli: kendi izinlerinin ustunde rol / kendi kapsami disinda kamera verilemez;
 * kendinden yetkili bir uyeye (parola sifirlama, rol dusurme, silme dahil) dokunulamaz; kendi hesap kisitlari (bitis, IP) gevsetilemez.
 */
import { cerezYaz, govdeOku, json } from '../core/http.mjs';
import { VeritabaniHatasi } from '../core/errors.mjs';
import { YetkiHatasi, bitisNormalle, iplerNormalle, izinAltKume, kapsamIcinde, kapsamNormalle } from '../models/yetki.mjs';

export function uyelerDenetleyici({ uyeler, yetki, gunluk, cihazlar, baglar = null, yapilandirma }) {
  const rolDenetle = (asal, rol) => { if (rol !== undefined && !izinAltKume(yetki.rolIzinleri(rol), asal.izinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sahip olmadığınız izinleri içeren bir rol veremezsiniz', 403); };
  const kapsamDenetle = (asal, k) => {
    if (asal.kapsamsiz()) return;
    const kk = k === undefined ? null : kapsamNormalle(k);
    if (!kk || !kapsamIcinde(kk, asal.kapsam, cihazlar.grup.kanalToplam, (x) => cihazlar.grup.cihazIdOf(x))) throw new YetkiHatasi('YETKI_YUKSELTME', 'Kapsamınız kısıtlı: üyeye yalnız kendi kapsamınızdaki kameraları verebilirsiniz', 403);
  };
  /**
   * Degistirilecek/silinecek HEDEF uyenin MEVCUT hali de cagirana sigmali: rolunun izinleri cagirananin alt kumesi, kapsami cagirananin kapsami icinde
   * (kapsamsiz hedef = kapsamsiz cagiran). Yalniz yeni degerleri denetlemek yetmez: parola sifirlama/silme icin yeni deger yok.
   */
  const hedefDenetle = (asal, ad) => {
    const u = uyeler.bul(ad); if (!u) return;   // model 'Kullanıcı yok' der
    if (!izinAltKume(yetki.rolIzinleri(u.rol), asal.izinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Sizden yetkili bir üyeyi değiştiremez ya da silemezsiniz', 403);
    if (!asal.kapsamsiz() && (!u.kapsam || !kapsamIcinde(u.kapsam, asal.kapsam, cihazlar.grup.kanalToplam, (x) => cihazlar.grup.cihazIdOf(x)))) throw new YetkiHatasi('YETKI_YUKSELTME', 'Kapsamınız dışındaki bir üyeyi değiştiremez ya da silemezsiniz', 403);
  };
  /**
   * Hesap baglari (bitis, IP listesi) cagiranin baglarindan gevsek olamaz ('*' sahibi haric: tam yetkili kisitlari kaldirabilir).
   * Olusturmada deger cagiranin sinirinda olmali; guncellemede DEGISMEYEN deger serbest (arayuz hepsini geri yollar), degisen deger
   * baskasi icin cagiranin sinirini, KENDI hesabi icin hesabin mevcut kaydini gevsetemez.
   */
  const baglamDenetle = (asal, g, hedef) => {
    if (asal.izinVar('*')) return;
    const kendi = !!hedef && hedef.ad === asal.uyeAdi;
    const bitisSinir = kendi ? hedef.bitis : asal.bitis, ipSinir = kendi ? (hedef.ipler ?? []) : (asal.ipler ?? []);
    const ayni = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (hedef ? g.bitis !== undefined : true) {
      const b = bitisNormalle(g.bitis);
      if (!(hedef && ayni(b, hedef.bitis ?? null)) && bitisSinir && (!b || Date.parse(b) > Date.parse(bitisSinir))) throw new YetkiHatasi('YETKI_YUKSELTME', 'Hesap süresini sizin ya da hesabın bitişinden uzatamazsınız / süresiz bırakamazsınız', 403);
    }
    if (hedef ? g.ipler !== undefined : true) {
      const l = iplerNormalle(g.ipler);
      if (!(hedef && ayni(l, hedef.ipler ?? [])) && ipSinir.length && (!l.length || l.some((k) => !ipSinir.includes(k)))) throw new YetkiHatasi('YETKI_YUKSELTME', 'IP kısıtını sizin ya da hesabın listesi dışına çıkaramaz / kaldıramazsınız', 403);
    }
  };
  const hataIle = async (res, fn) => { try { return await fn(); } catch (e) { if (e instanceof YetkiHatasi || e instanceof VeritabaniHatasi || e instanceof SyntaxError) throw e; return json(res, 400, { hata: e.message, kod: 'GECERSIZ_ISTEK' }); } };
  return {
    async liste(ctx) { return json(ctx.res, 200, uyeler.herkes()); },
    async ekle(ctx) {
      return hataIle(ctx.res, async () => {
        const g = await govdeOku(ctx.istek), rol = g.rol;
        if (!rol) throw new YetkiHatasi('GECERSIZ_ISTEK', 'Rol gerekli', 400);
        rolDenetle(ctx.asal, rol); kapsamDenetle(ctx.asal, g.kapsam); baglamDenetle(ctx.asal, g, null);
        await uyeler.ekle(g.ad, g.parola, rol, { kapsam: g.kapsam, bitis: g.bitis, ipler: g.ipler });
        gunluk.yaz('uye-ekle', ctx.asal.gunlukAdi, ctx.istek, { uye: g.ad, rol });
        return json(ctx.res, 200, { tamam: true });
      });
    },
    async guncelle(ctx) {
      return hataIle(ctx.res, async () => {
        const g = await govdeOku(ctx.istek), ad = ctx.param.ad;
        hedefDenetle(ctx.asal, ad);
        rolDenetle(ctx.asal, g.rol); if (g.kapsam !== undefined) kapsamDenetle(ctx.asal, g.kapsam);
        baglamDenetle(ctx.asal, g, uyeler.bul(ad));
        await uyeler.guncelle(ad, { parola: g.parola, rol: g.rol, kapsam: g.kapsam, bitis: g.bitis, ipler: g.ipler }, ctx.asal.uyeAdi, ctx.ip);
        gunluk.yaz('uye-duzenle', ctx.asal.gunlukAdi, ctx.istek, { uye: ad, alanlar: Object.keys(g).filter((k) => k !== 'parola'), parola: g.parola !== undefined });
        // Kendi parolasini degistiren, parola yuzunden oturum surumu artinca dusmesin: ayni istekte yeni cerez verilir.
        const ben = ctx.asal.tur === 'uye' && g.parola !== undefined && uyeler.bul(ad)?.ad === ctx.asal.ad ? uyeler.bul(ad) : null;
        if (ben) cerezYaz(ctx.res, yapilandirma.oturum.cerez, uyeler.oturumCerezi(ben), yapilandirma.oturum.gun * 86400, yapilandirma.sunucu.vekil || !!ctx.res.socket?.encrypted);
        return json(ctx.res, 200, { tamam: true });
      });
    },
    async sil(ctx) {
      return hataIle(ctx.res, async () => {
        hedefDenetle(ctx.asal, ctx.param.ad);
        const hedef = uyeler.bul(ctx.param.ad);
        await uyeler.sil(ctx.param.ad, ctx.asal.uyeAdi);
        // Silinen uyeye ait her sey birlikte gider: API anahtarlari iptal edilir, KYM bagi dusurulur (ad yeniden kullanilsa da devralinamaz).
        if (hedef) for (const a of yetki.anahtarlar(hedef.ad)) await yetki.anahtarIptal(a.id, ctx.asal.gunlukAdi);
        await baglar?.uyeyiBirak(ctx.param.ad);
        gunluk.yaz('uye-sil', ctx.asal.gunlukAdi, ctx.istek, { uye: ctx.param.ad });
        return json(ctx.res, 200, { tamam: true });
      });
    },
  };
}
