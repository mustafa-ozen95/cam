/**
 * Uygulama cekirdegi: HTTP sunucusu + istek dongusu (rota bulma, ara katman zinciri, hata yaniti).
 * Rota tanimlari routes/ altinda; is mantigi denetleyicilerde (src/controllers) ve hizmetlerde (src/services). Burada mantik YOK.
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { Router, chain } from './router.mjs';
import { errorResponse, json } from './http.mjs';

export class App {
  constructor({ config, services }) {
    this.config = config; this.services = services;
    this.router = new Router();
    this.generalMiddlewares = [];                     // her istekte calisan ara katmanlar (guvenlik basliklari gibi)
  }
  use(middleware) { this.generalMiddlewares.push(middleware); return this; }

  req = async (req, res) => {
    // Bozuk istek hedefi ('//' gibi) yonlendirmeden ONCE de yanitlanir: ayiklama try icinde, istek yanitsiz kalip baglanti asili kalmaz.
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { error: 'Geçersiz istek', code: 'INVALID_REQUEST' }); }
    const ctx = { req, res, path: url.pathname, q: url.searchParams, param: {}, app: this, services: this.services, config: this.config };
    try {
      const result = this.router.find(req.method, ctx.path);
      if (!result) return await chain(this.generalMiddlewares, ctx, () => json(res, 404, { error: 'Yok', code: 'NOT_FOUND' }));
      if (result.methodNone) return await chain(this.generalMiddlewares, ctx, () => json(res, 405, { error: 'Yöntem desteklenmiyor', code: 'METHOD_NOT_ALLOWED' }));
      ctx.param = result.param; ctx.route = result.route;
      await chain([...this.generalMiddlewares, ...result.route.middlewares], ctx, result.route.controller);
    } catch (e) { errorResponse(res, e); }
  };

  listen() {
    const { server } = this.config;
    const s = createServer(this.req);
    s.listen(server.port, server.address, () => console.log(`Kamera paneli: http://${server.address}:${server.port}/`));
    if (server.tls && existsSync(server.tls.cert) && existsSync(server.tls.key)) {
      createHttpsServer({ cert: readFileSync(server.tls.cert), key: readFileSync(server.tls.key) }, this.req).listen(server.tls.port, server.address, () => console.log(`Kamera paneli (HTTPS): :${server.tls.port}`));
    }
    return s;
  }
}
