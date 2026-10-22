/**
 * Merkez ile giris: baslat (merkeze gonder), geri (kodu jetona cevir, uyeyi bagla, oturum ac), tazele (merkezden bildirim).
 * Akis durumu (PKCE dogrulayicisi + state) kisa omurlu, imzali bir cerezde tasinir: sunucuda oturum tablosu yok.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseError } from '../core/errors.mjs';
import { readCookie, writeCookie, readBody, json } from '../core/http.mjs';
import { HubUnauthorizedError } from '../services/hub.mjs';

const FLOW_COOKIE = 'cam_hub_flow';
const FLOW_SECONDS = 600;
const FLOW_LABEL = 'kamera2/merkez-akis';   // oturum cerezinden ayri imza amaci: akis cerezi oturum cerezi olarak gecmez. Etiket eski adla SABIT (depo cam oldu): degisirse yarim kalan girisler duser

/** Giris sayfasinda gosterilecek hata metinleri; adres cubugunda yalniz KOD gider, metin sunucuda. */
export const HUB_ERRORS = {
  state: 'Giriş akışı doğrulanamadı; lütfen yeniden deneyin.',
  code: 'Merkezden kod gelmedi.',
  hub: 'Merkeze ulaşılamadı; parolanızla giriş yapabilirsiniz.',
  denied: 'Bu panele erişim yetkiniz yok.',
};

export function hubController({ hub, links, members, auditLog, config }) {
  const secure = (res) => config.server.proxy || !!res.socket?.encrypted;
  const redirect = (res, position) => { res.writeHead(302, { Location: position, 'Cache-Control': 'no-store' }); res.end(); };
  const toError = (res, code) => { writeCookie(res, FLOW_COOKIE, '', 0, secure(res)); redirect(res, `/?hub=${code}`); };
  const sign = (payload) => members.labeledSignature(FLOW_LABEL, payload);

  return {
    /** Merkeze gonderir. Dogrulayici ve state imzali cerezde kalir: donen istegin bizim baslattigimiz akis oldugunu boyle biliriz. */
    async start(ctx) {
      if (!hub.isEnabled()) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      const codeVerifier = hub.codeVerifier(), status = randomBytes(24).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ d: codeVerifier, s: status, e: Date.now() + FLOW_SECONDS * 1000 })).toString('base64url');
      writeCookie(ctx.res, FLOW_COOKIE, `${payload}.${sign(payload)}`, FLOW_SECONDS, secure(ctx.res));
      return redirect(ctx.res, hub.authorizeUrl(status, hub.codeChallenge(codeVerifier)));
    },

    async back(ctx) {
      if (!hub.isEnabled()) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
      const { req, res } = ctx;
      const stream = parseFlow(readCookie(req.headers.cookie, FLOW_COOKIE), sign);
      const state = ctx.q.get('state') ?? '', code = ctx.q.get('code') ?? '';
      // STATE ESLESMELI (CSRF): eslesmiyorsa bu akisi biz baslatmamisiz; saldirgan kendi kodunu kurbana kullandirabilirdi.
      if (!stream || !state || !secureEqual(stream.s, state)) return toError(res, 'state');
      if (!code) return toError(res, 'code');
      let identity;
      try {
        const token = await hub.token(code, stream.d);
        identity = await hub.username(token.access_token);
      } catch (e) {
        if (e instanceof HubUnauthorizedError) { auditLog.write('hub-login-denied', 'hub', req, { reason: e.message }); return toError(res, 'denied'); }
        auditLog.write('hub-login-error', 'hub', req, { reason: e.message }); return toError(res, 'hub');
      }
      let u;
      try { u = await links.login(identity, req); }
      catch (e) { if (e instanceof DatabaseError) throw e; auditLog.write('hub-login-denied', identity.email, req, { reason: e.message }); return toError(res, 'denied'); }
      writeCookie(res, FLOW_COOKIE, '', 0, secure(res));
      writeCookie(res, config.session.cookie, members.sessionCookie(u), config.session.day * 86400, secure(res));
      auditLog.write('hub-login', u.name, req, { email: identity.email, hubRole: identity.role });
      return redirect(res, '/');
    },

    /**
     * Merkezden "bu kimlik degisti" bildirimi. Jeton yok; kimlik gövdenin HMAC imzasidir (bildirim sirriyla).
     * Gelen veriye guvenilmez: dogru durum merkezden ayrica sorulur. Imza tutmasa da yanit ayni: uc bir sey sizdirmaz.
     */
    async refresh(ctx) {
      const g = await readBody(ctx.req).catch(() => ({}));
      const subject = String(g.subject ?? '').trim();
      if (hub.isEnabled() && hub.isNotificationSigned(subject, String(ctx.req.headers['x-kimlik-imza'] ?? '')) && links.find(subject)) {
        links.refresh(subject).catch(() => {});
      }
      return json(ctx.res, 200, { result: 'alındı' });
    },

    /** Merkezden "bu kisi cikis yapti" (ortak cikis). Imza ani da kapsar; tutarsa an dogrudan uygulanir. Yanit her durumda ayni. */
    async logout(ctx) {
      const g = await readBody(ctx.req).catch(() => ({}));
      const subject = String(g.subject ?? '').trim(), moment = Number(g.moment);
      if (hub.isEnabled() && hub.isLogoutSigned(subject, moment, String(ctx.req.headers['x-kimlik-imza'] ?? ''))) await links.processLogout(subject, moment);
      return json(ctx.res, 200, { result: 'alındı' });
    },
  };
}

function parseFlow(cookie, sign) {
  if (!cookie) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !secureEqual(sign(payload), signature)) return null;
  try { const a = JSON.parse(Buffer.from(payload, 'base64url').toString()); return typeof a.d === 'string' && typeof a.s === 'string' && typeof a.e === 'number' && a.e > Date.now() ? a : null; } catch { return null; }
}

function secureEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
