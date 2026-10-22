/**
 * Yetki ara katmanlari: izin(...) belirli bir izni zorunlu kilar; herhangi(...) listeden biri yeterli.
 * ctx.gerek(izin) ve ctx.needChannel(kanal) denetleyicilere de verilir (dinamik denetim icin).
 */
import { PermissionError } from '../models/permission.mjs';

export const requireHelpers = (principal) => ({
  need: (permission) => { if (!principal.hasPermission(permission)) throw new PermissionError('PERMISSION_DENIED', `Bu işlem için izin gerekir: ${permission}`, 403, { requiredPermission: permission }); },
  needChannel: (k) => { if (!principal.channelAllowed(k)) throw new PermissionError('OUT_OF_SCOPE', 'Bu kamera erişim kapsamınızın dışında', 403, { channel: k }); return k; },
});

export const permission = (...permissions) => {
  const middleware = async (ctx, next) => {
    Object.assign(ctx, requireHelpers(ctx.principal));
    for (const i of permissions) ctx.need(i);
    return next();
  };
  middleware.label = `permission:${permissions.join('+')}`;
  return middleware;
};
export const any = (...permissions) => {
  const middleware = async (ctx, next) => {
    Object.assign(ctx, requireHelpers(ctx.principal));
    if (!ctx.principal.anyPermission(permissions)) throw new PermissionError('PERMISSION_DENIED', `Bu işlem için izin gerekir: ${permissions.join(' | ')}`, 403, { requiredPermission: permissions[0] });
    return next();
  };
  middleware.label = `permission:${permissions.join('|')}`;
  return middleware;
};
