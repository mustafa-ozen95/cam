/**
 * HTTP yardimcilari: JSON yanit, hata yaniti, govde okuma (boyut sinirli), cerez okuma/yazma, istemci IP.
 */
import { YetkiHatasi } from '../models/permission.mjs';
import { VeritabaniHatasi } from './errors.mjs';

export class HttpHatasi extends Error { constructor(durum, mesaj, kod = 'HATA') { super(mesaj); this.durum = durum; this.kod = kod; } }

export const json = (res, kod, nesne) => { res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(nesne)); };

/** Hata -> JSON yanit. YetkiHatasi/HttpHatasi kendi durum kodunu tasir; digerleri `kod` (varsayilan 502: cihaz) ile doner. Ic ayrintisi sizdirilmaz. */
export const hataYaniti = (res, e, kod = 502) => {
  if (res.headersSent) return res.end();
  if (e instanceof YetkiHatasi) { if (e.ekstra?.yenidenDenemeSn) res.setHeader('Retry-After', String(e.ekstra.yenidenDenemeSn)); return json(res, e.durum, { hata: e.message, kod: e.kod, ...e.ekstra }); }
  if (e instanceof HttpHatasi || e instanceof VeritabaniHatasi) return json(res, e.durum, { hata: e.message, kod: e.kod });
  if (e instanceof SyntaxError) return json(res, 400, { hata: 'Gövde JSON olmalı', kod: 'GECERSIZ_JSON' });
  json(res, kod, { hata: e?.message ? String(e.message).slice(0, 300) : 'Beklenmeyen hata', kod: 'SUNUCU' });
};

/** Govde metin olarak (JSON degil: ornegin WebRTC SDP'si). Sinir asilinca kalan govde okunup atilir (soket kesilmez: istemci 413 yanitini alabilsin). */
export const hamGovdeOku = (istek, sinir = 1_000_000) => new Promise((coz, red) => {
  let t = ''; let boyut = 0; let asildi = false;
  istek.on('data', (b) => { if (asildi) return; boyut += b.length; if (boyut > sinir) { asildi = true; t = ''; istek.resume(); red(new HttpHatasi(413, 'Gövde çok büyük', 'GOVDE_BUYUK')); return; } t += b; });
  istek.on('end', () => { if (!asildi) coz(t); });
  istek.on('error', red);
});

export const govdeOku = async (istek, sinir = 1_000_000) => { const t = await hamGovdeOku(istek, sinir); return t ? JSON.parse(t) : {}; };

export const cerezOku = (baslik, ad) => {
  for (const p of (baslik ?? '').split(';')) { const [k, ...v] = p.trim().split('='); if (k === ad) return v.join('='); }
  return null;
};
/** guvenli: TLS'i vekil bitiriyorsa soket duz HTTP'dir; cagiran yapilandirma.sunucu.vekil ile soyler. */
export const cerezYaz = (res, ad, deger, saniye, guvenli = !!res.socket?.encrypted) => res.setHeader('Set-Cookie', `${ad}=${deger}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${saniye}${guvenli ? '; Secure' : ''}`);

export const temizIp = (ip) => String(ip ?? '').replace(/^::ffff:/i, '');
/** Istemci IP: soket adresi; guvenilen vekil basligi ayarliysa oradaki ilk adres. */
export const istemciIp = (istek, guvenilenBaslik = '') => {
  if (guvenilenBaslik) { const v = istek.headers[guvenilenBaslik.toLowerCase()]; if (v) return temizIp(String(v).split(',')[0].trim()); }
  return temizIp(istek.socket.remoteAddress);
};

export const ZAMAN = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
export const GUN = /^\d{4}-\d\d-\d\d$/;
