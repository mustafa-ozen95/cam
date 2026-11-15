/**
 * Web rotalari. Kimliksiz yalniz giris sayfasinin ihtiyaci: giris/ana sayfa (oturum yoksa giris formu), css/js/font/simge ve merkez ile giris akisi.
 * API dokumani (/docs) oturum ister.
 */
export function webRoutes(r, d, middleware) {
  // Ana sayfa API ile AYNI denetimden gecer (identityOptional): cerez imzasi tutsa da merkezde erisimi kalkan ya da
  // ortak cikistan once acilmis oturuma panel verilirse API 401 doner, sayfa kendini yeniler, sonsuz dongu olur.
  r.get('/', d.view.mainPage, [middleware.identityOptional]);
  r.get('/index.html', d.view.mainPage, [middleware.identityOptional]);
  r.get('/icon.svg', d.view.serveStatic);
  // ana ekran (telefon): PNG simgeler + uygulama bildirimi (tam ekran acilis)
  for (const f of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest']) r.get(f, d.view.serveStatic);
  r.get('/css/:a', d.view.serveStatic); r.get('/css/:a/:b', d.view.serveStatic); r.get('/css/:a/:b/:c', d.view.serveStatic);
  r.get('/fonts/:a', d.view.serveStatic); r.get('/js/:a', d.view.serveStatic); r.get('/js/:a/:b', d.view.serveStatic); r.get('/js/:a/:b/:c', d.view.serveStatic);   // js/eys/lib, js/eys/components
  // Kimlik Yonetim Merkezi ile giris (yapilandirilmamissa 404). Donus adresi merkezde kayitli olanla birebir ayni olmali.
  r.get('/login/hub', d.hub.start);
  r.get('/login/hub/callback', d.hub.back);
  r.group([middleware.identity], () => {
    r.get('/docs', d.view.docs);
    r.get('/docs/:file', d.view.docs);
  });
}

/**
 * Canli izleme sayfalari (/<yol>/, kayitlar: live_pages). EN SON kaydedilir ve yalniz KAYITLI yol icin eslesir (when):
 * genel /:live kaliplari /api, /docs, /css gibi yollari golgelemez. Hepsi identityOptional: ayni rota hem public hem private
 * sayfaya hizmet eder; erisim karari denetleyicide sayfa kaydina gore verilir (bkz. src/controllers/live.mjs). Kapaliyken 404.
 * Ozel yollar genel /:live/:file'dan ONCE.
 */
export function liveRoutes(r, d, middleware, { livePages }) {
  const w = (p) => !!livePages.bySlug(p.live);
  r.get('/:live', d.live.page, [middleware.identityOptional], w);
  r.get('/:live/cameras.json', d.live.cameras, [middleware.identityOptional], w);
  r.get('/:live/layout.json', d.live.layout, [middleware.identityOptional], w);
  r.get('/:live/access', d.live.permissions, [middleware.identityOptional], w);
  r.put('/:live/layout', d.live.writeLayout, [middleware.identity], w);
  r.post('/:live/rtc/:path/whep', d.live.whep, [middleware.identityOptional], w);   // izleme baglantisi: panel mediamtx'e gecirir (vekilde kural gerekmez)
  r.get('/:live/:file', d.live.serveStatic, [middleware.identityOptional], w);
}
