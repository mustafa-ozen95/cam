/**
 * /live: uyeliksiz canli izleme sayfasi. IZLEMEK kimliksiz; ust serit, tema ve duzen
 * yalniz ADMIN oturumunda. Kapaliyken (KAMERA_RTC_API bos) her sey 404.
 * Harici bir izleme panosu iframe ile gomebilir: bu yanitlarda gomme serbest (KAMERA_LIVE_CERCEVE, varsayilan "*"); panelin geri kalani 'self'.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { govdeOku, hamGovdeOku, json } from '../core/http.mjs';

const DOSYALAR = { 'live.js': 'text/javascript; charset=utf-8', 'live.css': 'text/css; charset=utf-8', 'tema.mjs': 'text/javascript; charset=utf-8' };

export function liveDenetleyici({ live, yapilandirma }) {
  const kok = join(yapilandirma.gorunumler, '..', 'live');
  const cerceve = String(yapilandirma.live.cerceve ?? '').split(/\s+/).filter((x) => x === '*' || /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x));
  /** Gomme izni: yalniz /live yanitlarinda (guvenlik.basliklar'in frame-ancestors 'self' ve X-Frame-Options'i burada degisir). */
  const gomme = (res) => {
    res.removeHeader('X-Frame-Options');
    const csp = String(res.getHeader('Content-Security-Policy') ?? '');
    res.setHeader('Content-Security-Policy', csp.replace(/frame-ancestors [^;]*/, `frame-ancestors ${cerceve.length ? cerceve.join(' ') : "'self'"}`));
  };
  const kapali = (ctx) => (live.acik ? false : (json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' }), true));
  const admin = (asal) => asal?.tur === 'uye' && asal.rol === 'admin';
  return {
    async sayfa(ctx) {
      if (kapali(ctx)) return;
      // Sayfa goreli adres kullaniyor: /live -> /live/
      if (!ctx.yol.endsWith('/')) { ctx.res.writeHead(301, { Location: '/live/', 'Cache-Control': 'no-store' }); return ctx.res.end(); }
      gomme(ctx.res);
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      ctx.res.end(readFileSync(join(kok, 'index.html')));
    },
    async statik(ctx) {
      if (kapali(ctx)) return;
      const tur = DOSYALAR[ctx.param.dosya];
      if (!tur) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      gomme(ctx.res);
      ctx.res.writeHead(200, { 'Content-Type': tur, 'Cache-Control': 'no-cache' });
      ctx.res.end(readFileSync(join(kok, ctx.param.dosya)));
    },
    /** Kamera listesi: yalniz yol, ad, cihaz adi (adres/parola YOK). */
    async kameralar(ctx) {
      if (kapali(ctx)) return;
      gomme(ctx.res);
      return json(ctx.res, 200, { kameralar: live.kameralar, varsayilan: live.duzen().varsayilan ? live.duzen().yollar : [] });
    },
    /** Izleme baglantisi (WHEP): SDP teklifi mediamtx'e gider, cevap tarayiciya doner. Kimliksiz: izlemek herkese acik. */
    async whep(ctx) {
      if (kapali(ctx)) return;
      if (!/^application\/sdp\b/i.test(ctx.istek.headers['content-type'] ?? '')) return json(ctx.res, 415, { hata: 'Gövde application/sdp olmalı', kod: 'GECERSIZ_ISTEK' });
      const teklif = await hamGovdeOku(ctx.istek, 64_000);
      let c;
      try { c = await live.whep(ctx.param.yol, teklif); }
      catch (e) { console.error('live whep:', e.message); return json(ctx.res, 502, { hata: 'Görüntü sunucusuna ulaşılamadı', kod: 'RTC' }); }
      if (c.durum === 404 && !c.sdp) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      ctx.res.writeHead(c.durum, { 'Content-Type': c.durum < 300 ? 'application/sdp' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return ctx.res.end(c.sdp);
    },
    async duzen(ctx) { if (kapali(ctx)) return; gomme(ctx.res); return json(ctx.res, 200, live.duzen()); },
    /** Ust serit/tema/duzenleme yalniz admin: oturumu panel kendisi cozer (kimlikIstege; merkez erisimi, ortak cikis, IP dahil). */
    async yetki(ctx) { if (kapali(ctx)) return; gomme(ctx.res); return json(ctx.res, 200, { duzenleyebilir: admin(ctx.asal), ad: admin(ctx.asal) ? ctx.asal.ad : null }); },
    async duzenYaz(ctx) {
      if (kapali(ctx)) return;
      if (!admin(ctx.asal)) return json(ctx.res, 403, { hata: 'Düzeni yalnız admin kaydeder', kod: 'YASAK' });
      const g = await govdeOku(ctx.istek, 20_000);
      try { const d = live.duzenYaz(g, ctx.asal.ad); console.log(`live duzen: ${ctx.asal.ad}, ${d.yollar.length} kamera`); return json(ctx.res, 200, d); }
      catch (e) { return json(ctx.res, 400, { hata: e.message, kod: 'GECERSIZ_ISTEK' }); }
    },
  };
}
