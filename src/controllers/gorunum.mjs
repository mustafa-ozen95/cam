/** Gorunumler ve statik dosyalar (resources/views/web): giris/ana sayfa, css, font, simge; API dokumani (docs/). */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { json } from '../core/http.mjs';
import { MERKEZ_HATALARI } from './merkez.mjs';

const kacir = (m) => String(m).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TURLER = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };

export function gorunumDenetleyici({ yapilandirma, merkez = null }) {
  const kok = yapilandirma.gorunumler;
  const guvenli = (taban, yol) => { const p = normalize(join(taban, yol)); return p.startsWith(normalize(taban) + sep) && !yol.includes('..') ? p : null; };   // kok + ayrac: kardes klasore (web2/) kacis yok
  return {
    async anaSayfa(ctx) {
      const kim = ctx.asal?.tur === 'uye';   // kimlikIstege: imza + merkez erisimi + ortak cikis + IP
      const dosya = join(kok, kim ? 'index.html' : 'giris.html');
      let html = readFileSync(dosya, 'utf8').replaceAll('Kamera Paneli', yapilandirma.sunucu.baslik).replaceAll('Kamera paneli', yapilandirma.sunucu.baslik);
      if (!kim) {
        // Merkez ile giris dugmesi yalnizca yapilandirilmissa; hata metni adres cubugundaki KODA gore sunucuda secilir.
        const acik = !!merkez?.acikMi();
        // EYS ile ayni: merkez acikken birincil dugme + "veya" ayraci, parola formu katli; kapaliyken form acik ve birincil.
        const dugme = acik ? `<a class="btn btn--primary btn--block" href="/giris/merkez">${kacir(yapilandirma.kimlik.ad)} ile giriş</a>\n\n    <div class="gate__ayrac"><span>veya</span></div>` : '';
        const hata = MERKEZ_HATALARI[ctx.q.get('merkez') ?? ''] ?? '';
        html = html.replace('<!--MERKEZ-->', dugme)
          .replace('<!--MERKEZ_HATA-->', hata ? `<div class="alert alert--danger gate__alert" role="alert">${kacir(hata)}</div>` : '')
          .replace('<!--ACIK-->', acik ? '' : ' open')
          .replace('<!--BIRINCIL-->', acik ? '' : ' btn--primary');
      }
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      ctx.res.end(html);
    },
    async statik(ctx) {
      // Kimliksiz sunulan varliklar yalniz giris sayfasinin css/js/font/simgesi: .json/.md (yapi ozeti, belge) burada SUNULMAZ.
      const uzanti = extname(ctx.yol);
      const tur = uzanti === '.json' || uzanti === '.md' ? undefined : TURLER[uzanti];
      const p = tur && /^\/(css|fonts|js)\/|^\/simge\.svg$/.test(ctx.yol) ? guvenli(kok, ctx.yol) : null;
      if (!p || !existsSync(p)) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      ctx.res.writeHead(200, { 'Content-Type': tur, 'Cache-Control': 'no-cache' }); ctx.res.end(readFileSync(p));
    },
    /** /dokuman/<dosya> : API dokumani (markdown/openapi) — yalniz oturumla (rota kimlik ara katmaninin arkasinda), yalniz okuma. */
    async dokuman(ctx) {
      const ad = ctx.param.dosya || 'api-v1.tr.md';
      const p = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ad) ? guvenli(yapilandirma.dokumanKlasoru, '/' + ad) : null;
      if (!p || !existsSync(p)) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      ctx.res.writeHead(200, { 'Content-Type': TURLER[extname(ad)] ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }); ctx.res.end(readFileSync(p));
    },
  };
}
