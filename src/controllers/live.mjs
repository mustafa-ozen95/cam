/**
 * /live: uyeliksiz canli izleme sayfasi. IZLEMEK kimliksiz; ust serit, tema ve duzen
 * yalniz ADMIN oturumunda. Goruntu panelin canli MP4 akisi (sendLiveMp4). Kapaliyken (CAM_LIVE=0) her sey 404.
 * Harici bir izleme panosu iframe ile gomebilir: bu yanitlarda gomme serbest (CAM_LIVE_EMBED, varsayilan "*"); panelin geri kalani 'self'.
 */
import { readFileSync } from 'node:fs';
import { DatabaseError } from '../core/errors.mjs';
import { join } from 'node:path';
import { readBody, json } from '../core/http.mjs';
import { sendLiveMp4 } from './streams.mjs';

const FILES = { 'live.js': 'text/javascript; charset=utf-8', 'live.css': 'text/css; charset=utf-8', 'theme.mjs': 'text/javascript; charset=utf-8' };

export function liveController({ live, config, devices }) {
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
    /**
     * Canli goruntu: panelin /stream/live-mp4'u ile ayni yayin (alt akis, Extra1; ayni kanali izleyen panel ve /live
     * cihaza tek baglanti acar). Kimliksiz: izlemek herkese acik, ama yalniz listelenen kameralar. h264=1: tarayici
     * kameranin kodegini (H.265) oynatamiyor, sunucu cevirir.
     */
    async stream(ctx) {
      if (closed(ctx)) return;
      const channel = live.channel(ctx.param.path);
      if (channel === null) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      return sendLiveMp4(ctx.res, devices.group.feedMp4(channel, 'Extra1', ctx.q.get('h264') === '1'));
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
