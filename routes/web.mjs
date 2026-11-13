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
  r.get('/css/:a', d.view.serveStatic); r.get('/css/:a/:b', d.view.serveStatic); r.get('/css/:a/:b/:c', d.view.serveStatic);
  r.get('/fonts/:a', d.view.serveStatic); r.get('/js/:a', d.view.serveStatic); r.get('/js/:a/:b', d.view.serveStatic); r.get('/js/:a/:b/:c', d.view.serveStatic);   // js/eys/lib, js/eys/components
  // Kimlik Yonetim Merkezi ile giris (yapilandirilmamissa 404). Donus adresi merkezde kayitli olanla birebir ayni olmali.
  r.get('/login/hub', d.hub.start);
  r.get('/login/hub/callback', d.hub.back);
  // Canli izleme (/live): IZLEMEK kimliksiz; ust serit ve duzen yalniz admin. Kapaliyken 404.
  // Ozel yollar genel /live/:dosya'dan ONCE.
  r.get('/live', d.live.page);
  r.get('/live/cameras.json', d.live.cameras);
  r.get('/live/layout.json', d.live.layout);
  r.get('/live/access', d.live.permissions, [middleware.identityOptional]);
  r.put('/live/layout', d.live.writeLayout, [middleware.identity]);
  r.post('/live/rtc/:path/whep', d.live.whep);   // izleme baglantisi: panel mediamtx'e gecirir (vekilde kural gerekmez)
  r.get('/live/:file', d.live.serveStatic);
  r.group([middleware.identity], () => {
    r.get('/docs', d.view.docs);
    r.get('/docs/:file', d.view.docs);
  });
}
