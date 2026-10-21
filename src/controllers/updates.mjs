/** Guncelleme kontrolu (guncelleme.denetle): durum ve "simdi kontrol et". Yalnizca bakar; guncelleme sunucudan yapilir. */
import { json } from '../core/http.mjs';

export function guncellemeDenetleyici({ guncelleme }) {
  const ozet = () => ({ calisan: guncelleme.surum(), depo: guncelleme.ayar.depo, son: guncelleme.son(), yeniVar: guncelleme.yeniVar() });
  return {
    async durum(ctx) { return json(ctx.res, 200, ozet()); },
    async denetle(ctx) { await guncelleme.denetle(ctx.asal?.ad ?? 'bilinmiyor'); return json(ctx.res, 200, ozet()); },
  };
}
