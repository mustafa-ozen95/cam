/** Guncelleme kontrolu (update.check): durum ve "simdi kontrol et". Yalnizca bakar; guncelleme sunucudan yapilir. */
import { json } from '../core/http.mjs';

export function updateController({ updates }) {
  const summary = () => ({ running: updates.version(), repo: updates.setting.repo, last: updates.last(), hasNew: updates.hasNew() });
  return {
    async status(ctx) { return json(ctx.res, 200, summary()); },
    async check(ctx) { await updates.check(ctx.principal?.name ?? 'unknown'); return json(ctx.res, 200, summary()); },
  };
}
