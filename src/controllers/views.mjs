/** Gorunumler ve statik dosyalar (resources/views/web): giris/ana sayfa, css, font, simge; API dokumani (docs/). */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { json } from '../core/http.mjs';
import { HUB_ERRORS } from './hub.mjs';

const escape = (m) => String(m).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPES = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };

export function viewController({ config, hub = null }) {
  const root = config.views;
  const secure = (base, path) => { const p = normalize(join(base, path)); return p.startsWith(normalize(base) + sep) && !path.includes('..') ? p : null; };   // kok + ayrac: kardes klasore (web2/) kacis yok
  return {
    async mainPage(ctx) {
      const who = ctx.principal?.type === 'member';   // identityOptional: imza + merkez erisimi + ortak cikis + IP
      const file = join(root, who ? 'index.html' : 'login.html');
      let html = readFileSync(file, 'utf8').replaceAll('Kamera Paneli', config.server.header).replaceAll('Kamera paneli', config.server.header);
      if (!who) {
        // Merkez ile giris dugmesi yalnizca yapilandirilmissa; hata metni adres cubugundaki KODA gore sunucuda secilir.
        const open = !!hub?.isEnabled();
        // EYS ile ayni: merkez acikken birincil dugme + "veya" ayraci, parola formu katli; kapaliyken form acik ve birincil.
        const button = open ? `<a class="btn btn--primary btn--block" href="/login/hub">${escape(config.identity.name)} ile giriş</a>\n\n    <div class="gate__ayrac"><span>veya</span></div>` : '';
        const error = HUB_ERRORS[ctx.q.get('hub') ?? ''] ?? '';
        html = html.replace('<!--HUB-->', button)
          .replace('<!--HUB_ERROR-->', error ? `<div class="alert alert--danger gate__alert" role="alert">${escape(error)}</div>` : '')
          .replace('<!--OPEN-->', open ? '' : ' open')
          .replace('<!--PRIMARY-->', open ? '' : ' btn--primary');
      }
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      ctx.res.end(html);
    },
    async serveStatic(ctx) {
      // Kimliksiz sunulan varliklar yalniz giris sayfasinin css/js/font/simgesi: .json/.md (yapi ozeti, belge) burada SUNULMAZ.
      const extension = extname(ctx.path);
      const type = extension === '.json' || extension === '.md' ? undefined : TYPES[extension];
      const p = type && /^\/(css|fonts|js)\/|^\/icon\.svg$/.test(ctx.path) ? secure(root, ctx.path) : null;
      if (!p || !existsSync(p)) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); ctx.res.end(readFileSync(p));
    },
    /** /docs/<file> : API dokumani (markdown/openapi) — yalniz oturumla (rota kimlik ara katmaninin arkasinda), yalniz okuma. */
    async docs(ctx) {
      const name = ctx.param.file || 'api-v1.tr.md';
      const p = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? secure(config.docsDir, '/' + name) : null;
      if (!p || !existsSync(p)) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      ctx.res.writeHead(200, { 'Content-Type': TYPES[extname(name)] ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }); ctx.res.end(readFileSync(p));
    },
  };
}
