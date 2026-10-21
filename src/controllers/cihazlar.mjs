/** Cihaz yonetimi (cihaz.oku / cihaz.yonet / cihaz.saat / kanal.yonet). Parolalar yanitlarda ve gunlukte YOK. */
import { govdeOku, json } from '../core/http.mjs';
import { VeritabaniHatasi } from '../core/errors.mjs';
import { YetkiHatasi } from '../models/yetki.mjs';

export function cihazlarDenetleyici({ cihazlar, gunluk }) {
  const hataIle = async (res, fn) => { try { return await fn(); } catch (e) { if (e instanceof YetkiHatasi || e instanceof VeritabaniHatasi || e instanceof SyntaxError) throw e; return json(res, 400, { hata: e.message, kod: 'GECERSIZ_ISTEK' }); } };
  const KAPSAM_DISI = (ek) => new YetkiHatasi('KAPSAM_DISI', 'Bu cihaz/kamera erişim kapsamınızın dışında', 403, ek);
  const blok = (c) => Array.from({ length: c.kanalSayisi ?? c.kanal }, (_, i) => c.baslangic + i);
  /** Cihaz kimligiyle yazma (duzenle, sil, kamera ekle, saat): kapsamli asal icin cihazin TUM kanal blogu kapsamda olmali. */
  const cihazGerek = (asal, id) => {
    if (asal.kapsamsiz()) return;
    const c = cihazlar.liste().find((x) => x.id === String(id ?? ''));
    if (!c || !blok(c).every((k) => asal.kanalIzinli(k))) throw KAPSAM_DISI({ cihaz: String(id ?? '') });
  };
  /** Kapsamsiz yonetim isleri (yeni cihaz ekleme, disk silme): kapsamli asale kapali. */
  const kapsamsizGerek = (asal) => { if (!asal.kapsamsiz()) throw KAPSAM_DISI({}); };
  /**
   * Kapsamli asal icin bilgi: kapsam disi kanal/cihaz verisi hic donmez. Kanal dizilerinin UZUNLUGU korunur (arayuz indeksle calisir),
   * kapsam disi hucreler maskelenir; cihaz/disk/toplam alanlari yalniz gorunen cihazlardan yeniden kurulur.
   */
  const kapsamSuz = (b, asal) => {
    if (asal.kapsamsiz()) return b;
    const izinli = (i) => asal.kanalIzinli(i);
    const maske = (d, bos = '') => (Array.isArray(d) ? d.map((x, i) => (izinli(i) ? x : bos)) : d);
    const kanalBos = b.kanalBos.map((x, i) => x || !izinli(i));
    if (!b.cihazlar) return { ...b, kanalBos };
    const gorunen = b.cihazlar.filter((c) => blok(c).some(izinli));
    const idler = new Set(gorunen.map((c) => c.id));
    const diskler = (b.diskler ?? []).filter((d) => idler.has(d.cihaz));
    const ilk = gorunen[0];
    return {
      ...b, kanalBos,
      kanalAdlari: maske(b.kanalAdlari), kanalKodlar: maske(b.kanalKodlar), kanalKamera: maske(b.kanalKamera),
      kanalCihaz: maske(b.kanalCihaz), kanalCihazAdi: maske(b.kanalCihazAdi), kanalOtomatikBos: maske(b.kanalOtomatikBos, true),
      kanalAyar: Object.fromEntries(Object.entries(b.kanalAyar ?? {}).filter(([k]) => izinli(Number(k)))),
      cihazlar: gorunen, diskler,
      ana: gorunen.map((c) => c.ana).join(' + '), model: gorunen.map((c) => c.model).join(' + '),
      surum: gorunen.map((c) => c.surum).join(' / '), seriNo: gorunen.map((c) => c.seriNo).join(' / '), derleme: gorunen.map((c) => c.derleme).join(' / '),
      saat: ilk?.saat ?? null, calismaSn: ilk?.calismaSn ?? 0,
      diskMB: { toplam: diskler.reduce((t, d) => t + (d.toplamMB ?? 0), 0), bos: diskler.reduce((t, d) => t + (d.bosMB ?? 0), 0) },
    };
  };
  return {
    kapsamSuz,
    async bilgi(ctx) { return json(ctx.res, 200, kapsamSuz(await cihazlar.bilgi(), ctx.asal)); },
    async liste(ctx) {
      const l = cihazlar.liste();
      const asal = ctx.asal;
      const g = asal.kapsamsiz() ? l : l.filter((c) => Array.from({ length: c.kanalSayisi }, (_, i) => c.baslangic + i).some((k) => asal.kanalIzinli(k)));
      return json(ctx.res, 200, { cihazlar: g, turler: cihazlar.turler });
    },
    async ekle(ctx) {
      return hataIle(ctx.res, async () => {
        kapsamsizGerek(ctx.asal);
        const k = await cihazlar.ekle(await govdeOku(ctx.istek));
        gunluk.yaz('cihaz-ekle', ctx.asal.gunlukAdi, ctx.istek, { cihaz: k.ana, tur: k.tur, ad: k.ad });
        return json(ctx.res, 200, { tamam: true, id: k.id });
      });
    },
    async guncelle(ctx) {
      return hataIle(ctx.res, async () => {
        cihazGerek(ctx.asal, ctx.param.id);
        const k = await cihazlar.guncelle(ctx.param.id, await govdeOku(ctx.istek));
        gunluk.yaz('cihaz-duzenle', ctx.asal.gunlukAdi, ctx.istek, { cihaz: k.ana, ad: k.ad });
        return json(ctx.res, 200, { tamam: true });
      });
    },
    async sil(ctx) {
      return hataIle(ctx.res, async () => {
        cihazGerek(ctx.asal, ctx.param.id);
        const eski = await cihazlar.sil(ctx.param.id);
        gunluk.yaz('cihaz-sil', ctx.asal.gunlukAdi, ctx.istek, { cihaz: eski?.ana, ad: eski?.ad });
        return json(ctx.res, 200, { tamam: true });
      });
    },
    /** NVR'a kamera kaydet (kayit NVR'da yapilir). */
    async kameraEkle(ctx) {
      return hataIle(ctx.res, async () => {
        cihazGerek(ctx.asal, ctx.param.id);
        const c = cihazlar.bul(ctx.param.id);
        if (!c) return json(ctx.res, 404, { hata: 'Cihaz yok', kod: 'BULUNAMADI' });
        if (typeof c.kameraEkle !== 'function') return json(ctx.res, 400, { hata: 'Bu cihaz türünde panelden kamera eklenemez (cihazın kendi arayüzünden ekleyin)', kod: 'DESTEKLENMIYOR' });
        const g = await govdeOku(ctx.istek);
        const ad = String(g.ad ?? '').trim().slice(0, 40), ip = String(g.ip ?? '').trim(), kullanici = String(g.kullanici ?? '').trim();
        if (!ad) throw new Error('Kamera adı gerekli');
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error('Kamera IP adresi geçersiz (örn. 192.168.2.50)');
        if (!kullanici || typeof g.parola !== 'string' || !g.parola) throw new Error('Kamera kullanıcı adı ve parolası gerekli');
        const port = g.port === undefined || g.port === '' ? undefined : Number(g.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Port geçersiz');
        const r = await c.kameraEkle({ ad, ip, kullanici, parola: g.parola, protokol: g.protokol === 'ONVIF' ? 'ONVIF' : 'HIKVISION', port });
        gunluk.yaz('nvr-kamera-ekle', ctx.asal.gunlukAdi, ctx.istek, { cihaz: c.ayar.ana, kamera: ip, ad, kanal: c.baslangic + r.kanal, cevrimici: r.cevrimici });
        return json(ctx.res, 200, { tamam: true, kanal: c.baslangic + r.kanal, cevrimici: r.cevrimici });
      });
    },
    async saat(ctx) {
      const g = await govdeOku(ctx.istek);
      cihazGerek(ctx.asal, g.cihaz);
      const r = await cihazlar.grup.saatiSenkronla(g.cihaz);
      gunluk.yaz('saat-ayari', ctx.asal.gunlukAdi, ctx.istek, { otomatik: false, cihaz: r.cihaz, once: r.once, sonra: r.sonra, sunucu: r.sunucu });
      return json(ctx.res, 200, r);
    },
    async kanalAyar(ctx) {
      const g = await govdeOku(ctx.istek);
      let aralik = Number.isInteger(g.bas) && Number.isInteger(g.son) ? { bas: g.bas, son: g.son } : null;
      let ayar = g.ayar ?? {};
      if (!ctx.asal.kapsamsiz()) {
        // Kapsamli asal yalniz kendi kanallarinin ayarini degistirir; kapsam disi kanal anahtari reddedilir, kapsam disi MEVCUT ayarlar korunur
        // (kanallar.json tek global dosya: harita kapsamli kullanicinin gonderdigiyle tumden degistirilmez).
        const sayisal = (k) => /^\d{1,4}$/.test(k);
        const icinde = (k) => !aralik || (Number(k) >= aralik.bas && Number(k) < aralik.son);
        const dis = Object.keys(ayar).find((k) => sayisal(k) && icinde(k) && !ctx.asal.kanalIzinli(Number(k)));
        if (dis !== undefined) throw KAPSAM_DISI({ kanal: Number(dis) });
        const korunan = Object.entries(cihazlar.kanalAyar).filter(([k]) => !ctx.asal.kanalIzinli(Number(k)) || !icinde(k));
        ayar = { ...Object.fromEntries(korunan), ...Object.fromEntries(Object.entries(ayar).filter(([k]) => sayisal(k) && icinde(k))) };
        aralik = null;
      }
      const n = await cihazlar.kanalAyarKaydet(ayar, aralik);
      gunluk.yaz('kanal-ayari', ctx.asal.gunlukAdi, ctx.istek, { kanalSayisi: n });
      return json(ctx.res, 200, { tamam: true });
    },
    async temizle(ctx) {
      kapsamsizGerek(ctx.asal);
      const g = await govdeOku(ctx.istek);
      if (g.onay !== 'TÜM KAYITLARI SİL') return json(ctx.res, 400, { hata: 'Onay metni yanlış', kod: 'GECERSIZ_ISTEK' });
      return json(ctx.res, 200, await cihazlar.grup.diskiTemizle());
    },
  };
}
