/** Canli akis, anlik goruntu, kayit listesi, kayittan oynatma, indirme (izin + kapsam + eszamanli akis siniri). */
import { GUN, HttpHatasi, ZAMAN, json } from '../core/http.mjs';

export function akisDenetleyici({ cihazlar, yetki, gunluk }) {
  const grup = () => cihazlar.grup;
  /**
   * AYNI KISI + AYNI KANAL = TEK OYNATMA. Zaman cizelgesinde ileri atlayan oynatici ayni kanal icin yeni istek
   * acar; eskisinin baglantisi sunucuya kapandigi haber gelene kadar cihazdaki yuvayi tutuyordu ve 4 kamerada hizli
   * atlamada yeni istekler 503 aliyordu. Yeni istek gelince eskisi once kapatilir ve yuvasi bosalinca devam edilir.
   */
  const oynatmalar = new Map();   // `${asal.kimlik}|${kanal}` -> res
  const oncekiniKapat = async (anahtar) => {
    const eski = oynatmalar.get(anahtar);
    if (!eski || eski.destroyed || eski.writableEnded) return;
    await new Promise((coz) => { const z = setTimeout(coz, 1000); eski.once('close', () => { clearTimeout(z); setImmediate(coz); }); eski.destroy(); });
  };
  const kanalAl = (ctx) => {
    const k = Number(ctx.q.get('kanal') ?? ctx.param.kanal ?? 0);
    if (!Number.isInteger(k) || k < 0 || k >= (grup().kanalToplam ?? 0)) throw new HttpHatasi(400, 'kanal geçersiz', 'GECERSIZ_ISTEK');
    return ctx.kanalGerek(k);
  };
  const mjpegBaslik = (ctx) => { ctx.res.ham = ctx.q.has('ham'); ctx.res.writeHead(200, { 'Content-Type': ctx.res.ham ? 'application/octet-stream' : 'multipart/x-mixed-replace; boundary=kare', 'Cache-Control': 'no-store', Connection: 'close' }); };
  return {
    async canli(ctx) {
      const kanal = kanalAl(ctx);
      const tur = ['Extra1', 'Mini', 'Main'].includes(ctx.q.get('tur')) ? ctx.q.get('tur') : 'Main';
      // g=tam: olceksiz ana akis (tam ekran); fps: izgara kare hizi (surucu izinli degerlerle sinirlar).
      const g = ctx.q.get('g') === 'tam' && tur === 'Main' ? 0 : Number(ctx.q.get('g')) || 640;
      // Ayni akisi izleyen ikinci sekme hak harcamaz: sunucudaki tek baglantiyi paylasir.
      const birak = yetki.akisAc(ctx.asal, `canli:${kanal}/${tur}/${g}/${Number(ctx.q.get('fps')) || ''}`); ctx.res.on('close', birak);
      const y = grup().yayin(kanal, tur, g, Number(ctx.q.get('fps')) || undefined);
      mjpegBaslik(ctx); y.abone(ctx.res);
      y.hazir.then(() => { if (y.hata) ctx.res.end(); });
    },
    /**
     * Canli MP4. Baslik, baslangic gelince yazilir: X-Kodek tarayicinin oynatip oynatamayacagini sorar; oynatamazsa
     * (Chrome'da H.265) arayuz h264=1 ile yeniden ister ve sunucu kaynak kalitede H.264'e cevirir. Alt akis tek (Extra1).
     * 501: surucu MP4 vermiyor (Xiongmai DVR).
     */
    async canliMp4(ctx) {
      const kanal = kanalAl(ctx);
      const tur = ctx.q.get('tur') === 'Main' ? 'Main' : 'Extra1';
      const cevir = ctx.q.get('h264') === '1';
      const birak = yetki.akisAc(ctx.asal, `mp4:${kanal}/${tur}${cevir ? '/h264' : ''}`); ctx.res.on('close', birak);
      const y = grup().yayinMp4(kanal, tur, cevir);
      if (!y) { birak(); return json(ctx.res, 501, { hata: 'Bu cihaz MP4 akışı vermiyor', kod: 'MP4_YOK' }); }
      await y.hazir;
      if (ctx.res.destroyed) return;
      if (!y.init || y.durduruldu) return json(ctx.res, 502, { hata: y.hata ?? 'Kameradan görüntü gelmedi', kod: 'AKIS_YOK' });
      ctx.res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Kodek': y.kodek, 'Cache-Control': 'no-store', Connection: 'close' });
      y.abone(ctx.res);
    },
    async goruntu(ctx) {
      const y = grup().yayin(kanalAl(ctx), 'Main', 0);   // goruntu al: kameranin tam cozunurlugu (olceksiz)
      await y.ilkKare();
      for (let t = 0; (y.kareSayac ?? 0) < 6 && t < 50 && !y.durduruldu; t++) await new Promise((r) => setTimeout(r, 100));   // ilk kareler bozuk olabilir
      const kare = y.son;
      if (!kare) throw new Error(y.hata ?? 'Kameradan görüntü alınamadı (akış başlamadı)');
      ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); ctx.res.end(kare);
      if (!y.aboneler.size) y.bosZaman = setTimeout(() => y.durdur(), 4000);
    },
    async kayitlar(ctx) {
      const gun = ctx.q.get('gun');
      if (!GUN.test(gun ?? '')) return json(ctx.res, 400, { hata: 'gun geçersiz', kod: 'GECERSIZ_ISTEK' });
      const gun2 = ctx.q.get('gun2') || gun;
      if (!GUN.test(gun2) || gun2 < gun || (Date.parse(gun2) - Date.parse(gun)) / 864e5 > 30) return json(ctx.res, 400, { hata: 'gün aralığı geçersiz (en çok 31 gün)', kod: 'GECERSIZ_ISTEK' });
      return json(ctx.res, 200, await grup().kayitlar(kanalAl(ctx), `${gun} 00:00:00`, `${gun2} 23:59:59`));
    },
    /** Bir gunun hareketli araliklari (oynatma cizelgesinde isaret): [{bas, bit}]. */
    async hareketler(ctx) {
      const gun = ctx.q.get('gun');
      if (!GUN.test(gun ?? '')) return json(ctx.res, 400, { hata: 'gun geçersiz', kod: 'GECERSIZ_ISTEK' });
      return json(ctx.res, 200, await grup().hareketler(kanalAl(ctx), `${gun} 00:00:00`, `${gun} 23:59:59`));
    },
    async oynat(ctx) {
      const bas = ctx.q.get('bas'), bit = ctx.q.get('bit');
      if (!ZAMAN.test(bas ?? '') || !ZAMAN.test(bit ?? '')) return json(ctx.res, 400, { hata: 'zaman geçersiz', kod: 'GECERSIZ_ISTEK' });
      const kanal = kanalAl(ctx);
      const anahtar = `${ctx.asal.kimlik}|${kanal}`;
      await oncekiniKapat(anahtar);
      if (!grup().oynatabilir(kanal)) { ctx.res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' }); return ctx.res.end(JSON.stringify({ hata: 'Cihaz meşgul, birazdan tekrar deneyin', kod: 'MESGUL' })); }
      const birak = yetki.akisAc(ctx.asal); ctx.res.on('close', birak);
      oynatmalar.set(anahtar, ctx.res); ctx.res.on('close', () => { if (oynatmalar.get(anahtar) === ctx.res) oynatmalar.delete(anahtar); });
      gunluk.yaz('oynatma', ctx.asal.gunlukAdi, ctx.istek, { kanal, bas, bit });
      mjpegBaslik(ctx);
      grup().oynatMjpeg(ctx.res, kanal, bas, bit, Number(ctx.q.get('g')) || 960);
    },
    async indir(ctx) {
      const kanal = kanalAl(ctx), dosya = ctx.q.get('dosya') ?? '', bas = ctx.q.get('bas'), bit = ctx.q.get('bit');
      if (!/^\/[\w\/.\-\[\]@]+\.h264$/.test(dosya) || dosya.includes('..') || !ZAMAN.test(bas ?? '') || !ZAMAN.test(bit ?? '')) return json(ctx.res, 400, { hata: 'kayıt geçersiz', kod: 'GECERSIZ_ISTEK' });
      const ad = grup().indirAdi(kanal, { ad: dosya, bas, bit });
      const birak = yetki.akisAc(ctx.asal); ctx.res.on('close', birak);       // indirme de eszamanli akis hakkindan sayilir (canli/oynat gibi)
      gunluk.yaz('indirme-istek', ctx.asal.gunlukAdi, ctx.istek, { kanal, bas, bit, dosya: ad });
      await grup().indirAkit(ctx.res, kanal, { ad: dosya, bas, bit }, ad, (r) => gunluk.yaz(r.tamam ? 'indirme-teslim' : 'indirme-yarim', ctx.asal.gunlukAdi, ctx.istek, { dosya: ad, bayt: r.bayt }));
    },
  };
}
