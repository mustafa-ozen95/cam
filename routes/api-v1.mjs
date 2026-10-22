/**
 * Dis API v1 (/api/v1/...): kararli, dokumante, surumlu. Kimlik: Bearer API anahtari (cerez de calisir).
 * Kaynak odakli adlandirma; kanal yollari /api/v1/kameralar/:kanal/... Ayni denetleyiciler kullanilir (tek is mantigi).
 */
import { permission, any } from '../src/middleware/permissions.mjs';
import { json, cleanIp } from '../src/core/http.mjs';

export function apiV1Routes(r, d, middleware, { devices, config, db }) {
  /**
   * Saglik yoklamasi (Dockerfile HEALTHCHECK, 127.0.0.1): yalniz konteynerin kendi dongu adresinden ve vekilsiz gelen istege yanit verir;
   * baska herkese 404 (panelin varligini/surumunu/cihaz sayisini kimliksiz kimse ogrenmesin). Yanit hicbir dagitim ayrintisi tasimaz.
   */
  r.get('/api/v1/health', async (ctx) => {
    const proxyHeader = config.server.trustedIpHeader;
    const local = ['127.0.0.1', '::1'].includes(cleanIp(ctx.req.socket.remoteAddress)) && !(proxyHeader && ctx.req.headers[proxyHeader.toLowerCase()]);
    if (!local) return json(ctx.res, 404, { error: 'Yok', code: 'NOT_FOUND' });
    if (!(await db.healthy())) return json(ctx.res, 503, { ok: false });   // veritabanina ulasilamiyorsa saglikli degil
    return json(ctx.res, 200, { ok: true });
  });

  r.group([middleware.identity], () => {
    r.get('/api/v1', async (ctx) => json(ctx.res, 200, { name: 'cam', version: 'v1', docs: '/docs/api-v1.tr.md', openapi: '/docs/openapi.json' }));
    r.get('/api/v1/me', d.login.me);
    r.get('/api/v1/permissions', d.permissions.permissions, [any('permission.manage', 'api.key', 'member.manage')]);

    // kameralar (kanallar): kapsam uygulanir
    r.get('/api/v1/cameras', async (ctx) => {
      const b = d.devices.filterByScope(await devices.info(), ctx.principal);
      const list = b.channelNames.map((name, k) => ({ channel: k, code: b.channelCodes?.[k] ?? null, name, deviceName: b.channelDeviceName?.[k] ?? null, device: devices.group.deviceIdOf(k), empty: !!b.channelEmpty[k], camera: b.channelCamera?.[k] || null })).filter((x) => ctx.principal.channelAllowed(x.channel));
      return json(ctx.res, 200, { cameras: list });
    }, [any('live.view', 'recording.list', 'recording.play', 'device.read')]);
    r.get('/api/v1/cameras/:channel/snapshot', d.stream.snapshot, [permission('live.view')]);
    r.get('/api/v1/cameras/:channel/live', d.stream.live, [permission('live.view')]);
    r.get('/api/v1/cameras/:channel/recordings', d.stream.records, [permission('recording.list')]);
    r.get('/api/v1/cameras/:channel/playback', d.stream.play, [permission('recording.play')]);
    r.get('/api/v1/cameras/:channel/download', d.stream.download, [permission('recording.download')]);

    // devices
    r.get('/api/v1/devices', d.devices.list, [permission('device.read')]);
    r.get('/api/v1/devices/info', d.devices.info, [permission('device.read')]);
    r.post('/api/v1/devices', d.devices.add, [permission('device.manage')]);
    r.patch('/api/v1/devices/:id', d.devices.update, [permission('device.manage')]);
    r.delete('/api/v1/devices/:id', d.devices.remove, [permission('device.manage')]);
    r.post('/api/v1/devices/:id/cameras', d.devices.addCamera, [permission('device.manage')]);
    r.post('/api/v1/devices/clock', d.devices.clock, [permission('device.clock')]);
    r.put('/api/v1/channels', d.devices.channelSetting, [permission('channel.manage')]);

    // members, audit log, permissions
    r.get('/api/v1/members', d.members.list, [permission('member.manage')]);
    r.post('/api/v1/members', d.members.add, [permission('member.manage')]);
    r.patch('/api/v1/members/:name', d.members.update, [permission('member.manage')]);
    r.delete('/api/v1/members/:name', d.members.remove, [permission('member.manage')]);
    r.get('/api/v1/audit-log', d.auditLog.list, [permission('audit.read')]);
    r.get('/api/v1/audit-log/verify', d.auditLog.verify, [permission('audit.read')]);
    r.get('/api/v1/roles', d.permissions.roles, [any('permission.manage', 'api.key', 'member.manage')]);
    r.post('/api/v1/roles', d.permissions.addRole, [permission('permission.manage')]);
    r.patch('/api/v1/roles/:id', d.permissions.updateRole, [permission('permission.manage')]);
    r.delete('/api/v1/roles/:id', d.permissions.removeRole, [permission('permission.manage')]);
    r.get('/api/v1/keys', d.permissions.keys, [any('permission.manage', 'api.key')]);
    r.post('/api/v1/keys', d.permissions.addKey, [any('permission.manage', 'api.key')]);
    r.get('/api/v1/keys/:id', d.permissions.key, [any('permission.manage', 'api.key')]);
    r.patch('/api/v1/keys/:id', d.permissions.updateKey, [any('permission.manage', 'api.key')]);
    r.post('/api/v1/keys/:id/rotate', d.permissions.rotateKey, [any('permission.manage', 'api.key')]);
    r.post('/api/v1/keys/:id/revoke', d.permissions.revokeKey, [any('permission.manage', 'api.key')]);
    r.delete('/api/v1/keys/:id', d.permissions.removeKey, [any('permission.manage', 'api.key')]);
  });
}
