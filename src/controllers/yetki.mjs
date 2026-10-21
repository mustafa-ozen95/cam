/**
 * Yetki yonetimi: izin katalogu, roller, API anahtarlari.
 *  - yetki.yonet: tum roller/anahtarlar.   - api.anahtar: yalniz KENDI anahtarlari (sahip = kendisi), rolleri yalniz okur.
 * Anahtar gizlisi yalniz olusturma/yenileme yanitinda bir kez doner; dosyada ozet saklanir.
 */
import { govdeOku, json } from '../core/http.mjs';
import { IZINLER, IZIN_GRUPLARI, YetkiHatasi, izinAltKume, izinGenislet } from '../models/yetki.mjs';

export function yetkiDenetleyici({ yetki, gunluk, cihazlar }) {
  const tumYetki = (asal) => asal.izinVar('yetki.yonet');
  /**
   * Yukseltme/sinir denetimi icin cagiran bilgisi. yetki.yonet'siz cagiranin kendi bagi (IP listesi, bitis, hiz/akis siniri) olusturdugu
   * anahtara tasinir: kisitli bir hesap/anahtar kisitsiz anahtar uretemez.
   */
  const ctxEb = (asal) => ({ ebeveynIzinler: asal.izinler, ebeveynKapsam: asal.kapsam, kanalToplam: cihazlar.grup.kanalToplam, cihazIdOf: (k) => cihazlar.grup.cihazIdOf(k),
    kisitli: !tumYetki(asal), ebeveynIpler: tumYetki(asal) ? [] : (asal.ipler ?? []), ebeveynBitis: tumYetki(asal) ? null : asal.bitis,
    ebeveynHiz: asal.tur === 'anahtar' && !tumYetki(asal) ? asal.hizLimiti : null, ebeveynAkis: asal.tur === 'anahtar' && !tumYetki(asal) ? asal.eszamanliAkis : null });
  /** Sahiplik UYE adiyla baglanir: uyede kendi adi, Bearer anahtarda kaydin sahibi (anahtarin serbest metin goruntu adi ASLA). */
  const sahipAdi = (asal) => { const s = asal.uyeAdi; if (!s) throw new YetkiHatasi('YETKI_YOK', 'Anahtar sahibi belirlenemedi', 403); return s; };
  /**
   * api.anahtar: anahtar sahibi kendisi olmali. genis=false (okuma/degistirme/yenileme): anahtarin izinleri cagirana ait olanlarin alt kumesi
   * olmali — yenileme sahibin tum yetkisini veren yeni bir gizli donduremez. genis=true (iptal/silme): yalniz uye icin,
   * cunku kendi yetkisi dusurulmus uye eski anahtarini kapatabilmeli.
   */
  const anahtarErisim = (asal, id, genis = false) => {
    const a = yetki.anahtarBul(id); if (!a) throw new YetkiHatasi('BULUNAMADI', 'Anahtar yok', 404);
    if (tumYetki(asal)) return a;
    if (a.sahip !== sahipAdi(asal)) throw new YetkiHatasi('YETKI_YOK', 'Bu anahtar size ait değil', 403);
    if (!(genis && asal.tur === 'uye') && !izinAltKume(a.izinlerEfektif, asal.izinler)) throw new YetkiHatasi('YETKI_YUKSELTME', 'Bu anahtar sizden geniş yetkili', 403);
    return a;
  };
  return {
    async izinler(ctx) { return json(ctx.res, 200, { izinler: Object.entries(IZINLER).map(([id, i]) => ({ id, ...i })), gruplar: IZIN_GRUPLARI, benim: izinGenislet(ctx.asal.izinler) }); },
    async roller(ctx) { return json(ctx.res, 200, yetki.roller()); },
    async rolEkle(ctx) { ctx.gerek('yetki.yonet'); const g = await govdeOku(ctx.istek); const r = yetki.rolEkle(g, ctx.asal.gunlukAdi, ctx.asal.izinler); gunluk.yaz('rol-ekle', ctx.asal.gunlukAdi, ctx.istek, { rol: r.id, izinler: r.izinler }); return json(ctx.res, 200, r); },
    async rolGuncelle(ctx) { ctx.gerek('yetki.yonet'); const g = await govdeOku(ctx.istek); const r = yetki.rolGuncelle(ctx.param.id, g, ctx.asal.izinler); gunluk.yaz('rol-duzenle', ctx.asal.gunlukAdi, ctx.istek, { rol: r.id, izinler: r.izinler }); return json(ctx.res, 200, r); },
    async rolSil(ctx) { ctx.gerek('yetki.yonet'); yetki.rolSil(ctx.param.id); gunluk.yaz('rol-sil', ctx.asal.gunlukAdi, ctx.istek, { rol: ctx.param.id }); return json(ctx.res, 200, { tamam: true }); },

    async anahtarlar(ctx) { return json(ctx.res, 200, yetki.anahtarlar(tumYetki(ctx.asal) ? (ctx.q.get('sahip') || null) : sahipAdi(ctx.asal))); },
    async anahtarEkle(ctx) {
      const g = await govdeOku(ctx.istek);
      if (!tumYetki(ctx.asal)) g.sahip = sahipAdi(ctx.asal);               // kendi adina (anahtarla yapiliyorsa anahtarin sahibi adina)
      const { kayit, anahtar } = yetki.anahtarOlustur(g, ctx.asal.gunlukAdi, ctxEb(ctx.asal));
      gunluk.yaz('anahtar-olustur', ctx.asal.gunlukAdi, ctx.istek, { anahtar: kayit.id, ad: kayit.ad, rol: kayit.rol, izinler: kayit.izinler, kapsam: kayit.kapsam, bitis: kayit.bitis, sahip: kayit.sahip });
      return json(ctx.res, 200, { kayit, anahtar, uyari: 'Anahtar yalnız bu yanıtta gösterilir; güvenli bir yere kaydedin.' });
    },
    async anahtar(ctx) { return json(ctx.res, 200, anahtarErisim(ctx.asal, ctx.param.id)); },
    async anahtarGuncelle(ctx) {
      anahtarErisim(ctx.asal, ctx.param.id);
      const g = await govdeOku(ctx.istek); delete g.sahip;
      const k = yetki.anahtarGuncelle(ctx.param.id, g, ctxEb(ctx.asal));
      gunluk.yaz('anahtar-duzenle', ctx.asal.gunlukAdi, ctx.istek, { anahtar: k.id, alanlar: Object.keys(g) });
      return json(ctx.res, 200, k);
    },
    async anahtarYenile(ctx) { anahtarErisim(ctx.asal, ctx.param.id); const { kayit, anahtar } = yetki.anahtarYenile(ctx.param.id); gunluk.yaz('anahtar-yenile', ctx.asal.gunlukAdi, ctx.istek, { anahtar: kayit.id }); return json(ctx.res, 200, { kayit, anahtar }); },
    async anahtarIptal(ctx) { anahtarErisim(ctx.asal, ctx.param.id, true); const k = yetki.anahtarIptal(ctx.param.id, ctx.asal.gunlukAdi); gunluk.yaz('anahtar-iptal', ctx.asal.gunlukAdi, ctx.istek, { anahtar: k.id }); return json(ctx.res, 200, k); },
    async anahtarSil(ctx) { anahtarErisim(ctx.asal, ctx.param.id, true); yetki.anahtarSil(ctx.param.id); gunluk.yaz('anahtar-sil', ctx.asal.gunlukAdi, ctx.istek, { anahtar: ctx.param.id }); return json(ctx.res, 200, { tamam: true }); },
  };
}
