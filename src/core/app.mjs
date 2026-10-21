/**
 * Uygulama cekirdegi: HTTP sunucusu + istek dongusu (rota bulma, ara katman zinciri, hata yaniti).
 * Rota tanimlari routes/ altinda; is mantigi denetleyicilerde (src/controllers) ve hizmetlerde (src/services). Burada mantik YOK.
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { Yonlendirici, zincir } from './router.mjs';
import { hataYaniti, json } from './http.mjs';

export class Uygulama {
  constructor({ yapilandirma, hizmetler }) {
    this.yapilandirma = yapilandirma; this.hizmetler = hizmetler;
    this.yonlendirici = new Yonlendirici();
    this.genelAralar = [];                     // her istekte calisan ara katmanlar (guvenlik basliklari gibi)
  }
  kullan(ara) { this.genelAralar.push(ara); return this; }

  istek = async (istek, res) => {
    // Bozuk istek hedefi ('//' gibi) yonlendirmeden ONCE de yanitlanir: ayiklama try icinde, istek yanitsiz kalip baglanti asili kalmaz.
    let url;
    try { url = new URL(istek.url, 'http://x'); } catch { return json(res, 400, { hata: 'Geçersiz istek', kod: 'GECERSIZ_ISTEK' }); }
    const ctx = { istek, res, yol: url.pathname, q: url.searchParams, param: {}, uygulama: this, hizmetler: this.hizmetler, yapilandirma: this.yapilandirma };
    try {
      const sonuc = this.yonlendirici.bul(istek.method, ctx.yol);
      if (!sonuc) return await zincir(this.genelAralar, ctx, () => json(res, 404, { hata: 'Yok', kod: 'BULUNAMADI' }));
      if (sonuc.yontemYok) return await zincir(this.genelAralar, ctx, () => json(res, 405, { hata: 'Yöntem desteklenmiyor', kod: 'YONTEM' }));
      ctx.param = sonuc.param; ctx.rota = sonuc.rota;
      await zincir([...this.genelAralar, ...sonuc.rota.aralar], ctx, sonuc.rota.denetleyici);
    } catch (e) { hataYaniti(res, e); }
  };

  dinle() {
    const { sunucu } = this.yapilandirma;
    const s = createServer(this.istek);
    s.listen(sunucu.port, sunucu.adres, () => console.log(`Kamera paneli: http://${sunucu.adres}:${sunucu.port}/`));
    if (sunucu.tls && existsSync(sunucu.tls.cert) && existsSync(sunucu.tls.key)) {
      createHttpsServer({ cert: readFileSync(sunucu.tls.cert), key: readFileSync(sunucu.tls.key) }, this.istek).listen(sunucu.tls.port, sunucu.adres, () => console.log(`Kamera paneli (HTTPS): :${sunucu.tls.port}`));
    }
    return s;
  }
}
