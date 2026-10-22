/** Giris / cikis / ben. */
import { readCookie, writeCookie, readBody, json } from '../core/http.mjs';
import { DatabaseError } from '../core/errors.mjs';
import { ErrorLimit, expandPermission } from '../models/permission.mjs';

export function loginController({ members, auditLog, config, hub = null, links = null }) {
  /**
   * IP basina giris kisiti: parola karmasi (scrypt) HESAPLANMADAN once bakilir. Uye adi basina kilit (uyeler.dogrula) kullanici adini
   * degistirerek asilabiliyordu; bu kisit istemcinin yaptirabilecegi isi adlardan bagimsiz sinirlar. Ters vekil arkasinda gercek IP icin
   * CAM_IP_HEADER verilmeli (yoksa bu kisit vekil adresine uygulanir).
   */
  const ipThrottle = new ErrorLimit({ maxErrors: 20, windowMs: 60_000, lockMs: 60_000 });
  const cleanup = setInterval(() => { const s = Date.now(); for (const [ip, d] of ipThrottle.ips) if (s - d.first > ipThrottle.windowMs && d.lock < s) ipThrottle.ips.delete(ip); }, 60_000);
  cleanup.unref?.();
  return {
    async login(ctx) {
      const { req, res } = ctx;
      const wait = ipThrottle.isLocked(ctx.ip);
      if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: `Çok fazla deneme. ${wait} sn sonra tekrar deneyin.`, code: 'TOO_MANY_ATTEMPTS' }); }
      const g = await readBody(req, 4096);
      try {
        const u = await members.verify(g.name, g.password, ctx.ip);
        ipThrottle.success(ctx.ip);
        writeCookie(res, config.session.cookie, members.sessionCookie(u), config.session.day * 86400, config.server.proxy || !!res.socket?.encrypted);
        auditLog.write('login', u.name, req);
        return json(res, 200, { name: u.name, role: u.role });
      } catch (err) { ipThrottle.error(ctx.ip); auditLog.write('login-failed', String(g.name ?? '').slice(0, 40), req, { reason: err.message }); return json(res, 401, { error: err.message, code: 'LOGIN' }); }
    },
    /**
     * Cikis yalniz cerezi silmez: uyenin oturum surumu artar, calinmis/kopyalanmis cerezler de gecersiz olur.
     * ORTAK CIKIS: merkezden bagli uyenin cikisi merkeze bildirilir; merkez kendi oturumunu ve diger panelleri kapatir.
     * Beklenmez: merkeze ulasilamasa da cikis olur, yalniz ortak kalmaz.
     */
    async logout(ctx) {
      const who = members.resolveSession(readCookie(ctx.req.headers.cookie, config.session.cookie));
      if (who) {
        await members.endSession(who.name); auditLog.write('logout', who.name, ctx.req);
        const link = links?.byName(who.name);
        if (link && hub?.isEnabled()) hub.sessionClosed(link.sub).catch((e) => console.error('merkeze çıkış bildirilemedi:', e.message));
      }
      writeCookie(ctx.res, config.session.cookie, '', 0, config.server.proxy || !!ctx.res.socket?.encrypted);
      return json(ctx.res, 200, { ok: true });
    },
    async me(ctx) {
      const a = ctx.principal;
      return json(ctx.res, 200, { name: a.name, role: a.role, type: a.type, method: a.method, permissions: expandPermission(a.permissions), scope: a.scope, expiresAt: a.expiresAt, rateLimit: a.rateLimit, keyId: a.keyId });
    },
    /** Uyenin kendi gorunum tercihleri. API anahtari bir kisi degil: tercihi yok (403). */
    async preferences(ctx) {
      if (ctx.principal.type !== 'member') return json(ctx.res, 403, { error: 'Tercih yalnız üye oturumunda', code: 'FORBIDDEN' });
      return json(ctx.res, 200, members.preferences(ctx.principal.name));
    },
    async savePreferences(ctx) {
      if (ctx.principal.type !== 'member') return json(ctx.res, 403, { error: 'Tercih yalnız üye oturumunda', code: 'FORBIDDEN' });
      const g = await readBody(ctx.req, 16_384);
      try { return json(ctx.res, 200, await members.savePreferences(ctx.principal.name, g)); } catch (e) { if (e instanceof DatabaseError) throw e; return json(ctx.res, 404, { error: e.message, code: 'NOT_FOUND' }); }
    },
  };
}
