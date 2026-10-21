/** Denetim gunlugu (gunluk.oku). */
import { json } from '../core/http.mjs';

export function gunlukDenetleyici({ gunluk }) {
  return {
    async liste(ctx) {
      const q = ctx.q;
      return json(ctx.res, 200, await gunluk.listele({
        boyut: Math.min(200, Math.max(10, Number(q.get('boyut')) || 50)), sayfa: Math.max(1, Number(q.get('sayfa')) || 1),
        olay: q.get('olay') || '', kullanici: q.get('kullanici') || '', ip: q.get('ip') || '', gun: q.get('gun') || '',
      }));
    },
    async dogrula(ctx) { return json(ctx.res, 200, await gunluk.dogrula()); },
  };
}
