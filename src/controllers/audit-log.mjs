/** Denetim gunlugu (audit.read). */
import { json } from '../core/http.mjs';

export function auditLogController({ auditLog }) {
  return {
    async list(ctx) {
      const q = ctx.q;
      return json(ctx.res, 200, await auditLog.list({
        size: Math.min(200, Math.max(10, Number(q.get('size')) || 50)), page: Math.max(1, Number(q.get('page')) || 1),
        event: q.get('event') || '', username: q.get('username') || '', ip: q.get('ip') || '', day: q.get('day') || '',
      }));
    },
    async verify(ctx) { return json(ctx.res, 200, await auditLog.verify()); },
  };
}
