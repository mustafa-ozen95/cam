/**
 * Canli sayfa yonetimi (/api/live-pages): olusturma, ad/yol/erisim/rol degisikligi, silme. Yazma livepage.manage ister.
 * Liste: yoneticiye tum kayitlar + secilebilir roller; yalniz live.view olana gorebildigi sayfalar (ust seritteki baglantilar).
 * Erisim degisikligi guvenlik olayidir: gunluge onceki ve yeni deger yazilir.
 */
import { json, readBody } from '../core/http.mjs';
import { canView } from '../models/live-page.mjs';

export function livePagesController({ livePages, live, permissions, auditLog }) {
  const row = (p) => ({ id: p.id, name: p.name, slug: p.slug, access: p.access, roles: p.roles ?? [], cameraCount: live.layoutOf(p).paths.length, isDefault: !!live.layoutOf(p).isDefault, createdBy: p.createdBy, createdAt: p.createdAt, updatedBy: p.updatedBy, updatedAt: p.updatedAt });
  const pick = (g) => Object.fromEntries(['name', 'slug', 'access', 'roles'].filter((k) => g?.[k] !== undefined).map((k) => [k, g[k]]));
  return {
    async list(ctx) {
      if (ctx.principal.hasPermission('livepage.manage')) {
        const roles = permissions.roles().map((r) => ({ id: r.id, name: r.name?.tr ?? r.name?.en ?? r.id }));
        return json(ctx.res, 200, { open: live.open, manage: true, pages: livePages.list().map(row), roles });
      }
      return json(ctx.res, 200, { open: live.open, manage: false, pages: livePages.list().filter((p) => canView(p, ctx.principal)).map((p) => ({ name: p.name, slug: p.slug, access: p.access })) });
    },
    async add(ctx) {
      const g = pick(await readBody(ctx.req, 10_000));
      const p = await livePages.add(g, ctx.principal.auditActor);
      auditLog.write('livepage-add', ctx.principal.auditActor, ctx.req, { page: p.id, name: p.name, slug: p.slug, access: p.access, roles: p.roles });
      return json(ctx.res, 200, row(p));
    },
    async update(ctx) {
      const g = pick(await readBody(ctx.req, 10_000));
      const old = livePages.find(ctx.param.id);
      const before = old ? { slug: old.slug, access: old.access, roles: [...(old.roles ?? [])] } : null;
      const p = await livePages.update(ctx.param.id, g, ctx.principal.auditActor);
      auditLog.write('livepage-edit', ctx.principal.auditActor, ctx.req, { page: p.id, fields: Object.keys(g), before, after: { slug: p.slug, access: p.access, roles: p.roles } });
      return json(ctx.res, 200, row(p));
    },
    async remove(ctx) {
      const p = await livePages.remove(ctx.param.id);
      auditLog.write('livepage-delete', ctx.principal.auditActor, ctx.req, { page: p.id, name: p.name, slug: p.slug, access: p.access });
      return json(ctx.res, 200, { result: 'deleted' });
    },
  };
}
