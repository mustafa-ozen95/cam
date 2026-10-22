/**
 * Panel API'si (/api/...): arayuzun kullandigi uc noktalar. Cerezle (CSRF basligi zorunlu) ya da Bearer anahtarla calisir.
 * Her rota gerekli izni ara katmanla bildirir; izin listesi dokumana buradan uretilir.
 */
import { permission, any } from '../src/middleware/permissions.mjs';

export function apiRoutes(r, d, middleware) {
  r.post('/api/login', d.login.login, [middleware.identityOptional]);
  r.post('/api/logout', d.login.logout);
  // Merkezden "bu kimlik degisti" bildirimi: jeton yok, HMAC imza (bkz. src/controllers/hub.mjs · refresh).
  r.post('/api/identity/refresh', d.hub.refresh);
  // Merkezden ortak cikis bildirimi: HMAC imza ani da kapsar (bkz. src/controllers/hub.mjs · logout).
  r.post('/api/identity/logout', d.hub.logout);

  r.group([middleware.identity], () => {
    r.get('/api/me', d.login.me);
    // Kendi gorunum tercihleri (Hepsi sirasi/sayisi, arka planda durdurma); yalniz canli izleyebilen uye.
    r.get('/api/me/preferences', d.login.preferences, [permission('live.view')]);
    r.put('/api/me/preferences', d.login.savePreferences, [permission('live.view')]);
    // bilgi: izleme ya da cihaz okuma izni olan herkes (kapsam disi kanallar gizlenir)
    r.get('/api/info', d.devices.info, [any('live.view', 'recording.list', 'recording.play', 'device.read')]);
    // izleme
    // Canli goruntu MP4 (MJPEG web rotasi yok; API v1 canli MJPEG dis sozlesme olarak duruyor)
    r.get('/stream/live-mp4', d.stream.liveMp4, [permission('live.view')]);
    r.get('/api/snapshot', d.stream.snapshot, [permission('live.view')]);
    r.get('/api/recordings', d.stream.records, [permission('recording.list')]);
    r.get('/api/motions', d.stream.motions, [permission('recording.list')]);
    r.get('/stream/playback', d.stream.play, [permission('recording.play')]);
    r.get('/api/download', d.stream.download, [permission('recording.download')]);
    r.get('/api/jobs', async (ctx) => { ctx.res.writeHead(200, { 'Content-Type': 'application/json' }); ctx.res.end('[]'); }, [any('live.view', 'recording.play')]);   // eski istemciler
    // members
    r.get('/api/members', d.members.list, [permission('member.manage')]);
    r.post('/api/members', d.members.add, [permission('member.manage')]);
    r.patch('/api/members/:name', d.members.update, [permission('member.manage')]);
    r.delete('/api/members/:name', d.members.remove, [permission('member.manage')]);
    // audit log
    r.get('/api/audit-log', d.auditLog.list, [permission('audit.read')]);
    r.get('/api/audit-log/verify', d.auditLog.verify, [permission('audit.read')]);
    // Guncelleme kontrolu: yalnizca bakar (GitHub'daki son basarili derleme); guncelleme sunucudan yapilir.
    r.get('/api/update', d.updates.status, [permission('update.check')]);
    r.post('/api/update/check', d.updates.check, [permission('update.check')]);
    // devices
    r.get('/api/devices', d.devices.list, [permission('device.read')]);
    r.post('/api/devices', d.devices.add, [permission('device.manage')]);
    r.patch('/api/devices/:id', d.devices.update, [permission('device.manage')]);
    r.delete('/api/devices/:id', d.devices.remove, [permission('device.manage')]);
    r.post('/api/devices/:id/camera', d.devices.addCamera, [permission('device.manage')]);
    r.put('/api/channels', d.devices.channelSetting, [permission('channel.manage')]);
    r.post('/api/dvr/clock', d.devices.clock, [permission('device.clock')]);
    r.post('/api/dvr/wipe', d.devices.clear, [permission('device.manage')]);
    // permissions: izin katalogu ve roller (okuma: anahtar yonetebilen herkes), yazma: permission.manage
    r.get('/api/access/permissions', d.permissions.permissions, [any('permission.manage', 'api.key', 'member.manage')]);
    r.get('/api/access/roles', d.permissions.roles, [any('permission.manage', 'api.key', 'member.manage')]);
    r.post('/api/access/roles', d.permissions.addRole, [permission('permission.manage')]);
    r.patch('/api/access/roles/:id', d.permissions.updateRole, [permission('permission.manage')]);
    r.delete('/api/access/roles/:id', d.permissions.removeRole, [permission('permission.manage')]);
    // API anahtarlari (permission.manage: hepsi; api.key: kendininkiler)
    r.get('/api/access/keys', d.permissions.keys, [any('permission.manage', 'api.key')]);
    r.post('/api/access/keys', d.permissions.addKey, [any('permission.manage', 'api.key')]);
    r.get('/api/access/keys/:id', d.permissions.key, [any('permission.manage', 'api.key')]);
    r.patch('/api/access/keys/:id', d.permissions.updateKey, [any('permission.manage', 'api.key')]);
    r.post('/api/access/keys/:id/rotate', d.permissions.rotateKey, [any('permission.manage', 'api.key')]);
    r.post('/api/access/keys/:id/revoke', d.permissions.revokeKey, [any('permission.manage', 'api.key')]);
    r.delete('/api/access/keys/:id', d.permissions.removeKey, [any('permission.manage', 'api.key')]);
  });
}
