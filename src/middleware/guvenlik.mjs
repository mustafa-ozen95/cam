/**
 * Guvenlik ara katmanlari.
 *  - basliklar: CSP, nosniff, frame engeli, referrer, izin politikasi (her yanitta).
 *  - csrf: cerezle gelen durum degistiren isteklerde X-Kamera basligi zorunlu (Bearer anahtarli isteklerde gerekmez; cerez gonderilmez).
 */
export const basliklar = async (ctx, sonraki) => {
  const { res } = ctx;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Arayuz kendi betigi + dis kaynaksiz; akislar blob/data olarak gosterilir.
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  if (res.socket?.encrypted || ctx.yapilandirma?.sunucu.vekil) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  return sonraki();
};
basliklar.ad = 'guvenlik.basliklar';

export const csrf = async (ctx, sonraki) => {
  const { istek } = ctx;
  if (['GET', 'HEAD', 'OPTIONS'].includes(istek.method)) return sonraki();
  // Merkezin bildirimleri (sunucudan sunucuya, HMAC imzali; cerez tasimaz): CSRF basligi istenmez, imza denetleyicide.
  if (ctx.yol === '/api/kimlik/tazele' || ctx.yol === '/api/kimlik/cikis') return sonraki();
  const bearer = /^Bearer\s/i.test(String(istek.headers.authorization ?? ''));
  if (!bearer && istek.headers['x-kamera'] !== '1') { ctx.res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); return ctx.res.end(JSON.stringify({ hata: 'İstek reddedildi (CSRF)', kod: 'CSRF' })); }
  return sonraki();
};
csrf.ad = 'csrf';
