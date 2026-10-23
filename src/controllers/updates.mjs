/**
 * Guncelleme (update.check): durum ve "simdi kontrol et". update.apply: yeni surum varsa platformun deploy hook'unu
 * tetikler (bkz. UpdateService.apply); kurulumu platform yapar. Hook adresi yanitta gecmez, yalniz tanimli olup olmadigi.
 */
import { json } from '../core/http.mjs';

export function updateController({ updates, auditLog }) {
  const summary = () => ({ running: updates.version(), repo: updates.setting.repo, last: updates.last(), hasNew: updates.hasNew(), hookReady: updates.hookReady(), canApply: updates.canApply() });
  return {
    async status(ctx) { return json(ctx.res, 200, summary()); },
    async check(ctx) { await updates.check(ctx.principal?.name ?? 'unknown'); return json(ctx.res, 200, summary()); },
    async apply(ctx) {
      let result;
      try { result = await updates.apply(); } catch (e) { return json(ctx.res, 409, { error: `Güncelleme başlatılamadı: ${e.message}`, code: 'UPDATE_NOT_STARTED' }); }
      auditLog.write('update-start', ctx.principal.auditActor, ctx.req, { result });
      return json(ctx.res, 202, { ...summary(), message: `Güncelleme başlatıldı (${result}). Panel birkaç dakika içinde yeni sürümle yeniden açılır; bu sırada sayfa kısa bir süre yanıt vermeyebilir.` });
    },
  };
}
