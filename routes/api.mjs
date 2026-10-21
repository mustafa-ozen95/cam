/**
 * Panel API'si (/api/...): arayuzun kullandigi uc noktalar. Cerezle (CSRF basligi zorunlu) ya da Bearer anahtarla calisir.
 * Her rota gerekli izni ara katmanla bildirir; izin listesi dokumana buradan uretilir.
 */
import { izin, herhangi } from '../src/middleware/permissions.mjs';

export function apiRotalari(r, d, ara) {
  r.post('/api/giris', d.giris.giris, [ara.kimlikIstege]);
  r.post('/api/cikis', d.giris.cikis);
  // Merkezden "bu kimlik degisti" bildirimi: jeton yok, HMAC imza (bkz. src/controllers/hub.mjs · tazele).
  r.post('/api/kimlik/tazele', d.merkez.tazele);
  // Merkezden ortak cikis bildirimi: HMAC imza ani da kapsar (bkz. src/controllers/hub.mjs · cikis).
  r.post('/api/kimlik/cikis', d.merkez.cikis);

  r.grup([ara.kimlik], () => {
    r.get('/api/ben', d.giris.ben);
    // Kendi gorunum tercihleri (Hepsi sirasi/sayisi, arka planda durdurma); yalniz canli izleyebilen uye.
    r.get('/api/ben/tercih', d.giris.tercih, [izin('canli.izle')]);
    r.put('/api/ben/tercih', d.giris.tercihYaz, [izin('canli.izle')]);
    // bilgi: izleme ya da cihaz okuma izni olan herkes (kapsam disi kanallar gizlenir)
    r.get('/api/bilgi', d.cihazlar.bilgi, [herhangi('canli.izle', 'kayit.listele', 'kayit.izle', 'cihaz.oku')]);
    // izleme
    // Canli goruntu MP4 (MJPEG web rotasi yok; API v1 canli MJPEG dis sozlesme olarak duruyor)
    r.get('/akis/canli-mp4', d.akis.canliMp4, [izin('canli.izle')]);
    r.get('/api/goruntu', d.akis.goruntu, [izin('canli.izle')]);
    r.get('/api/kayitlar', d.akis.kayitlar, [izin('kayit.listele')]);
    r.get('/api/hareketler', d.akis.hareketler, [izin('kayit.listele')]);
    r.get('/akis/oynat', d.akis.oynat, [izin('kayit.izle')]);
    r.get('/api/indir-akis', d.akis.indir, [izin('kayit.indir')]);
    r.get('/api/isler', async (ctx) => { ctx.res.writeHead(200, { 'Content-Type': 'application/json' }); ctx.res.end('[]'); }, [herhangi('canli.izle', 'kayit.izle')]);   // eski istemciler
    // uyeler
    r.get('/api/uyeler', d.uyeler.liste, [izin('uye.yonet')]);
    r.post('/api/uyeler', d.uyeler.ekle, [izin('uye.yonet')]);
    r.patch('/api/uyeler/:ad', d.uyeler.guncelle, [izin('uye.yonet')]);
    r.delete('/api/uyeler/:ad', d.uyeler.sil, [izin('uye.yonet')]);
    // gunluk
    r.get('/api/gunluk', d.gunluk.liste, [izin('gunluk.oku')]);
    r.get('/api/gunluk/dogrula', d.gunluk.dogrula, [izin('gunluk.oku')]);
    // Guncelleme kontrolu: yalnizca bakar (GitHub'daki son basarili derleme); guncelleme sunucudan yapilir.
    r.get('/api/guncelleme', d.guncelleme.durum, [izin('guncelleme.denetle')]);
    r.post('/api/guncelleme/denetle', d.guncelleme.denetle, [izin('guncelleme.denetle')]);
    // cihazlar
    r.get('/api/cihazlar', d.cihazlar.liste, [izin('cihaz.oku')]);
    r.post('/api/cihazlar', d.cihazlar.ekle, [izin('cihaz.yonet')]);
    r.patch('/api/cihazlar/:id', d.cihazlar.guncelle, [izin('cihaz.yonet')]);
    r.delete('/api/cihazlar/:id', d.cihazlar.sil, [izin('cihaz.yonet')]);
    r.post('/api/cihazlar/:id/kamera', d.cihazlar.kameraEkle, [izin('cihaz.yonet')]);
    r.put('/api/kanallar', d.cihazlar.kanalAyar, [izin('kanal.yonet')]);
    r.post('/api/dvr/saat', d.cihazlar.saat, [izin('cihaz.saat')]);
    r.post('/api/dvr/temizle', d.cihazlar.temizle, [izin('cihaz.yonet')]);
    // yetki: izin katalogu ve roller (okuma: anahtar yonetebilen herkes), yazma: yetki.yonet
    r.get('/api/yetki/izinler', d.yetki.izinler, [herhangi('yetki.yonet', 'api.anahtar', 'uye.yonet')]);
    r.get('/api/yetki/roller', d.yetki.roller, [herhangi('yetki.yonet', 'api.anahtar', 'uye.yonet')]);
    r.post('/api/yetki/roller', d.yetki.rolEkle, [izin('yetki.yonet')]);
    r.patch('/api/yetki/roller/:id', d.yetki.rolGuncelle, [izin('yetki.yonet')]);
    r.delete('/api/yetki/roller/:id', d.yetki.rolSil, [izin('yetki.yonet')]);
    // API anahtarlari (yetki.yonet: hepsi; api.anahtar: kendininkiler)
    r.get('/api/yetki/anahtarlar', d.yetki.anahtarlar, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/yetki/anahtarlar', d.yetki.anahtarEkle, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.get('/api/yetki/anahtarlar/:id', d.yetki.anahtar, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.patch('/api/yetki/anahtarlar/:id', d.yetki.anahtarGuncelle, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/yetki/anahtarlar/:id/yenile', d.yetki.anahtarYenile, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/yetki/anahtarlar/:id/iptal', d.yetki.anahtarIptal, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.delete('/api/yetki/anahtarlar/:id', d.yetki.anahtarSil, [herhangi('yetki.yonet', 'api.anahtar')]);
  });
}
