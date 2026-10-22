/**
 * Cihaz grubu: birden cok NVR'i (Uniview, Hikvision) tek panelde birlestirir. Her cihazin KALICI bir kanal blogu vardir
 * (cihaz.baslangic .. baslangic+channelCount-1); cihaz eklenip silinse de baska cihazlarin kanal numaralari kaymaz.
 * sunucu.mjs grubu tek bir cihazmis gibi kullanir. Bir cihaza ulasilamazsa son bilinen kanal listesi korunur
 * (arayuz yeniden dizilmez), baska cihazlar etkilenmez. Cihazlar calisirken eklenip cikarilabilir.
 */
import { DeviceBase } from './base.mjs';

export class DeviceGroup extends DeviceBase {
  constructor({ devices = [], ...o }) {
    super(o);
    this.devices = [];
    this.lastInfo = new Map();     // cihaz id -> son basarili bilgi()
    this.errors = new Map();      // cihaz id -> son hata metni
    for (const c of devices) this.add(c);
  }

  get channelTotal() { return this.devices.reduce((m, c) => Math.max(m, c.startIndex + c.channelCount), 0); }

  add(c) { this.devices.push(c); this.devices.sort((a, b) => a.startIndex - b.startIndex); }
  /** Ayni id'li cihazi yenisiyle degistirir (eskisinin akislari kapanir). */
  change(id, fresh) {
    const i = this.devices.findIndex((c) => c.id === id);
    if (i >= 0) { try { this.devices[i].close(); } catch {} this.devices.splice(i, 1); }
    this.lastInfo.delete(id); this.errors.delete(id);
    this.add(fresh);
  }
  detach(id) {
    const i = this.devices.findIndex((c) => c.id === id);
    if (i >= 0) { try { this.devices[i].close(); } catch {} this.devices.splice(i, 1); }
    this.lastInfo.delete(id); this.errors.delete(id);
  }

  /** Global kanal numarasinin ait oldugu cihazin kimligi (yoksa null). */
  deviceIdOf(channel) {
    for (const c of this.devices) if (channel >= c.startIndex && channel < c.startIndex + c.channelCount) return c.id;
    return null;
  }

  #find(channel) {
    for (const c of this.devices) if (channel >= c.startIndex && channel < c.startIndex + c.channelCount) return { c, local: channel - c.startIndex };
    throw new Error('kanal geçersiz');
  }

  // ---------- bilgi ----------
  async info() {
    if (!this.devices.length) throw new Error('Henüz cihaz eklenmedi (Cihaz sekmesinden ekleyin)');
    const result = await Promise.all(this.devices.map((c) => c.info().then(
      (b) => { this.lastInfo.set(c.id, b); this.errors.delete(c.id); return { c, b }; },
      (e) => { this.errors.set(c.id, e.message); return { c, b: this.lastInfo.get(c.id), error: e.message }; })));
    if (result.every((s) => !s.b)) throw new Error(result.find((s) => s.error)?.error ?? 'Cihaza ulaşılamadı');
    const T = this.channelTotal;
    const names = Array.from({ length: T }, (_, k) => `Kanal ${k + 1}`), codes = Array.from({ length: T }, (_, k) => `K${k + 1}`);
    const empty = new Array(T).fill(true), camera = new Array(T).fill(''), deviceName = new Array(T).fill('');
    for (const { c, b } of result) {
      if (!b) continue;
      for (let i = 0; i < c.channelCount; i++) {
        const k = c.startIndex + i;
        names[k] = b.channelNames?.[i] ?? names[k]; codes[k] = b.channelCodes?.[i] ?? codes[k];
        empty[k] = b.channelEmpty?.[i] ?? true; camera[k] = b.channelCamera?.[i] ?? ''; deviceName[k] = b.model ?? '';
      }
    }
    this.channelNames = names;
    const first = (result.find((s) => s.b?.clock) ?? result.find((s) => s.b)).b;
    const field = (f) => result.map((s) => s.b?.[f] ?? '—').join(' / ');
    return {
      channelEmpty: empty,
      serverClock: first.serverClock,
      host: result.map((s) => s.b?.host ?? s.c.setting.host).join(' + '),
      model: result.map((s) => s.b?.model ?? '?').join(' + '),
      version: field('version'), serialNo: field('serialNo'), build: field('build'),
      uptimeSec: first.uptimeSec, clock: first.clock, channel: T,
      channelNames: names, channelCodes: codes, channelCamera: camera, channelDevice: deviceName,
      diskMB: { total: result.reduce((a, s) => a + (s.b?.diskMB.total ?? 0), 0), empty: result.reduce((a, s) => a + (s.b?.diskMB.empty ?? 0), 0) },
      disks: result.flatMap((s) => (s.b?.disks ?? []).map((d) => ({ ...d, name: `${s.b.model} · ${d.name}`, device: s.c.id }))),
      recordDayEstimated: result.map((s) => s.b?.recordDayEstimated).find((x) => x) ?? null,
      devices: result.map(({ c, b, error }) => ({
        id: c.id, name: c.setting.name ?? '', model: b?.model ?? '?', host: b?.host ?? c.setting.host, version: b?.version ?? '—', serialNo: b?.serialNo ?? '—', build: b?.build ?? '—',
        clock: b?.clock ?? null, uptimeSec: b?.uptimeSec ?? 0, channel: c.channelCount, startIndex: c.startIndex, error: error ?? null,
      })),
    };
  }

  // ---------- kanal bazli islemler: ilgili cihaza yonlendirilir ----------
  feed(channel, type, width, fps) { const { c, local } = this.#find(channel); return c.feed(local, type === 'Mini' && !c.miniSupport ? 'Extra1' : type, width, fps); }
  /** Canli MP4; surucusu desteklemeyen cihazda (Xiongmai DVR) null (501). */
  feedMp4(channel, type, convert) { const { c, local } = this.#find(channel); return c.feedMp4 ? c.feedMp4(local, type, convert) : null; }
  records(channel, from, to) { const { c, local } = this.#find(channel); return c.records(local, from, to); }
  /** Hareketli araliklar [{bas, bit}]; desteklemeyen surucude bos. */
  async motions(channel, from, to) { const { c, local } = this.#find(channel); return c.motions ? c.motions(local, from, to) : []; }
  playMjpeg(res, channel, from, to, width) { const { c, local } = this.#find(channel); return c.playMjpeg(res, local, from, to, width); }
  pipeDownload(res, channel, record, name, onEnd) { const { c, local } = this.#find(channel); return c.pipeDownload(res, local, record, name, onEnd); }

  /** Cihaz id'si ile tek bir cihazin saatini esitler (arayuz: cihaz satirindaki Esitle). */
  async syncClock(id) {
    const c = this.devices.find((x) => x.id === id);
    if (!c) throw new Error('Cihaz belirtilmedi');
    return { ...(await c.syncClock()), device: c.setting.host };
  }

  /**
   * Oynatma yeri: kanal verilirse YALNIZ o kanalin cihazina bakilir. Butun cihazlara bakilsaydi bir
   * NVR dolunca obur NVR'dan da kayit acilamazdi.
   */
  canPlay(channel) { return channel === undefined ? this.devices.every((c) => c.canPlay()) : this.#find(channel).c.canPlay(); }
  canDownload() { return this.devices.every((c) => c.canDownload()); }
  close() { for (const c of this.devices) c.close(); }
}
