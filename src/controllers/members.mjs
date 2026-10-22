/**
 * Uye yonetimi (member.manage izni). Yetki yukseltme engeli: kendi izinlerinin ustunde rol / kendi kapsami disinda kamera verilemez;
 * kendinden yetkili bir uyeye (parola sifirlama, rol dusurme, silme dahil) dokunulamaz; kendi hesap kisitlari (bitis, IP) gevsetilemez.
 */
import { writeCookie, readBody, json } from '../core/http.mjs';
import { DatabaseError } from '../core/errors.mjs';
import { PermissionError, normalizeExpiresAt, normalizeIps, isPermissionSubset, scopeWithin, normalizeScope } from '../models/permission.mjs';

export function membersController({ members, permissions, auditLog, devices, links = null, config }) {
  const checkRole = (principal, role) => { if (role !== undefined && !isPermissionSubset(permissions.rolePermissions(role), principal.permissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sahip olmadığınız izinleri içeren bir rol veremezsiniz', 403); };
  const checkScope = (principal, k) => {
    if (principal.isUnscoped()) return;
    const kk = k === undefined ? null : normalizeScope(k);
    if (!kk || !scopeWithin(kk, principal.scope, devices.group.channelTotal, (x) => devices.group.deviceIdOf(x))) throw new PermissionError('PRIVILEGE_ESCALATION', 'Kapsamınız kısıtlı: üyeye yalnız kendi kapsamınızdaki kameraları verebilirsiniz', 403);
  };
  /**
   * Degistirilecek/silinecek HEDEF uyenin MEVCUT hali de cagirana sigmali: rolunun izinleri cagirananin alt kumesi, kapsami cagirananin kapsami icinde
   * (kapsamsiz hedef = kapsamsiz cagiran). Yalniz yeni degerleri denetlemek yetmez: parola sifirlama/silme icin yeni deger yok.
   */
  const checkTarget = (principal, name) => {
    const u = members.find(name); if (!u) return;   // model 'Kullanıcı yok' der
    if (!isPermissionSubset(permissions.rolePermissions(u.role), principal.permissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Sizden yetkili bir üyeyi değiştiremez ya da silemezsiniz', 403);
    if (!principal.isUnscoped() && (!u.scope || !scopeWithin(u.scope, principal.scope, devices.group.channelTotal, (x) => devices.group.deviceIdOf(x)))) throw new PermissionError('PRIVILEGE_ESCALATION', 'Kapsamınız dışındaki bir üyeyi değiştiremez ya da silemezsiniz', 403);
  };
  /**
   * Hesap baglari (bitis, IP listesi) cagiranin baglarindan gevsek olamaz ('*' sahibi haric: tam yetkili kisitlari kaldirabilir).
   * Olusturmada deger cagiranin sinirinda olmali; guncellemede DEGISMEYEN deger serbest (arayuz hepsini geri yollar), degisen deger
   * baskasi icin cagiranin sinirini, KENDI hesabi icin hesabin mevcut kaydini gevsetemez.
   */
  const checkContext = (principal, g, target) => {
    if (principal.hasPermission('*')) return;
    const own = !!target && target.name === principal.memberName;
    const expiresAtLimit = own ? target.expiresAt : principal.expiresAt, ipLimit = own ? (target.ips ?? []) : (principal.ips ?? []);
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    if (target ? g.expiresAt !== undefined : true) {
      const b = normalizeExpiresAt(g.expiresAt);
      if (!(target && same(b, target.expiresAt ?? null)) && expiresAtLimit && (!b || Date.parse(b) > Date.parse(expiresAtLimit))) throw new PermissionError('PRIVILEGE_ESCALATION', 'Hesap süresini sizin ya da hesabın bitişinden uzatamazsınız / süresiz bırakamazsınız', 403);
    }
    if (target ? g.ips !== undefined : true) {
      const l = normalizeIps(g.ips);
      if (!(target && same(l, target.ips ?? [])) && ipLimit.length && (!l.length || l.some((k) => !ipLimit.includes(k)))) throw new PermissionError('PRIVILEGE_ESCALATION', 'IP kısıtını sizin ya da hesabın listesi dışına çıkaramaz / kaldıramazsınız', 403);
    }
  };
  const handleErrors = async (res, fn) => { try { return await fn(); } catch (e) { if (e instanceof PermissionError || e instanceof DatabaseError || e instanceof SyntaxError) throw e; return json(res, 400, { error: e.message, code: 'INVALID_REQUEST' }); } };
  return {
    async list(ctx) { return json(ctx.res, 200, members.everyone()); },
    async add(ctx) {
      return handleErrors(ctx.res, async () => {
        const g = await readBody(ctx.req), role = g.role;
        if (!role) throw new PermissionError('INVALID_REQUEST', 'Rol gerekli', 400);
        checkRole(ctx.principal, role); checkScope(ctx.principal, g.scope); checkContext(ctx.principal, g, null);
        await members.add(g.name, g.password, role, { scope: g.scope, expiresAt: g.expiresAt, ips: g.ips });
        auditLog.write('member-add', ctx.principal.auditActor, ctx.req, { member: g.name, role });
        return json(ctx.res, 200, { ok: true });
      });
    },
    async update(ctx) {
      return handleErrors(ctx.res, async () => {
        const g = await readBody(ctx.req), name = ctx.param.name;
        checkTarget(ctx.principal, name);
        checkRole(ctx.principal, g.role); if (g.scope !== undefined) checkScope(ctx.principal, g.scope);
        checkContext(ctx.principal, g, members.find(name));
        await members.update(name, { password: g.password, role: g.role, scope: g.scope, expiresAt: g.expiresAt, ips: g.ips }, ctx.principal.memberName, ctx.ip);
        auditLog.write('member-edit', ctx.principal.auditActor, ctx.req, { member: name, fields: Object.keys(g).filter((k) => k !== 'password'), password: g.password !== undefined });
        // Kendi parolasini degistiren, parola yuzunden oturum surumu artinca dusmesin: ayni istekte yeni cerez verilir.
        const me = ctx.principal.type === 'member' && g.password !== undefined && members.find(name)?.name === ctx.principal.name ? members.find(name) : null;
        if (me) writeCookie(ctx.res, config.session.cookie, members.sessionCookie(me), config.session.day * 86400, config.server.proxy || !!ctx.res.socket?.encrypted);
        return json(ctx.res, 200, { ok: true });
      });
    },
    async remove(ctx) {
      return handleErrors(ctx.res, async () => {
        checkTarget(ctx.principal, ctx.param.name);
        const target = members.find(ctx.param.name);
        await members.remove(ctx.param.name, ctx.principal.memberName);
        // Silinen uyeye ait her sey birlikte gider: API anahtarlari iptal edilir, KYM bagi dusurulur (ad yeniden kullanilsa da devralinamaz).
        if (target) for (const a of permissions.keys(target.name)) await permissions.revokeKey(a.id, ctx.principal.auditActor);
        await links?.releaseMember(ctx.param.name);
        auditLog.write('member-delete', ctx.principal.auditActor, ctx.req, { member: ctx.param.name });
        return json(ctx.res, 200, { ok: true });
      });
    },
  };
}
