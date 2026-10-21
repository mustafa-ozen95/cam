/**
 * Merkez ile giris: baslat (merkeze gonder), geri (kodu jetona cevir, uyeyi bagla, oturum ac), tazele (merkezden bildirim).
 * Akis durumu (PKCE dogrulayicisi + state) kisa omurlu, imzali bir cerezde tasinir: sunucuda oturum tablosu yok.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { VeritabaniHatasi } from '../core/errors.mjs';
import { cerezOku, cerezYaz, govdeOku, json } from '../core/http.mjs';
import { MerkezYetkisizHatasi } from '../services/merkez.mjs';

const AKIS_CEREZI = 'kamera_merkez_akis';
const AKIS_SN = 600;
const ETIKET_AKIS = 'kamera2/merkez-akis';   // oturum cerezinden ayri imza amaci: akis cerezi oturum cerezi olarak gecmez. Etiket eski adla SABIT (depo cam oldu): degisirse yarim kalan girisler duser

/** Giris sayfasinda gosterilecek hata metinleri; adres cubugunda yalniz KOD gider, metin sunucuda. */
export const MERKEZ_HATALARI = {
  durum: 'Giriş akışı doğrulanamadı; lütfen yeniden deneyin.',
  kod: 'Merkezden kod gelmedi.',
  merkez: 'Merkeze ulaşılamadı; parolanızla giriş yapabilirsiniz.',
  yetki: 'Bu panele erişim yetkiniz yok.',
};

export function merkezDenetleyici({ merkez, baglar, uyeler, gunluk, yapilandirma }) {
  const guvenli = (res) => yapilandirma.sunucu.vekil || !!res.socket?.encrypted;
  const yonlendir = (res, konum) => { res.writeHead(302, { Location: konum, 'Cache-Control': 'no-store' }); res.end(); };
  const hataya = (res, kod) => { cerezYaz(res, AKIS_CEREZI, '', 0, guvenli(res)); yonlendir(res, `/?merkez=${kod}`); };
  const imzala = (yuk) => uyeler.etiketliImza(ETIKET_AKIS, yuk);

  return {
    /** Merkeze gonderir. Dogrulayici ve state imzali cerezde kalir: donen istegin bizim baslattigimiz akis oldugunu boyle biliriz. */
    async baslat(ctx) {
      if (!merkez.acikMi()) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      const dogrulayici = merkez.dogrulayici(), durum = randomBytes(24).toString('base64url');
      const yuk = Buffer.from(JSON.stringify({ d: dogrulayici, s: durum, e: Date.now() + AKIS_SN * 1000 })).toString('base64url');
      cerezYaz(ctx.res, AKIS_CEREZI, `${yuk}.${imzala(yuk)}`, AKIS_SN, guvenli(ctx.res));
      return yonlendir(ctx.res, merkez.girisAdresi(durum, merkez.meydanOkuma(dogrulayici)));
    },

    async geri(ctx) {
      if (!merkez.acikMi()) return json(ctx.res, 404, { hata: 'Yok', kod: 'BULUNAMADI' });
      const { istek, res } = ctx;
      const akis = akisCoz(cerezOku(istek.headers.cookie, AKIS_CEREZI), imzala);
      const state = ctx.q.get('state') ?? '', kod = ctx.q.get('code') ?? '';
      // STATE ESLESMELI (CSRF): eslesmiyorsa bu akisi biz baslatmamisiz; saldirgan kendi kodunu kurbana kullandirabilirdi.
      if (!akis || !state || !guvenliEsit(akis.s, state)) return hataya(res, 'durum');
      if (!kod) return hataya(res, 'kod');
      let kimlik;
      try {
        const jeton = await merkez.jeton(kod, akis.d);
        kimlik = await merkez.kullanici(jeton.access_token);
      } catch (e) {
        if (e instanceof MerkezYetkisizHatasi) { gunluk.yaz('giris-merkez-red', 'merkez', istek, { neden: e.message }); return hataya(res, 'yetki'); }
        gunluk.yaz('giris-merkez-hata', 'merkez', istek, { neden: e.message }); return hataya(res, 'merkez');
      }
      let u;
      try { u = await baglar.girisYap(kimlik, istek); }
      catch (e) { if (e instanceof VeritabaniHatasi) throw e; gunluk.yaz('giris-merkez-red', kimlik.eposta, istek, { neden: e.message }); return hataya(res, 'yetki'); }
      cerezYaz(res, AKIS_CEREZI, '', 0, guvenli(res));
      cerezYaz(res, yapilandirma.oturum.cerez, uyeler.oturumCerezi(u), yapilandirma.oturum.gun * 86400, guvenli(res));
      gunluk.yaz('giris-merkez', u.ad, istek, { eposta: kimlik.eposta, merkezRolu: kimlik.rol });
      return yonlendir(res, '/');
    },

    /**
     * Merkezden "bu kimlik degisti" bildirimi. Jeton yok; kimlik gövdenin HMAC imzasidir (bildirim sirriyla).
     * Gelen veriye guvenilmez: dogru durum merkezden ayrica sorulur. Imza tutmasa da yanit ayni: uc bir sey sizdirmaz.
     */
    async tazele(ctx) {
      const g = await govdeOku(ctx.istek).catch(() => ({}));
      const subject = String(g.subject ?? '').trim();
      if (merkez.acikMi() && merkez.bildirimImzaliMi(subject, String(ctx.istek.headers['x-kimlik-imza'] ?? '')) && baglar.bul(subject)) {
        baglar.tazele(subject).catch(() => {});
      }
      return json(ctx.res, 200, { sonuc: 'alındı' });
    },

    /** Merkezden "bu kisi cikis yapti" (ortak cikis). Imza ani da kapsar; tutarsa an dogrudan uygulanir. Yanit her durumda ayni. */
    async cikis(ctx) {
      const g = await govdeOku(ctx.istek).catch(() => ({}));
      const subject = String(g.subject ?? '').trim(), an = Number(g.an);
      if (merkez.acikMi() && merkez.cikisImzaliMi(subject, an, String(ctx.istek.headers['x-kimlik-imza'] ?? ''))) await baglar.cikisIsle(subject, an);
      return json(ctx.res, 200, { sonuc: 'alındı' });
    },
  };
}

function akisCoz(cerez, imzala) {
  if (!cerez) return null;
  const [yuk, imza] = cerez.split('.');
  if (!yuk || !imza || !guvenliEsit(imzala(yuk), imza)) return null;
  try { const a = JSON.parse(Buffer.from(yuk, 'base64url').toString()); return typeof a.d === 'string' && typeof a.s === 'string' && typeof a.e === 'number' && a.e > Date.now() ? a : null; } catch { return null; }
}

function guvenliEsit(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
