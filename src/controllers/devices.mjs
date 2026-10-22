/** Cihaz yonetimi (device.read / device.manage / device.clock / channel.manage). Parolalar yanitlarda ve gunlukte YOK. */
import { readBody, json } from '../core/http.mjs';
import { DatabaseError } from '../core/errors.mjs';
import { PermissionError } from '../models/permission.mjs';

export function devicesController({ devices, auditLog }) {
  const handleErrors = async (res, fn) => { try { return await fn(); } catch (e) { if (e instanceof PermissionError || e instanceof DatabaseError || e instanceof SyntaxError) throw e; return json(res, 400, { error: e.message, code: 'INVALID_REQUEST' }); } };
  const OUT_OF_SCOPE = (extra) => new PermissionError('OUT_OF_SCOPE', 'Bu cihaz/kamera erişim kapsamınızın dışında', 403, extra);
  const block = (c) => Array.from({ length: c.channelCount ?? c.channel }, (_, i) => c.startIndex + i);
  /** Cihaz kimligiyle yazma (duzenle, sil, kamera ekle, saat): kapsamli asal icin cihazin TUM kanal blogu kapsamda olmali. */
  const needDevice = (principal, id) => {
    if (principal.isUnscoped()) return;
    const c = devices.list().find((x) => x.id === String(id ?? ''));
    if (!c || !block(c).every((k) => principal.channelAllowed(k))) throw OUT_OF_SCOPE({ device: String(id ?? '') });
  };
  /** Kapsamsiz yonetim isleri (yeni cihaz ekleme, disk silme): kapsamli asale kapali. */
  const needUnscoped = (principal) => { if (!principal.isUnscoped()) throw OUT_OF_SCOPE({}); };
  /**
   * Kapsamli asal icin bilgi: kapsam disi kanal/cihaz verisi hic donmez. Kanal dizilerinin UZUNLUGU korunur (arayuz indeksle calisir),
   * kapsam disi hucreler maskelenir; cihaz/disk/toplam alanlari yalniz gorunen cihazlardan yeniden kurulur.
   */
  const filterByScope = (b, principal) => {
    if (principal.isUnscoped()) return b;
    const allowed = (i) => principal.channelAllowed(i);
    const mask = (d, empty = '') => (Array.isArray(d) ? d.map((x, i) => (allowed(i) ? x : empty)) : d);
    const channelEmpty = b.channelEmpty.map((x, i) => x || !allowed(i));
    if (!b.devices) return { ...b, channelEmpty };
    const visible = b.devices.filter((c) => block(c).some(allowed));
    const ids = new Set(visible.map((c) => c.id));
    const disks = (b.disks ?? []).filter((d) => ids.has(d.device));
    const first = visible[0];
    return {
      ...b, channelEmpty,
      channelNames: mask(b.channelNames), channelCodes: mask(b.channelCodes), channelCamera: mask(b.channelCamera),
      channelDevice: mask(b.channelDevice), channelDeviceName: mask(b.channelDeviceName), channelAutoEmpty: mask(b.channelAutoEmpty, true),
      channelSetting: Object.fromEntries(Object.entries(b.channelSetting ?? {}).filter(([k]) => allowed(Number(k)))),
      devices: visible, disks,
      host: visible.map((c) => c.host).join(' + '), model: visible.map((c) => c.model).join(' + '),
      version: visible.map((c) => c.version).join(' / '), serialNo: visible.map((c) => c.serialNo).join(' / '), build: visible.map((c) => c.build).join(' / '),
      clock: first?.clock ?? null, uptimeSec: first?.uptimeSec ?? 0,
      diskMB: { total: disks.reduce((t, d) => t + (d.totalMB ?? 0), 0), empty: disks.reduce((t, d) => t + (d.freeMB ?? 0), 0) },
    };
  };
  return {
    filterByScope,
    async info(ctx) { return json(ctx.res, 200, filterByScope(await devices.info(), ctx.principal)); },
    async list(ctx) {
      const l = devices.list();
      const principal = ctx.principal;
      const g = principal.isUnscoped() ? l : l.filter((c) => Array.from({ length: c.channelCount }, (_, i) => c.startIndex + i).some((k) => principal.channelAllowed(k)));
      return json(ctx.res, 200, { devices: g, types: devices.types });
    },
    async add(ctx) {
      return handleErrors(ctx.res, async () => {
        needUnscoped(ctx.principal);
        const k = await devices.add(await readBody(ctx.req));
        auditLog.write('device-add', ctx.principal.auditActor, ctx.req, { device: k.host, type: k.type, name: k.name });
        return json(ctx.res, 200, { ok: true, id: k.id });
      });
    },
    async update(ctx) {
      return handleErrors(ctx.res, async () => {
        needDevice(ctx.principal, ctx.param.id);
        const k = await devices.update(ctx.param.id, await readBody(ctx.req));
        auditLog.write('device-edit', ctx.principal.auditActor, ctx.req, { device: k.host, name: k.name });
        return json(ctx.res, 200, { ok: true });
      });
    },
    async remove(ctx) {
      return handleErrors(ctx.res, async () => {
        needDevice(ctx.principal, ctx.param.id);
        const old = await devices.remove(ctx.param.id);
        auditLog.write('device-delete', ctx.principal.auditActor, ctx.req, { device: old?.host, name: old?.name });
        return json(ctx.res, 200, { ok: true });
      });
    },
    /** NVR'a kamera kaydet (kayit NVR'da yapilir). */
    async addCamera(ctx) {
      return handleErrors(ctx.res, async () => {
        needDevice(ctx.principal, ctx.param.id);
        const c = devices.find(ctx.param.id);
        if (!c) return json(ctx.res, 404, { error: 'Cihaz yok', code: 'NOT_FOUND' });
        if (typeof c.addCamera !== 'function') return json(ctx.res, 400, { error: 'Bu cihaz türünde panelden kamera eklenemez (cihazın kendi arayüzünden ekleyin)', code: 'NOT_SUPPORTED' });
        const g = await readBody(ctx.req);
        const name = String(g.name ?? '').trim().slice(0, 40), ip = String(g.ip ?? '').trim(), username = String(g.username ?? '').trim();
        if (!name) throw new Error('Kamera adı gerekli');
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error('Kamera IP adresi geçersiz (örn. 192.168.2.50)');
        if (!username || typeof g.password !== 'string' || !g.password) throw new Error('Kamera kullanıcı adı ve parolası gerekli');
        const port = g.port === undefined || g.port === '' ? undefined : Number(g.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Port geçersiz');
        const r = await c.addCamera({ name, ip, username, password: g.password, protocol: g.protocol === 'ONVIF' ? 'ONVIF' : 'HIKVISION', port });
        auditLog.write('nvr-camera-add', ctx.principal.auditActor, ctx.req, { device: c.setting.host, camera: ip, name, channel: c.startIndex + r.channel, online: r.online });
        return json(ctx.res, 200, { ok: true, channel: c.startIndex + r.channel, online: r.online });
      });
    },
    async clock(ctx) {
      const g = await readBody(ctx.req);
      needDevice(ctx.principal, g.device);
      const r = await devices.group.syncClock(g.device);
      auditLog.write('clock-sync', ctx.principal.auditActor, ctx.req, { auto: false, device: r.device, before: r.before, after: r.after, server: r.server });
      return json(ctx.res, 200, r);
    },
    async channelSetting(ctx) {
      const g = await readBody(ctx.req);
      let range = Number.isInteger(g.from) && Number.isInteger(g.last) ? { from: g.from, last: g.last } : null;
      let setting = g.setting ?? {};
      if (!ctx.principal.isUnscoped()) {
        // Kapsamli asal yalniz kendi kanallarinin ayarini degistirir; kapsam disi kanal anahtari reddedilir, kapsam disi MEVCUT ayarlar korunur
        // (kanallar.json tek global dosya: harita kapsamli kullanicinin gonderdigiyle tumden degistirilmez).
        const numeric = (k) => /^\d{1,4}$/.test(k);
        const within = (k) => !range || (Number(k) >= range.from && Number(k) < range.last);
        const outer = Object.keys(setting).find((k) => numeric(k) && within(k) && !ctx.principal.channelAllowed(Number(k)));
        if (outer !== undefined) throw OUT_OF_SCOPE({ channel: Number(outer) });
        const kept = Object.entries(devices.channelSetting).filter(([k]) => !ctx.principal.channelAllowed(Number(k)) || !within(k));
        setting = { ...Object.fromEntries(kept), ...Object.fromEntries(Object.entries(setting).filter(([k]) => numeric(k) && within(k))) };
        range = null;
      }
      const n = await devices.saveChannelSetting(setting, range);
      auditLog.write('channel-settings', ctx.principal.auditActor, ctx.req, { channelCount: n });
      return json(ctx.res, 200, { ok: true });
    },
    async clear(ctx) {
      needUnscoped(ctx.principal);
      const g = await readBody(ctx.req);
      if (g.confirm !== 'TÜM KAYITLARI SİL') return json(ctx.res, 400, { error: 'Onay metni yanlış', code: 'INVALID_REQUEST' });
      return json(ctx.res, 200, await devices.group.diskClear());
    },
  };
}
