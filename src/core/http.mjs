/**
 * HTTP yardimcilari: JSON yanit, hata yaniti, govde okuma (boyut sinirli), cerez okuma/yazma, istemci IP.
 */
import { PermissionError } from '../models/permission.mjs';
import { DatabaseError } from './errors.mjs';

export class HttpError extends Error { constructor(status, message, code = 'ERROR') { super(message); this.status = status; this.code = code; } }

export const json = (res, code, object) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(object)); };

/** Hata -> JSON yanit. PermissionError/HttpError kendi durum kodunu tasir; digerleri `kod` (varsayilan 502: cihaz) ile doner. Ic ayrintisi sizdirilmaz. */
export const errorResponse = (res, e, code = 502) => {
  if (res.headersSent) return res.end();
  if (e instanceof PermissionError) { if (e.extra?.retryAfterSec) res.setHeader('Retry-After', String(e.extra.retryAfterSec)); return json(res, e.status, { error: e.message, code: e.code, ...e.extra }); }
  if (e instanceof HttpError || e instanceof DatabaseError) return json(res, e.status, { error: e.message, code: e.code });
  if (e instanceof SyntaxError) return json(res, 400, { error: 'Gövde JSON olmalı', code: 'INVALID_JSON' });
  json(res, code, { error: e?.message ? String(e.message).slice(0, 300) : 'Beklenmeyen hata', code: 'SERVER' });
};

/** Govde metin olarak (JSON degil: ornegin WebRTC SDP'si). Sinir asilinca kalan govde okunup atilir (soket kesilmez: istemci 413 yanitini alabilsin). */
export const readRawBody = (req, limit = 1_000_000) => new Promise((resolve, red) => {
  let t = ''; let size = 0; let exceeded = false;
  req.on('data', (b) => { if (exceeded) return; size += b.length; if (size > limit) { exceeded = true; t = ''; req.resume(); red(new HttpError(413, 'Gövde çok büyük', 'BODY_TOO_LARGE')); return; } t += b; });
  req.on('end', () => { if (!exceeded) resolve(t); });
  req.on('error', red);
});

export const readBody = async (req, limit = 1_000_000) => { const t = await readRawBody(req, limit); return t ? JSON.parse(t) : {}; };

export const readCookie = (header, name) => {
  for (const p of (header ?? '').split(';')) { const [k, ...v] = p.trim().split('='); if (k === name) return v.join('='); }
  return null;
};
/** guvenli: TLS'i vekil bitiriyorsa soket duz HTTP'dir; cagiran yapilandirma.sunucu.vekil ile soyler. */
export const writeCookie = (res, name, value, sec, secure = !!res.socket?.encrypted) => res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sec}${secure ? '; Secure' : ''}`);

export const cleanIp = (ip) => String(ip ?? '').replace(/^::ffff:/i, '');
/** Istemci IP: soket adresi; guvenilen vekil basligi ayarliysa oradaki ilk adres. */
export const clientIp = (req, trustedHeader = '') => {
  if (trustedHeader) { const v = req.headers[trustedHeader.toLowerCase()]; if (v) return cleanIp(String(v).split(',')[0].trim()); }
  return cleanIp(req.socket.remoteAddress);
};

export const DATETIME_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
export const DATE_RE = /^\d{4}-\d\d-\d\d$/;
