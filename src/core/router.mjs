/**
 * Yonlendirici (Laravel Route karsiligi): yontem + yol kalibi (`/api/uyeler/:ad`) -> ara katmanlar + denetleyici.
 * Ara katman imzasi: async (ctx, sonraki) => sonraki(). Denetleyici: async (ctx) => void (yaniti kendisi yazar).
 * ctx: { istek, res, yol, q (URLSearchParams), param, asal?, ... }
 */
export class Yonlendirici {
  constructor() { this.rotalar = []; this.grupAra = []; }

  /** Ara katman grubu: grup(['kimlik'], () => { ... }) icinde tanimlanan rotalar bu ara katmanlari alir. */
  grup(aralar, fn) { const eski = this.grupAra; this.grupAra = [...eski, ...aralar]; try { fn(); } finally { this.grupAra = eski; } }

  #ekle(yontemler, kalip, denetleyici, aralar = []) {
    const parcalar = kalip.split('/').filter(Boolean);
    const adlar = []; const re = new RegExp('^/' + parcalar.map((p) => (p.startsWith(':') ? (adlar.push(p.slice(1)), '([^/]+)') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$');
    this.rotalar.push({ yontemler, kalip, re, adlar, denetleyici, aralar: [...this.grupAra, ...aralar] });
    return this;
  }
  get(k, d, a) { return this.#ekle(['GET', 'HEAD'], k, d, a); }
  post(k, d, a) { return this.#ekle(['POST'], k, d, a); }
  put(k, d, a) { return this.#ekle(['PUT'], k, d, a); }
  patch(k, d, a) { return this.#ekle(['PATCH'], k, d, a); }
  delete(k, d, a) { return this.#ekle(['DELETE'], k, d, a); }
  herhangi(k, d, a) { return this.#ekle(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], k, d, a); }

  /** Eslesen rota ve yol parametreleri; yontem uyusmazsa { yontemYok: true }. */
  bul(yontem, yol) {
    let yontemYok = false;
    for (const r of this.rotalar) {
      const m = r.re.exec(yol); if (!m) continue;
      if (!r.yontemler.includes(yontem)) { yontemYok = true; continue; }
      const param = {}; r.adlar.forEach((a, i) => { try { param[a] = decodeURIComponent(m[i + 1]); } catch { param[a] = m[i + 1]; } });
      return { rota: r, param };
    }
    return yontemYok ? { yontemYok: true } : null;
  }

  /** Dokumantasyon icin rota listesi. */
  liste() { return this.rotalar.map((r) => ({ yontemler: r.yontemler, kalip: r.kalip, aralar: r.aralar.map((a) => a.ad ?? a.name ?? '?') })); }
}

/** Ara katman zincirini calistirir, sonunda denetleyiciyi cagirir. */
export async function zincir(aralar, ctx, denetleyici) {
  let i = -1;
  const adim = async (n) => {
    if (n <= i) throw new Error('sonraki() iki kez çağrıldı');
    i = n;
    if (n < aralar.length) return aralar[n](ctx, () => adim(n + 1));
    return denetleyici(ctx);
  };
  return adim(0);
}
