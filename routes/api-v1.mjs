/**
 * Dis API v1 (/api/v1/...): kararli, dokumante, surumlu. Kimlik: Bearer API anahtari (cerez de calisir).
 * Kaynak odakli adlandirma; kanal yollari /api/v1/kameralar/:kanal/... Ayni denetleyiciler kullanilir (tek is mantigi).
 */
import { izin, herhangi } from '../src/middleware/permissions.mjs';
import { json, temizIp } from '../src/core/http.mjs';

export function apiV1Rotalari(r, d, ara, { cihazlar, yapilandirma, vt }) {
  /**
   * Saglik yoklamasi (Dockerfile HEALTHCHECK, 127.0.0.1): yalniz konteynerin kendi dongu adresinden ve vekilsiz gelen istege yanit verir;
   * baska herkese 404 (panelin varligini/surumunu/cihaz sayisini kimliksiz kimse ogrenmesin). Yanit hicbir dagitim ayrintisi tasimaz.
   */
  r.get('/api/v1/saglik', async (ctx) => {
    const vekilBasligi = yapilandirma.sunucu.guvenilenIpBasligi;
    const yerel = ['127.0.0.1', '::1'].includes(temizIp(ctx.istek.socket.remoteAddress)) && !(vekilBasligi && ctx.istek.headers[vekilBasligi.toLowerCase()]);
    if (!yerel) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
    if (!(await vt.saglikli())) return json(ctx.res, 503, { tamam: false });   // veritabanina ulasilamiyorsa saglikli degil
    return json(ctx.res, 200, { tamam: true });
  });

  r.grup([ara.kimlik], () => {
    r.get('/api/v1', async (ctx) => json(ctx.res, 200, { ad: 'cam', surum: 'v1', dokuman: '/dokuman/api-v1.tr.md', openapi: '/dokuman/openapi.json' }));
    r.get('/api/v1/ben', d.giris.ben);
    r.get('/api/v1/izinler', d.yetki.izinler, [herhangi('yetki.yonet', 'api.anahtar', 'uye.yonet')]);

    // kameralar (kanallar): kapsam uygulanir
    r.get('/api/v1/kameralar', async (ctx) => {
      const b = d.cihazlar.kapsamSuz(await cihazlar.bilgi(), ctx.asal);
      const liste = b.kanalAdlari.map((ad, k) => ({ kanal: k, kod: b.kanalKodlar?.[k] ?? null, ad, cihazAdi: b.kanalCihazAdi?.[k] ?? null, cihaz: cihazlar.grup.cihazIdOf(k), bos: !!b.kanalBos[k], kamera: b.kanalKamera?.[k] || null })).filter((x) => ctx.asal.kanalIzinli(x.kanal));
      return json(ctx.res, 200, { kameralar: liste });
    }, [herhangi('canli.izle', 'kayit.listele', 'kayit.izle', 'cihaz.oku')]);
    r.get('/api/v1/kameralar/:kanal/goruntu', d.akis.goruntu, [izin('canli.izle')]);
    r.get('/api/v1/kameralar/:kanal/canli', d.akis.canli, [izin('canli.izle')]);
    r.get('/api/v1/kameralar/:kanal/kayitlar', d.akis.kayitlar, [izin('kayit.listele')]);
    r.get('/api/v1/kameralar/:kanal/oynat', d.akis.oynat, [izin('kayit.izle')]);
    r.get('/api/v1/kameralar/:kanal/indir', d.akis.indir, [izin('kayit.indir')]);

    // cihazlar
    r.get('/api/v1/cihazlar', d.cihazlar.liste, [izin('cihaz.oku')]);
    r.get('/api/v1/cihazlar/bilgi', d.cihazlar.bilgi, [izin('cihaz.oku')]);
    r.post('/api/v1/cihazlar', d.cihazlar.ekle, [izin('cihaz.yonet')]);
    r.patch('/api/v1/cihazlar/:id', d.cihazlar.guncelle, [izin('cihaz.yonet')]);
    r.delete('/api/v1/cihazlar/:id', d.cihazlar.sil, [izin('cihaz.yonet')]);
    r.post('/api/v1/cihazlar/:id/kameralar', d.cihazlar.kameraEkle, [izin('cihaz.yonet')]);
    r.post('/api/v1/cihazlar/saat', d.cihazlar.saat, [izin('cihaz.saat')]);
    r.put('/api/v1/kanallar', d.cihazlar.kanalAyar, [izin('kanal.yonet')]);

    // uyeler, gunluk, yetki
    r.get('/api/v1/uyeler', d.uyeler.liste, [izin('uye.yonet')]);
    r.post('/api/v1/uyeler', d.uyeler.ekle, [izin('uye.yonet')]);
    r.patch('/api/v1/uyeler/:ad', d.uyeler.guncelle, [izin('uye.yonet')]);
    r.delete('/api/v1/uyeler/:ad', d.uyeler.sil, [izin('uye.yonet')]);
    r.get('/api/v1/gunluk', d.gunluk.liste, [izin('gunluk.oku')]);
    r.get('/api/v1/gunluk/dogrula', d.gunluk.dogrula, [izin('gunluk.oku')]);
    r.get('/api/v1/roller', d.yetki.roller, [herhangi('yetki.yonet', 'api.anahtar', 'uye.yonet')]);
    r.post('/api/v1/roller', d.yetki.rolEkle, [izin('yetki.yonet')]);
    r.patch('/api/v1/roller/:id', d.yetki.rolGuncelle, [izin('yetki.yonet')]);
    r.delete('/api/v1/roller/:id', d.yetki.rolSil, [izin('yetki.yonet')]);
    r.get('/api/v1/anahtarlar', d.yetki.anahtarlar, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/v1/anahtarlar', d.yetki.anahtarEkle, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.get('/api/v1/anahtarlar/:id', d.yetki.anahtar, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.patch('/api/v1/anahtarlar/:id', d.yetki.anahtarGuncelle, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/v1/anahtarlar/:id/yenile', d.yetki.anahtarYenile, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.post('/api/v1/anahtarlar/:id/iptal', d.yetki.anahtarIptal, [herhangi('yetki.yonet', 'api.anahtar')]);
    r.delete('/api/v1/anahtarlar/:id', d.yetki.anahtarSil, [herhangi('yetki.yonet', 'api.anahtar')]);
  });
}
