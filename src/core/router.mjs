/**
 * Yonlendirici (Laravel Route karsiligi): yontem + yol kalibi (`/api/uyeler/:ad`) -> ara katmanlar + denetleyici.
 * Ara katman imzasi: async (ctx, sonraki) => sonraki(). Denetleyici: async (ctx) => void (yaniti kendisi yazar).
 * ctx: { istek, res, yol, q (URLSearchParams), param, asal?, ... }
 */
export class Router {
  constructor() { this.routes = []; this.groupMiddleware = []; }

  /** Ara katman grubu: grup(['identity'], () => { ... }) icinde tanimlanan rotalar bu ara katmanlari alir. */
  group(middlewares, fn) { const old = this.groupMiddleware; this.groupMiddleware = [...old, ...middlewares]; try { fn(); } finally { this.groupMiddleware = old; } }

  /** when(param) -> bool: rota yalniz bu yuklem tutunca "vardir" (genel /:live kaliplari baska yollari golgelemesin). */
  #add(methods, pattern, controller, middlewares = [], when = null) {
    const parts = pattern.split('/').filter(Boolean);
    const names = []; const re = new RegExp('^/' + parts.map((p) => (p.startsWith(':') ? (names.push(p.slice(1)), '([^/]+)') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$');
    this.routes.push({ methods, pattern, re, names, controller, when, middlewares: [...this.groupMiddleware, ...middlewares] });
    return this;
  }
  get(k, d, a, w) { return this.#add(['GET', 'HEAD'], k, d, a, w); }
  post(k, d, a, w) { return this.#add(['POST'], k, d, a, w); }
  put(k, d, a, w) { return this.#add(['PUT'], k, d, a, w); }
  patch(k, d, a, w) { return this.#add(['PATCH'], k, d, a, w); }
  delete(k, d, a, w) { return this.#add(['DELETE'], k, d, a, w); }
  any(k, d, a, w) { return this.#add(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], k, d, a, w); }

  /** Eslesen rota ve yol parametreleri; yontem uyusmazsa { methodNone: true }. */
  find(method, path) {
    let methodNone = false;
    for (const r of this.routes) {
      const m = r.re.exec(path); if (!m) continue;
      const param = {}; r.names.forEach((a, i) => { try { param[a] = decodeURIComponent(m[i + 1]); } catch { param[a] = m[i + 1]; } });
      if (r.when && !r.when(param)) continue;
      if (!r.methods.includes(method)) { methodNone = true; continue; }
      return { route: r, param };
    }
    return methodNone ? { methodNone: true } : null;
  }

  /** Dokumantasyon icin rota listesi. */
  list() { return this.routes.map((r) => ({ methods: r.methods, pattern: r.pattern, middlewares: r.middlewares.map((a) => a.label ?? a.name ?? '?') })); }
}

/** Ara katman zincirini calistirir, sonunda denetleyiciyi cagirir. */
export async function chain(middlewares, ctx, controller) {
  let i = -1;
  const step = async (n) => {
    if (n <= i) throw new Error('sonraki() iki kez çağrıldı');
    i = n;
    if (n < middlewares.length) return middlewares[n](ctx, () => step(n + 1));
    return controller(ctx);
  };
  return step(0);
}
