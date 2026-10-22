/**
 * /live: uyeliksiz canli izleme sayfasi. IZLEMEK kimliksiz; ust serit, tema ve duzen
 * yalniz ADMIN oturumunda. Kapaliyken (CAM_RTC_API bos) her sey 404.
 * Harici bir izleme panosu iframe ile gomebilir: bu yanitlarda gomme serbest (CAM_LIVE_EMBED, varsayilan "*"); panelin geri kalani 'self'.
 */
import { readFileSync } from 'node:fs';
import { DatabaseError } from '../core/errors.mjs';
import { join } from 'node:path';
import { readBody, readRawBody, json } from '../core/http.mjs';

const FILES = { 'live.js': 'text/javascript; charset=utf-8', 'live.css': 'text/css; charset=utf-8', 'theme.mjs': 'text/javascript; charset=utf-8' };

export function liveController({ live, config }) {
  const root = join(config.views, '..', 'live');
  const frame = String(config.live.frame ?? '').split(/\s+/).filter((x) => x === '*' || /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x));
  /** Gomme izni: yalniz /live yanitlarinda (guvenlik.basliklar'in frame-ancestors 'self' ve X-Frame-Options'i burada degisir). */
  const embed = (res) => {
    res.removeHeader('X-Frame-Options');
    const csp = String(res.getHeader('Content-Security-Policy') ?? '');
    res.setHeader('Content-Security-Policy', csp.replace(/frame-ancestors [^;]*/, `frame-ancestors ${frame.length ? frame.join(' ') : "'self'"}`));
  };
  const closed = (ctx) => (live.open ? false : (json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' }), true));
  const admin = (principal) => principal?.type === 'member' && principal.role === 'admin';
  return {
    async page(ctx) {
      if (closed(ctx)) return;
      // Sayfa goreli adres kullaniyor: /live -> /live/
      if (!ctx.path.endsWith('/')) { ctx.res.writeHead(301, { Location: '/live/', 'Cache-Control': 'no-store' }); return ctx.res.end(); }
      embed(ctx.res);
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      ctx.res.end(readFileSync(join(root, 'index.html')));
    },
    async serveStatic(ctx) {
      if (closed(ctx)) return;
      const type = FILES[ctx.param.file];
      if (!type) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      embed(ctx.res);
      ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      ctx.res.end(readFileSync(join(root, ctx.param.file)));
    },
    /** Kamera listesi: yalniz yol, ad, cihaz adi (adres/parola YOK). */
    async cameras(ctx) {
      if (closed(ctx)) return;
      embed(ctx.res);
      return json(ctx.res, 200, { cameras: live.cameras, defaultOrder: live.layout().isDefault ? live.layout().paths : [] });
    },
    /** Izleme baglantisi (WHEP): SDP teklifi mediamtx'e gider, cevap tarayiciya doner. Kimliksiz: izlemek herkese acik. */
    async whep(ctx) {
      if (closed(ctx)) return;
      if (!/^application\/sdp\b/i.test(ctx.req.headers['content-type'] ?? '')) return json(ctx.res, 415, { error: 'Gövde application/sdp olmalı', code: 'INVALID_REQUEST' });
      const offer = await readRawBody(ctx.req, 64_000);
      let c;
      try { c = await live.whep(ctx.param.path, offer); }
      catch (e) { console.error('live whep:', e.message); return json(ctx.res, 502, { error: 'Görüntü sunucusuna ulaşılamadı', code: 'RTC' }); }
      if (c.status === 404 && !c.sdp) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      ctx.res.writeHead(c.status, { 'Content-Type': c.status < 300 ? 'application/sdp' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return ctx.res.end(c.sdp);
    },
    async layout(ctx) { if (closed(ctx)) return; embed(ctx.res); return json(ctx.res, 200, live.layout()); },
    /** Ust serit/tema/duzenleme yalniz admin: oturumu panel kendisi cozer (identityOptional; merkez erisimi, ortak cikis, IP dahil). */
    async permissions(ctx) { if (closed(ctx)) return; embed(ctx.res); return json(ctx.res, 200, { canEdit: admin(ctx.principal), name: admin(ctx.principal) ? ctx.principal.name : null }); },
    async writeLayout(ctx) {
      if (closed(ctx)) return;
      if (!admin(ctx.principal)) return json(ctx.res, 403, { error: 'Düzeni yalnız admin kaydeder', code: 'FORBIDDEN' });
      const g = await readBody(ctx.req, 20_000);
      try { const d = await live.writeLayout(g, ctx.principal.name); console.log(`live duzen: ${ctx.principal.name}, ${d.paths.length} kamera`); return json(ctx.res, 200, d); }
      catch (e) { if (e instanceof DatabaseError) throw e; return json(ctx.res, 400, { error: e.message, code: 'INVALID_REQUEST' }); }
    },
  };
}
