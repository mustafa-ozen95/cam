/**
 * Cihaz hizmeti: surucu kaydi, cihaz grubu (calisan nesneler), cihaz deposu (sifreli ayarlar) ve kanal ayarlari (ayarlar tablosu, "kanallar").
 * Denetleyiciler cihaza yalniz bu hizmet uzerinden dokunur.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DatabaseError } from '../core/errors.mjs';
import { Uniview } from '../drivers/uniview.mjs';
import { Hikvision } from '../drivers/hikvision.mjs';
import { Xiongmai } from '../drivers/xiongmai.mjs';
import { IpCamera } from '../drivers/ip-camera.mjs';
import { DeviceGroup } from '../drivers/group.mjs';
import { DeviceStore, TYPES } from '../models/device.mjs';

function findFfmpeg(preferences) {
  for (const a of [preferences, 'ffmpeg'].filter(Boolean)) if (spawnSync(a, ['-version'], { stdio: 'ignore' }).status === 0) return a;
  return null;
}

export class DeviceService {
  /** vt: Veritabani; ayarlar: Ayarlar. Veriyi baslat() getirir. */
  constructor({ config, secret, db, settings }) {
    this.db = db; this.settings = settings;
    this.y = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.ffmpeg = findFfmpeg(config.device.ffmpeg);
    if (!this.ffmpeg) throw new Error('ffmpeg bulunamadı');
    this.drivers = { uniview: Uniview, hikvision: Hikvision, xiongmai: Xiongmai, camera: IpCamera };
    this.types = { ...TYPES };
    this.group = new DeviceGroup({ setting: {}, ffmpeg: this.ffmpeg, dataDir: config.dataDir });
    this.secret = secret;
    this.channelSetting = {};
    this.#applyNames();
  }
  /** Testler icin sahte surucu kaydi (yalniz yapilandirma.cihaz.test). */
  async saveMock() { if (!this.y.device.test) return; const { Mock } = await import('../drivers/mock.mjs'); this.drivers.mock = Mock; this.types.mock = TYPES.mock = { name: 'Sahte (test)', channel: 4, label: 'T' }; }
  /** Depoyu acar (tohumlar) ve cihazlari baslatir. saveMock()'ten SONRA cagrilir. */
  async start() {
    let seed = []; try { seed = JSON.parse(this.y.device.seed); } catch (e) { throw new Error(`CAM_DEVICES okunamadı: ${e.message}`); }
    this.repo = await new DeviceStore(this.db, this.secret, seed).load();
    this.channelSetting = (await this.settings.read('channels')) ?? {}; this.#applyNames();
    for (const a of this.repo.settings()) this.group.add(this.create(a));
  }

  create(a) {
    const S = this.drivers[a.type]; if (!S) throw new Error(`Bilinmeyen cihaz türü: ${a.type}`);
    const c = new S({ setting: a, ffmpeg: this.ffmpeg, dataDir: this.y.dataDir }); c.id = a.id; c.startIndex = a.startIndex; return c;
  }
  attemptConnection(c) {
    return Promise.race([c.info(), new Promise((_, r) => setTimeout(() => r(new Error('cihaz yanıt vermedi (zaman aşımı)')), 25_000))])
      .catch((e) => { try { c.close(); } catch {} throw new Error(`Cihaza bağlanılamadı: ${e.message}`); });
  }

  // ---- cihaz CRUD (depo + grup birlikte)
  list() { return this.repo.list().map((c) => ({ ...c, error: this.group.errors.get(c.id) ?? null })); }
  async add(g) { const k = this.repo.prepare(g); const inst = this.create(k); await this.attemptConnection(inst); await this.repo.add(k); this.group.add(inst); return k; }
  async update(id, g) {
    const k = this.repo.updatePrepare(id, g), old = this.repo.setting(id), inst = this.create(k);
    if (['host', 'username', 'password', 'httpPort', 'rtspPort', 'port', 'template', 'path'].some((a) => String(k[a] ?? '') !== String(old[a] ?? ''))) await this.attemptConnection(inst);
    await this.repo.update(k); this.group.change(id, inst); return k;
  }
  async remove(id) { const old = this.repo.setting(id); await this.repo.remove(id); this.group.detach(id); return old; }
  find(id) { return this.group.devices.find((x) => x.id === id) ?? null; }

  // ---- kanal ayarlari (ad, goster/gizle)
  #applyNames() { this.group.nameOverrides = Object.fromEntries(Object.entries(this.channelSetting).filter(([, v]) => v.name).map(([k, v]) => [k, v.name])); }
  /** Cihaz bilgisine kanal ayarlarini uygular: "D1 (Kanal adı)" bicimi, zorla goster/gizle. */
  applyChannel(b) {
    const ka = this.channelSetting;
    return {
      ...b,
      channelNames: b.channelNames.map((a, i) => (b.channelCodes ? `${b.channelCodes[i]} (${ka[i]?.name || a})` : ka[i]?.name || a)),
      channelDeviceName: b.channelNames,
      channelEmpty: b.channelEmpty.map((x, i) => (ka[i]?.view === 'hide' ? true : ka[i]?.view === 'show' ? false : x)),
      channelAutoEmpty: b.channelEmpty, channelSetting: ka,
    };
  }
  async saveChannelSetting(setting, range) {
    let fresh = {};
    for (const [k, v] of Object.entries(setting ?? {})) {
      if (!/^\d{1,4}$/.test(k) || Number(k) >= 1024 || typeof v !== 'object' || !v) continue;
      const name = String(v.name ?? '').trim().slice(0, 40), view = ['show', 'hide'].includes(v.view) ? v.view : 'auto';
      if (name || view !== 'auto') fresh[k] = { ...(name ? { name } : {}), view };
    }
    if (range) {        // aralik verildiyse yalniz o cihazin kanallari degisir
      const outer = Object.fromEntries(Object.entries(this.channelSetting).filter(([k]) => Number(k) < range.from || Number(k) >= range.last));
      const inner = Object.fromEntries(Object.entries(fresh).filter(([k]) => Number(k) >= range.from && Number(k) < range.last));
      fresh = { ...outer, ...inner };
    }
    try { await this.settings.write('channels', fresh); } catch (e) { console.error('kanal ayari yazilamadi:', e?.code ?? '', e?.message ?? e); throw new DatabaseError(e); }
    this.channelSetting = fresh; this.#applyNames();
    return Object.keys(fresh).length;
  }

  async info() { return this.applyChannel(await this.group.info()); }
  close() { this.group.close(); }
}
