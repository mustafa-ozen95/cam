/** Giris / cikis / ben. */
import { cerezOku, cerezYaz, govdeOku, json } from '../core/http.mjs';
import { HataKisiti, izinGenislet } from '../models/yetki.mjs';

export function girisDenetleyici({ uyeler, gunluk, yapilandirma, merkez = null, baglar = null }) {
  /**
   * IP basina giris kisiti: parola karmasi (scrypt) HESAPLANMADAN once bakilir. Uye adi basina kilit (uyeler.dogrula) kullanici adini
   * degistirerek asilabiliyordu; bu kisit istemcinin yaptirabilecegi isi adlardan bagimsiz sinirlar. Ters vekil arkasinda gercek IP icin
   * KAMERA_IP_BASLIGI verilmeli (yoksa bu kisit vekil adresine uygulanir).
   */
  const ipKisit = new HataKisiti({ en: 20, pencereMs: 60_000, kilitMs: 60_000 });
  const temizlik = setInterval(() => { const s = Date.now(); for (const [ip, d] of ipKisit.ipler) if (s - d.ilk > ipKisit.pencereMs && d.kilit < s) ipKisit.ipler.delete(ip); }, 60_000);
  temizlik.unref?.();
  return {
    async giris(ctx) {
      const { istek, res } = ctx;
      const bekle = ipKisit.kilitliMi(ctx.ip);
      if (bekle) { res.setHeader('Retry-After', String(bekle)); return json(res, 429, { hata: `Çok fazla deneme. ${bekle} sn sonra tekrar deneyin.`, kod: 'COK_FAZLA_DENEME' }); }
      const g = await govdeOku(istek, 4096);
      try {
        const u = await uyeler.dogrula(g.ad, g.parola, ctx.ip);
        ipKisit.basari(ctx.ip);
        cerezYaz(res, yapilandirma.oturum.cerez, uyeler.oturumCerezi(u), yapilandirma.oturum.gun * 86400, yapilandirma.sunucu.vekil || !!res.socket?.encrypted);
        gunluk.yaz('giris', u.ad, istek);
        return json(res, 200, { ad: u.ad, rol: u.rol });
      } catch (err) { ipKisit.hata(ctx.ip); gunluk.yaz('giris-hata', String(g.ad ?? '').slice(0, 40), istek, { neden: err.message }); return json(res, 401, { hata: err.message, kod: 'GIRIS' }); }
    },
    /**
     * Cikis yalniz cerezi silmez: uyenin oturum surumu artar, calinmis/kopyalanmis cerezler de gecersiz olur.
     * ORTAK CIKIS: merkezden bagli uyenin cikisi merkeze bildirilir; merkez kendi oturumunu ve diger panelleri kapatir.
     * Beklenmez: merkeze ulasilamasa da cikis olur, yalniz ortak kalmaz.
     */
    async cikis(ctx) {
      const kim = uyeler.oturumCoz(cerezOku(ctx.istek.headers.cookie, yapilandirma.oturum.cerez));
      if (kim) {
        uyeler.oturumuKapat(kim.ad); gunluk.yaz('cikis', kim.ad, ctx.istek);
        const bag = baglar?.adaGore(kim.ad);
        if (bag && merkez?.acikMi()) merkez.oturumKapandi(bag.sub).catch((e) => console.error('merkeze çıkış bildirilemedi:', e.message));
      }
      cerezYaz(ctx.res, yapilandirma.oturum.cerez, '', 0, yapilandirma.sunucu.vekil || !!ctx.res.socket?.encrypted);
      return json(ctx.res, 200, { tamam: true });
    },
    async ben(ctx) {
      const a = ctx.asal;
      return json(ctx.res, 200, { ad: a.ad, rol: a.rol, tur: a.tur, yontem: a.yontem, izinler: izinGenislet(a.izinler), kapsam: a.kapsam, bitis: a.bitis, hizLimiti: a.hizLimiti, anahtarId: a.anahtarId });
    },
    /** Uyenin kendi gorunum tercihleri. API anahtari bir kisi degil: tercihi yok (403). */
    async tercih(ctx) {
      if (ctx.asal.tur !== 'uye') return json(ctx.res, 403, { hata: 'Tercih yalnız üye oturumunda', kod: 'YASAK' });
      return json(ctx.res, 200, uyeler.tercih(ctx.asal.ad));
    },
    async tercihYaz(ctx) {
      if (ctx.asal.tur !== 'uye') return json(ctx.res, 403, { hata: 'Tercih yalnız üye oturumunda', kod: 'YASAK' });
      const g = await govdeOku(ctx.istek, 16_384);
      try { return json(ctx.res, 200, uyeler.tercihYaz(ctx.asal.ad, g)); } catch (e) { return json(ctx.res, 404, { hata: e.message, kod: 'BULUNAMADI' }); }
    },
  };
}
