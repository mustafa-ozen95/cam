/**
 * Yetki yonetimi: izin katalogu, roller, API anahtarlari.
 *  - permission.manage: tum roller/anahtarlar.   - api.key: yalniz KENDI anahtarlari (sahip = kendisi), rolleri yalniz okur.
 * Anahtar gizlisi yalniz olusturma/yenileme yanitinda bir kez doner; dosyada ozet saklanir.
 */
import { readBody, json } from '../core/http.mjs';
import { PERMISSIONS, PERMISSION_GROUPS, PermissionError, isPermissionSubset, expandPermission } from '../models/permission.mjs';

export function permissionController({ permissions, auditLog, devices }) {
  const hasAllPermissions = (principal) => principal.hasPermission('permission.manage');
  /**
   * Yukseltme/sinir denetimi icin cagiran bilgisi. permission.manage'siz cagiranin kendi bagi (IP listesi, bitis, hiz/akis siniri) olusturdugu
   * anahtara tasinir: kisitli bir hesap/anahtar kisitsiz anahtar uretemez.
   */
  const ctxEb = (principal) => ({ parentPermissions: principal.permissions, parentScope: principal.scope, channelTotal: devices.group.channelTotal, deviceIdOf: (k) => devices.group.deviceIdOf(k),
    restricted: !hasAllPermissions(principal), parentIps: hasAllPermissions(principal) ? [] : (principal.ips ?? []), parentExpiresAt: hasAllPermissions(principal) ? null : principal.expiresAt,
    parentRate: principal.type === 'key' && !hasAllPermissions(principal) ? principal.rateLimit : null, parentStream: principal.type === 'key' && !hasAllPermissions(principal) ? principal.concurrentStreams : null });
  /** Sahiplik UYE adiyla baglanir: uyede kendi adi, Bearer anahtarda kaydin sahibi (anahtarin serbest metin goruntu adi ASLA). */
  const ownerName = (principal) => { const s = principal.memberName; if (!s) throw new PermissionError('PERMISSION_DENIED', 'Anahtar sahibi belirlenemedi', 403); return s; };
  /**
   * api.key: anahtar sahibi kendisi olmali. genis=false (okuma/degistirme/yenileme): anahtarin izinleri cagirana ait olanlarin alt kumesi
   * olmali — yenileme sahibin tum yetkisini veren yeni bir gizli donduremez. genis=true (iptal/silme): yalniz uye icin,
   * cunku kendi yetkisi dusurulmus uye eski anahtarini kapatabilmeli.
   */
  const keyAccess = (principal, id, wide = false) => {
    const a = permissions.findKey(id); if (!a) throw new PermissionError('NOT_FOUND', 'Anahtar yok', 404);
    if (hasAllPermissions(principal)) return a;
    if (a.owner !== ownerName(principal)) throw new PermissionError('PERMISSION_DENIED', 'Bu anahtar size ait değil', 403);
    if (!(wide && principal.type === 'member') && !isPermissionSubset(a.permissionsEffective, principal.permissions)) throw new PermissionError('PRIVILEGE_ESCALATION', 'Bu anahtar sizden geniş yetkili', 403);
    return a;
  };
  return {
    async permissions(ctx) { return json(ctx.res, 200, { permissions: Object.entries(PERMISSIONS).map(([id, i]) => ({ id, ...i })), groups: PERMISSION_GROUPS, mine: expandPermission(ctx.principal.permissions) }); },
    async roles(ctx) { return json(ctx.res, 200, permissions.roles()); },
    async addRole(ctx) { ctx.need('permission.manage'); const g = await readBody(ctx.req); const r = await permissions.addRole(g, ctx.principal.auditActor, ctx.principal.permissions); auditLog.write('role-add', ctx.principal.auditActor, ctx.req, { role: r.id, permissions: r.permissions }); return json(ctx.res, 200, r); },
    async updateRole(ctx) { ctx.need('permission.manage'); const g = await readBody(ctx.req); const r = await permissions.updateRole(ctx.param.id, g, ctx.principal.permissions); auditLog.write('role-edit', ctx.principal.auditActor, ctx.req, { role: r.id, permissions: r.permissions }); return json(ctx.res, 200, r); },
    async removeRole(ctx) { ctx.need('permission.manage'); await permissions.removeRole(ctx.param.id); auditLog.write('role-delete', ctx.principal.auditActor, ctx.req, { role: ctx.param.id }); return json(ctx.res, 200, { ok: true }); },

    async keys(ctx) { return json(ctx.res, 200, permissions.keys(hasAllPermissions(ctx.principal) ? (ctx.q.get('owner') || null) : ownerName(ctx.principal))); },
    async addKey(ctx) {
      const g = await readBody(ctx.req);
      if (!hasAllPermissions(ctx.principal)) g.owner = ownerName(ctx.principal);               // kendi adina (anahtarla yapiliyorsa anahtarin sahibi adina)
      const { record, key } = await permissions.createKey(g, ctx.principal.auditActor, ctxEb(ctx.principal));
      auditLog.write('key-create', ctx.principal.auditActor, ctx.req, { key: record.id, name: record.name, role: record.role, permissions: record.permissions, scope: record.scope, expiresAt: record.expiresAt, owner: record.owner });
      return json(ctx.res, 200, { record, key, warning: 'Anahtar yalnız bu yanıtta gösterilir; güvenli bir yere kaydedin.' });
    },
    async key(ctx) { return json(ctx.res, 200, keyAccess(ctx.principal, ctx.param.id)); },
    async updateKey(ctx) {
      keyAccess(ctx.principal, ctx.param.id);
      const g = await readBody(ctx.req); delete g.owner;
      const k = await permissions.updateKey(ctx.param.id, g, ctxEb(ctx.principal));
      auditLog.write('key-edit', ctx.principal.auditActor, ctx.req, { key: k.id, fields: Object.keys(g) });
      return json(ctx.res, 200, k);
    },
    async rotateKey(ctx) { keyAccess(ctx.principal, ctx.param.id); const { record, key } = await permissions.rotateKey(ctx.param.id); auditLog.write('key-rotate', ctx.principal.auditActor, ctx.req, { key: record.id }); return json(ctx.res, 200, { record, key }); },
    async revokeKey(ctx) { keyAccess(ctx.principal, ctx.param.id, true); const k = await permissions.revokeKey(ctx.param.id, ctx.principal.auditActor); auditLog.write('key-revoke', ctx.principal.auditActor, ctx.req, { key: k.id }); return json(ctx.res, 200, k); },
    async removeKey(ctx) { keyAccess(ctx.principal, ctx.param.id, true); await permissions.removeKey(ctx.param.id); auditLog.write('key-delete', ctx.principal.auditActor, ctx.req, { key: ctx.param.id }); return json(ctx.res, 200, { ok: true }); },
  };
}
