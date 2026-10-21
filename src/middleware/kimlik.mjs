/**
 * Kimlik ara katmani: istegi yapan ASAL'i cozer ve ctx.asal'a koyar.
 * Sira: Bearer kp_... (API anahtari) -> oturum cerezi. Anahtarda IP listesi, sure, iptal ve hiz denetlenir.
 * Anahtar, SAHIBI olan uyenin turevidir: sahip silinmis/suresi dolmus/IP disinda/merkezde erisimi kalkmissa anahtar da islemez; anahtarin
 * izin ve kapsami hicbir zaman sahibin GUNCEL rolunun ustune cikmaz. (Sahibi uye olmayan anahtar — yetki.yonet'in verdigi entegrasyon etiketi — kendi haklariyla calisir.)
 * `kimlik` oturum zorunlu; `kimlikIstege` yoksa gecer (ctx.asal = null).
 */
import { Asal, YetkiHatasi, ipEslesir, izinKesisim, kapsamKesisim } from '../models/yetki.mjs';
import { cerezOku, istemciIp, json } from '../core/http.mjs';

export function kimlikKur({ uyeler, yetki, cihazlar, yapilandirma, baglar = null }) {
  const CTX = { cihazIdOf: (k) => cihazlar.grup.cihazIdOf(k), kanalToplam: () => cihazlar.grup.kanalToplam };
  const uyeAsal = (u, yontem = 'cerez') => new Asal({ tur: 'uye', yontem, ad: u.ad, kimlik: `uye:${u.ad.toLowerCase()}`, rol: u.rol, izinler: yetki.rolIzinleri(u.rol), kapsam: u.kapsam ?? null, bitis: u.bitis ?? null, ipler: u.ipler ?? [], hizLimiti: yapilandirma.yetki.uyeHizLimiti, eszamanliAkis: yapilandirma.yetki.uyeAkisSiniri }, CTX);
  const anahtarAsal = (a, yontem = 'anahtar') => new Asal({ tur: 'anahtar', yontem, ad: a.ad, sahip: a.sahip ?? null, kimlik: `anahtar:${a.id}`, anahtarId: a.id, rol: a.rol, izinler: yetki.anahtarIzinleri(a), kapsam: a.kapsam ?? null, bitis: a.bitis ?? null, ipler: a.ipler ?? [], hizLimiti: a.hizLimiti, eszamanliAkis: a.eszamanliAkis }, CTX);

  function coz(ctx) {
    const { istek } = ctx;
    const ip = istemciIp(istek, yapilandirma.sunucu.guvenilenIpBasligi); ctx.ip = ip;
    const m = /^Bearer\s+(\S+)$/i.exec(String(istek.headers.authorization ?? ''));
    const bearer = m ? m[1] : null;
    if (bearer) {
      const a = yetki.anahtarDogrula(bearer, ip);
      const sahip = a.sahip ? uyeler.bul(a.sahip) : null;
      if (sahip) {
        if (sahip.bitis && Date.parse(sahip.bitis) <= Date.now()) throw new YetkiHatasi('ANAHTAR_SAHIBI', 'Anahtarın sahibinin hesap süresi dolmuş', 401);
        if (baglar && !baglar.erisebilirMi(sahip.ad)) throw new YetkiHatasi('MERKEZ_ERISIM', 'Anahtar sahibinin merkezdeki erişimi kalktı', 401);
        if (sahip.ipler?.length && !ipEslesir(ip, sahip.ipler)) throw new YetkiHatasi('IP_ENGELLI', 'Bu IP adresinden erişim yok', 403);
      }
      yetki.kullanimiKaydet(a.id, ip);
      const asal = anahtarAsal(a);
      if (sahip) {
        // sahibin simdiki hakkini asamaz: rolu dusurulduyse anahtar da ayni anda daralir
        const sahipIzin = yetki.rolIzinleri(sahip.rol);
        if (!sahipIzin.includes('*')) { asal.izinler = izinKesisim(asal.izinler, sahipIzin); asal.kume = new Set(asal.izinler); }
        if (sahip.kapsam) asal.kapsam = kapsamKesisim(asal.kapsam, sahip.kapsam, cihazlar.grup.kanalToplam, (k) => cihazlar.grup.cihazIdOf(k));
      }
      return asal;
    }
    const u = uyeler.oturumCoz(cerezOku(istek.headers.cookie, yapilandirma.oturum.cerez));
    if (!u) return null;
    // Merkezden bagli uye: merkezde erisimi kalktiysa cerez islemez (bkz. MerkezBaglari.erisebilirMi).
    if (baglar && !baglar.erisebilirMi(u.ad)) throw new YetkiHatasi('MERKEZ_ERISIM', 'Merkezdeki erişiminiz kalktığı için oturum kapatıldı', 401);
    // Ortak cikis: merkezden ya da bagli bir panelden cikildiysa bu oturum kapanir (bkz. MerkezBaglari.cikisSonrasiMi).
    if (baglar && baglar.cikisSonrasiMi(u.ad, u.acilis)) throw new YetkiHatasi('MERKEZ_CIKIS', 'Merkezden ya da bağlı bir panelden çıkış yapıldığı için oturum kapatıldı', 401);
    if (u.ipler?.length && !ipEslesir(ip, u.ipler)) throw new YetkiHatasi('IP_ENGELLI', 'Bu IP adresinden erişim yok', 403);
    return uyeAsal(u);
  }

  const kimlik = async (ctx, sonraki) => {
    ctx.asal = coz(ctx);
    if (!ctx.asal) return json(ctx.res, 401, { hata: 'Oturum gerekli', kod: 'OTURUM_GEREKLI' });
    yetki.hizDene(ctx.asal);
    return sonraki();
  };
  kimlik.ad = 'kimlik';
  const kimlikIstege = async (ctx, sonraki) => { ctx.ip = istemciIp(ctx.istek, yapilandirma.sunucu.guvenilenIpBasligi); try { ctx.asal = coz(ctx); } catch { ctx.asal = null; } return sonraki(); };
  kimlikIstege.ad = 'kimlik?';
  return { kimlik, kimlikIstege, uyeAsal, anahtarAsal, CTX };
}
