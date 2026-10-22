/**
 * Kimlik ara katmani: istegi yapan ASAL'i cozer ve ctx.asal'a koyar.
 * Sira: Bearer kp_... (API anahtari) -> oturum cerezi. Anahtarda IP listesi, sure, iptal ve hiz denetlenir.
 * Anahtar, SAHIBI olan uyenin turevidir: sahip silinmis/suresi dolmus/IP disinda/merkezde erisimi kalkmissa anahtar da islemez; anahtarin
 * izin ve kapsami hicbir zaman sahibin GUNCEL rolunun ustune cikmaz. (Sahibi uye olmayan anahtar — permission.manage'in verdigi entegrasyon etiketi — kendi haklariyla calisir.)
 * `kimlik` oturum zorunlu; `identityOptional` yoksa gecer (ctx.asal = null).
 */
import { Principal, PermissionError, ipMatches, permissionIntersection, scopeIntersection } from '../models/permission.mjs';
import { readCookie, clientIp, json } from '../core/http.mjs';

export function setupIdentity({ members, permissions, devices, config, links = null }) {
  const CTX = { deviceIdOf: (k) => devices.group.deviceIdOf(k), channelTotal: () => devices.group.channelTotal };
  const memberPrincipal = (u, method = 'cookie') => new Principal({ type: 'member', method, name: u.name, identity: `member:${u.name.toLowerCase()}`, role: u.role, permissions: permissions.rolePermissions(u.role), scope: u.scope ?? null, expiresAt: u.expiresAt ?? null, ips: u.ips ?? [], rateLimit: config.permissions.memberRateLimit, concurrentStreams: config.permissions.memberStreamLimit }, CTX);
  const keyPrincipal = (a, method = 'key') => new Principal({ type: 'key', method, name: a.name, owner: a.owner ?? null, identity: `key:${a.id}`, keyId: a.id, role: a.role, permissions: permissions.keyPermissions(a), scope: a.scope ?? null, expiresAt: a.expiresAt ?? null, ips: a.ips ?? [], rateLimit: a.rateLimit, concurrentStreams: a.concurrentStreams }, CTX);

  function resolve(ctx) {
    const { req } = ctx;
    const ip = clientIp(req, config.server.trustedIpHeader); ctx.ip = ip;
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    const bearer = m ? m[1] : null;
    if (bearer) {
      const a = permissions.verifyKey(bearer, ip);
      const owner = a.owner ? members.find(a.owner) : null;
      if (owner) {
        if (owner.expiresAt && Date.parse(owner.expiresAt) <= Date.now()) throw new PermissionError('KEY_OWNER', 'Anahtarın sahibinin hesap süresi dolmuş', 401);
        if (links && !links.isAccessible(owner.name)) throw new PermissionError('HUB_ACCESS', 'Anahtar sahibinin merkezdeki erişimi kalktı', 401);
        if (owner.ips?.length && !ipMatches(ip, owner.ips)) throw new PermissionError('IP_BLOCKED', 'Bu IP adresinden erişim yok', 403);
      }
      permissions.saveUsage(a.id, ip);
      const principal = keyPrincipal(a);
      if (owner) {
        // sahibin simdiki hakkini asamaz: rolu dusurulduyse anahtar da ayni anda daralir
        const ownerPermission = permissions.rolePermissions(owner.role);
        if (!ownerPermission.includes('*')) { principal.permissions = permissionIntersection(principal.permissions, ownerPermission); principal.set = new Set(principal.permissions); }
        if (owner.scope) principal.scope = scopeIntersection(principal.scope, owner.scope, devices.group.channelTotal, (k) => devices.group.deviceIdOf(k));
      }
      return principal;
    }
    const u = members.resolveSession(readCookie(req.headers.cookie, config.session.cookie));
    if (!u) return null;
    // Merkezden bagli uye: merkezde erisimi kalktiysa cerez islemez (bkz. HubLinks.isAccessible).
    if (links && !links.isAccessible(u.name)) throw new PermissionError('HUB_ACCESS', 'Merkezdeki erişiminiz kalktığı için oturum kapatıldı', 401);
    // Ortak cikis: merkezden ya da bagli bir panelden cikildiysa bu oturum kapanir (bkz. HubLinks.isLogoutAfter).
    if (links && links.isLogoutAfter(u.name, u.openedAt)) throw new PermissionError('HUB_LOGOUT', 'Merkezden ya da bağlı bir panelden çıkış yapıldığı için oturum kapatıldı', 401);
    if (u.ips?.length && !ipMatches(ip, u.ips)) throw new PermissionError('IP_BLOCKED', 'Bu IP adresinden erişim yok', 403);
    return memberPrincipal(u);
  }

  const identity = async (ctx, next) => {
    ctx.principal = resolve(ctx);
    if (!ctx.principal) return json(ctx.res, 401, { error: 'Oturum gerekli', code: 'LOGIN_REQUIRED' });
    permissions.attemptRate(ctx.principal);
    return next();
  };
  identity.label = 'identity';
  const identityOptional = async (ctx, next) => { ctx.ip = clientIp(ctx.req, config.server.trustedIpHeader); try { ctx.principal = resolve(ctx); } catch { ctx.principal = null; } return next(); };
  identityOptional.label = 'identity?';
  return { identity, identityOptional, memberPrincipal, keyPrincipal, CTX };
}
