/**
 * Canli izleme sayfalari (/<yol>/, kayitlar: models/live-page.mjs). Rotalar tek kalipla (/:live/...) her sayfaya hizmet eder;
 * erisim karari burada, SAYFA KAYDINA gore verilir (canView):
 *  - public sayfa: izlemek kimliksiz; harici pano iframe ile gomebilir (CAM_LIVE_EMBED, varsayilan "*").
 *  - private sayfa: oturum yoksa ayni adreste giris sayfasi; yetkisi yetmeyene 403. Gomme 'self'. Kapsam (scope) uygulanir.
 * Sayfa YALNIZ kendi duzenindeki kameralari listeler ve oynatir (WHEP): baska sayfanin kamerasi bu sayfanin ucundan cekilemez.
 * Ust serit, tema ve duzen kaydi yalniz livepage.manage izni olan kimlikte; editor tum kameralari gorur (taslak onizleme).
 * Kapaliyken (CAM_RTC_API bos) her sey 404.
 */
import { readFileSync } from 'node:fs';
import { DatabaseError } from '../core/errors.mjs';
import { join } from 'node:path';
import { readBody, readRawBody, json } from '../core/http.mjs';
import { canView } from '../models/live-page.mjs';
import { escape } from './views.mjs';

const FILES = { 'live.js': 'text/javascript; charset=utf-8', 'live.css': 'text/css; charset=utf-8', 'theme.mjs': 'text/javascript; charset=utf-8' };
const channelOf = (path) => Number(String(path).slice(1));

export function liveController({ live, livePages, config, permissions, auditLog, view }) {
  const root = join(config.views, '..', 'live');
  const frame = String(config.live.frame ?? '').split(/\s+/).filter((x) => x === '*' || /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x));
  /** Gomme izni: yalniz public sayfa yanitlarinda (guvenlik.basliklar'in frame-ancestors 'self' ve X-Frame-Options'i burada degisir). */
  const embed = (res, page) => {
    if (page.access !== 'public') return;
    res.removeHeader('X-Frame-Options');
    const csp = String(res.getHeader('Content-Security-Policy') ?? '');
    res.setHeader('Content-Security-Policy', csp.replace(/frame-ancestors [^;]*/, `frame-ancestors ${frame.length ? frame.join(' ') : "'self'"}`));
  };
  const notFound = (ctx) => json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
  const canEdit = (principal) => !!principal?.hasPermission('livepage.manage');
  /** Kapsamli kimlik yalniz kendi kanallarini gorur (private sayfada ve editorde; public sayfa herkese aynidir). */
  const scoped = (principal, page) => !!principal?.scope && (page.access === 'private' || canEdit(principal));
  const inScope = (principal, page) => (path) => !scoped(principal, page) || principal.channelAllowed(channelOf(path));

  /**
   * Ortak kapi: kapali/yok -> 404, yetkisiz -> 401/403 (yanit yazilir, null doner); gecerse sayfa kaydi.
   * Kimlikli isteklerde hiz siniri (identityOptional uygulamaz).
   */
  const gate = (ctx) => {
    if (!live.open) { notFound(ctx); return null; }
    const page = livePages.bySlug(ctx.param.live);
    if (!page) { notFound(ctx); return null; }
    if (ctx.principal) permissions.attemptRate(ctx.principal);
    if (canView(page, ctx.principal) || canEdit(ctx.principal)) return page;
    json(ctx.res, ctx.principal ? 403 : 401, ctx.principal ? { error: 'Bu sayfayı görme yetkiniz yok', code: 'PERMISSION_DENIED' } : { error: 'Oturum gerekli', code: 'LOGIN_REQUIRED' });
    return null;
  };
  /** Sayfanin duzenindeki (editorde: tum) kameralar, kapsam suzgeciyle. */
  const allowedPaths = (ctx, page) => {
    const all = canEdit(ctx.principal) ? live.cameras.map((k) => k.path) : live.layoutOf(page).paths;
    return all.filter(inScope(ctx.principal, page));
  };

  return {
    async page(ctx) {
      if (!live.open) return notFound(ctx);
      const page = livePages.bySlug(ctx.param.live);
      if (!page) return notFound(ctx);
      // Sayfa goreli adres kullaniyor: /yol -> /yol/
      if (!ctx.path.endsWith('/')) { ctx.res.writeHead(301, { Location: `/${encodeURIComponent(page.slug)}/`, 'Cache-Control': 'no-store' }); return ctx.res.end(); }
      // Oturumsuz private sayfa: giris formu AYNI adreste (giristen sonra sayfa yenilenir, kullanici dogrudan buraya duser).
      if (!ctx.principal && page.access !== 'public') return view.loginPage(ctx);
      if (ctx.principal && !canView(page, ctx.principal) && !canEdit(ctx.principal)) {
        ctx.res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return ctx.res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>${escape(page.name)}</title><body style="font-family:sans-serif;padding:2rem">Bu sayfayı görme yetkiniz yok. <a href="/">Panele dön</a></body></html>`);
      }
      if (!gate(ctx)) return;
      embed(ctx.res, page);
      const html = readFileSync(join(root, 'index.html'), 'utf8').replaceAll('<!--TITLE-->', escape(page.name || 'Kameralar'));
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      ctx.res.end(html);
    },
    async serveStatic(ctx) {
      const page = gate(ctx); if (!page) return;
      const type = FILES[ctx.param.file];
      if (!type) return notFound(ctx);
      embed(ctx.res, page);
      ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      ctx.res.end(readFileSync(join(root, ctx.param.file)));
    },
    /** Kamera listesi: yalniz yol, ad, cihaz adi (adres/parola YOK); izleyiciye yalniz sayfanin duzenindekiler. */
    async cameras(ctx) {
      const page = gate(ctx); if (!page) return;
      embed(ctx.res, page);
      const allowed = new Set(allowedPaths(ctx, page));
      const layout = live.layoutOf(page);
      return json(ctx.res, 200, { cameras: live.cameras.filter((k) => allowed.has(k.path)), defaultOrder: canEdit(ctx.principal) && layout.isDefault ? layout.paths : [] });
    },
    /** Izleme baglantisi (WHEP): SDP teklifi mediamtx'e gider, cevap tarayiciya doner. Yalniz bu sayfanin izin verdigi yollar. */
    async whep(ctx) {
      const page = gate(ctx); if (!page) return;
      if (!/^application\/sdp\b/i.test(ctx.req.headers['content-type'] ?? '')) return json(ctx.res, 415, { error: 'Gövde application/sdp olmalı', code: 'INVALID_REQUEST' });
      const offer = await readRawBody(ctx.req, 64_000);
      let c;
      try { c = await live.whep(ctx.param.path, offer, allowedPaths(ctx, page)); }
      catch (e) { console.error('live whep:', e.message); return json(ctx.res, 502, { error: 'Görüntü sunucusuna ulaşılamadı', code: 'RTC' }); }
      if (c.status === 404 && !c.sdp) return notFound(ctx);
      ctx.res.writeHead(c.status, { 'Content-Type': c.status < 300 ? 'application/sdp' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return ctx.res.end(c.sdp);
    },
    async layout(ctx) {
      const page = gate(ctx); if (!page) return;
      embed(ctx.res, page);
      const d = live.layoutOf(page), ok = inScope(ctx.principal, page);
      return json(ctx.res, 200, { ...d, paths: d.paths.filter(ok) });
    },
    /** Ust serit/tema/duzenleme yalniz livepage.manage: oturumu panel kendisi cozer (identityOptional; merkez erisimi, ortak cikis, IP dahil). */
    async permissions(ctx) {
      const page = gate(ctx); if (!page) return;
      embed(ctx.res, page);
      const edit = canEdit(ctx.principal);
      return json(ctx.res, 200, { canEdit: edit, name: edit ? ctx.principal.name : null, title: page.name, access: page.access });
    },
    async writeLayout(ctx) {
      const page = gate(ctx); if (!page) return;
      if (!canEdit(ctx.principal)) return json(ctx.res, 403, { error: 'Düzeni yalnız canlı sayfa yöneticisi kaydeder', code: 'FORBIDDEN', requiredPermission: 'livepage.manage' });
      const g = await readBody(ctx.req, 20_000);
      // Kapsamli yonetici kapsami disindaki kamerayi sayfaya (ozellikle public sayfaya) koyamaz.
      if (Array.isArray(g?.paths) && ctx.principal.scope && !g.paths.every((y) => ctx.principal.channelAllowed(channelOf(y)))) return json(ctx.res, 403, { error: 'Bu kamera erişim kapsamınızın dışında', code: 'OUT_OF_SCOPE' });
      try {
        const d = await live.writeLayout(page, g, ctx.principal.name);
        auditLog.write('livepage-layout', ctx.principal.auditActor, ctx.req, { page: page.id, slug: page.slug, cameras: d.paths.length });
        return json(ctx.res, 200, d);
      } catch (e) { if (e instanceof DatabaseError || e.status) throw e; return json(ctx.res, 400, { error: e.message, code: 'INVALID_REQUEST' }); }
    },
  };
}
