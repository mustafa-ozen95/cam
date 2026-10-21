/**
 * Yetki ara katmanlari: izin(...) belirli bir izni zorunlu kilar; herhangi(...) listeden biri yeterli.
 * ctx.gerek(izin) ve ctx.kanalGerek(kanal) denetleyicilere de verilir (dinamik denetim icin).
 */
import { YetkiHatasi } from '../models/yetki.mjs';

export const gerekKur = (asal) => ({
  gerek: (izin) => { if (!asal.izinVar(izin)) throw new YetkiHatasi('YETKI_YOK', `Bu işlem için izin gerekir: ${izin}`, 403, { gerekenIzin: izin }); },
  kanalGerek: (k) => { if (!asal.kanalIzinli(k)) throw new YetkiHatasi('KAPSAM_DISI', 'Bu kamera erişim kapsamınızın dışında', 403, { kanal: k }); return k; },
});

export const izin = (...izinler) => {
  const ara = async (ctx, sonraki) => {
    Object.assign(ctx, gerekKur(ctx.asal));
    for (const i of izinler) ctx.gerek(i);
    return sonraki();
  };
  ara.ad = `izin:${izinler.join('+')}`;
  return ara;
};
export const herhangi = (...izinler) => {
  const ara = async (ctx, sonraki) => {
    Object.assign(ctx, gerekKur(ctx.asal));
    if (!ctx.asal.herhangiIzin(izinler)) throw new YetkiHatasi('YETKI_YOK', `Bu işlem için izin gerekir: ${izinler.join(' | ')}`, 403, { gerekenIzin: izinler[0] });
    return sonraki();
  };
  ara.ad = `izin:${izinler.join('|')}`;
  return ara;
};
