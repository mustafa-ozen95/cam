/**
 * Guvenlik ara katmanlari.
 *  - basliklar: CSP, nosniff, frame engeli, referrer, izin politikasi (her yanitta).
 *  - csrf: cerezle gelen durum degistiren isteklerde X-Cam basligi zorunlu (Bearer anahtarli isteklerde gerekmez; cerez gonderilmez).
 */
export const headers = async (ctx, next) => {
  const { res } = ctx;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Arayuz kendi betigi + dis kaynaksiz; akislar blob/data olarak gosterilir.
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  if (res.socket?.encrypted || ctx.config?.server.proxy) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  return next();
};
headers.label = 'security.headers';

export const csrf = async (ctx, next) => {
  const { req } = ctx;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Merkezin bildirimleri (sunucudan sunucuya, HMAC imzali; cerez tasimaz): CSRF basligi istenmez, imza denetleyicide.
  if (ctx.path === '/api/identity/refresh' || ctx.path === '/api/identity/logout') return next();
  const bearer = /^Bearer\s/i.test(String(req.headers.authorization ?? ''));
  if (!bearer && req.headers['x-cam'] !== '1') { ctx.res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); return ctx.res.end(JSON.stringify({ error: 'İstek reddedildi (CSRF)', code: 'CSRF' })); }
  return next();
};
csrf.label = 'csrf';
