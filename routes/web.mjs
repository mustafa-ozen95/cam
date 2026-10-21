/**
 * Web rotalari. Kimliksiz yalniz giris sayfasinin ihtiyaci: giris/ana sayfa (oturum yoksa giris formu), css/js/font/simge ve merkez ile giris akisi.
 * API dokumani (/dokuman) oturum ister.
 */
export function webRotalari(r, d, ara) {
  // Ana sayfa API ile AYNI denetimden gecer (kimlikIstege): cerez imzasi tutsa da merkezde erisimi kalkan ya da
  // ortak cikistan once acilmis oturuma panel verilirse API 401 doner, sayfa kendini yeniler, sonsuz dongu olur.
  r.get('/', d.gorunum.anaSayfa, [ara.kimlikIstege]);
  r.get('/index.html', d.gorunum.anaSayfa, [ara.kimlikIstege]);
  r.get('/simge.svg', d.gorunum.statik);
  r.get('/css/:a', d.gorunum.statik); r.get('/css/:a/:b', d.gorunum.statik); r.get('/css/:a/:b/:c', d.gorunum.statik);
  r.get('/fonts/:a', d.gorunum.statik); r.get('/js/:a', d.gorunum.statik); r.get('/js/:a/:b', d.gorunum.statik); r.get('/js/:a/:b/:c', d.gorunum.statik);   // js/eys/lib, js/eys/components
  // Kimlik Yonetim Merkezi ile giris (yapilandirilmamissa 404). Donus adresi merkezde kayitli olanla birebir ayni olmali.
  r.get('/giris/merkez', d.merkez.baslat);
  r.get('/giris/merkez/geri', d.merkez.geri);
  // Canli izleme (/live): IZLEMEK kimliksiz; ust serit ve duzen yalniz admin. Kapaliyken 404.
  // Ozel yollar genel /live/:dosya'dan ONCE.
  r.get('/live', d.live.sayfa);
  r.get('/live/kameralar.json', d.live.kameralar);
  r.get('/live/duzen.json', d.live.duzen);
  r.get('/live/yetki', d.live.yetki, [ara.kimlikIstege]);
  r.put('/live/duzen', d.live.duzenYaz, [ara.kimlik]);
  r.post('/live/rtc/:yol/whep', d.live.whep);   // izleme baglantisi: panel mediamtx'e gecirir (vekilde kural gerekmez)
  r.get('/live/:dosya', d.live.statik);
  r.grup([ara.kimlik], () => {
    r.get('/dokuman', d.gorunum.dokuman);
    r.get('/dokuman/:dosya', d.gorunum.dokuman);
  });
}
