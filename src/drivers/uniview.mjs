/**
 * Uniview NVR surucusu (LAPI + RTSP).
 * Canli: rtsp://.../unicast/c<N>/s<0|1>/live (H.265). Kayit: rtsp://.../c<N>/b<epoch>/e<epoch>/replay/.
 * Kayit listesi: cihaz yalniz gun bazinda "kayit var" bilgisi veriyor (DailyDistribution); gunler 15 dk'lik dilimlere bolunur.
 * Zaman: arayuz cihazin YEREL saatini kullanir; RTSP/LAPI epoch'u = yerel saat - cihaz saat dilimi (GMT+02:00 gibi).
 */
import { DeviceBase, requestDigest, localText, localSec } from './base.mjs';
import { RtspDevice } from './rtsp.mjs';

const SLICE = 900;                       // kayit dilimi (sn)
const MOTION_END = 4;

/**
 * Kayit parcalarindan hareketli araliklar (yerel saat metni). 132'li parca hareket olan kanalda cikar, hareketsiz alanda
 * hic cikmaz (cihazda hareket algilama acik, bolge ihlali kapali).
 * Olay parcasi = [hareket basi, hareket sonu + SON KAYIT] (kanal ayari, ornek 60 sn): parcanin tamami isaretlenince 3 sn'lik
 * hareket 70 sn gorunur. Son kayit dusulur. On kayit (10 sn) parcada YOK:
 * en kisa parca 64 sn < 10 + 60; goruntude de hareket parcanin ilk 4 sn'sinde, son 60 sn durgun.
 * Pencere sinirinda kesilen parca: sonu pencere sonundaysa hareket suruyor olabilir, dusulmez; basi pencere basindaysa ve
 * hareket pencereden once bitmisse atilir.
 */
export const univiewMotion = (parts, tzSec, lastRecord = 0, timeRange = [-Infinity, Infinity]) => (parts ?? [])
  .filter((r) => r.RecordType & MOTION_END && r.End > r.Begin)
  .map((r) => ({ b: r.Begin, e: r.End >= timeRange[1] ? r.End : r.End - lastRecord }))
  .filter((r) => r.e > r.b || r.b > timeRange[0])
  .map((r) => ({ from: localText(r.b + tzSec), to: localText(Math.max(r.e, r.b + 1) + tzSec) }));

export class Uniview extends RtspDevice {
  constructor(o) {
    super(o);
    this.httpHost = `http://${this.setting.host}:${Number(this.setting.httpPort ?? 80)}`;
    this.tzSec = 7200;                                  // cihaz saat dilimi; clockDifference() okuyunca guncellenir
    this.bitRate = {};
    this.channelCount = Number(this.setting.channelCount ?? 32);
    this.label = this.setting.label ?? 'D';
  }

  async lapi(path, method = 'GET', body) {
    const { status, text } = await requestDigest(this.httpHost + path, { username: this.setting.username, password: this.setting.password, method, body: body ? JSON.stringify(body) : undefined });
    let j; try { j = JSON.parse(text); } catch { throw new Error(`Cihaz yanıtı okunamadı (HTTP ${status})`); }
    const y = j.Response;
    if (y?.ResponseCode !== 0) throw new Error(`Cihaz hatası: ${y?.ResponseString ?? status}`);
    this.lastError = null;
    return y.Data;
  }

  // ---------- saat ----------
  async clockDifference() {
    const t = await this.lapi('/LAPI/V1.0/System/Time');
    const m = /GMT([+-])(\d\d):(\d\d)/.exec(t.TimeZone ?? '');
    if (m) this.tzSec = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
    const local = t.DeviceTime + this.tzSec;
    const server = DeviceBase.localTime();
    this.deviceLocal = { sec: local, z: Date.now() };
    return { dvr: localText(local), server, diff: Math.round(local - localSec(server)) };
  }
  /** Cihaz saatini sunucu saatine (Europe/Istanbul) esitler. Saat dilimi ayari degismez; yalniz DeviceTime (cihazin UTC'si) ayarlanir. */
  async syncClock() {
    const before = await this.clockDifference();
    const t = await this.lapi('/LAPI/V1.0/System/Time');
    await this.lapi('/LAPI/V1.0/System/Time', 'PUT', { ...t, DeviceTime: Math.round(localSec(DeviceBase.localTime())) - this.tzSec });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await this.clockDifference();
    return { before: before.dvr, previousDiff: before.diff, after: after.dvr, server: after.server, lastDiff: after.diff };
  }
  /** Cihazin su anki yerel saati (sn): son okuma + gecen sure. */
  async deviceNow() {
    if (!this.deviceLocal || Date.now() - this.deviceLocal.z > 600_000) await this.clockDifference();
    return this.deviceLocal.sec + (Date.now() - this.deviceLocal.z) / 1000;
  }
  epoch(localTextZ) { return Math.round(localSec(localTextZ) - this.tzSec); }   // yerel metin -> cihaz epoch'u (RTSP/LAPI)

  // ---------- bilgi ----------
  async loadChannelNames(channel) {
    if (this.nameCache && Date.now() - this.nameCache.z < 3600_000) return this.nameCache.list;
    const list = new Array(channel).fill(''), device = new Array(channel).fill('');
    try {
      // NVR'in kanal listesi (cihaz arayuzundeki "D1 (Kanal adı)"): ad + bagli kameranin markasi/modeli/IP'si
      const d = await this.lapi('/LAPI/V1.0/Channels/System/ChannelDetailInfos');
      for (const c of d.DetailInfos ?? []) {
        const k = c.ID - 1; if (k < 0 || k >= channel) continue;
        list[k] = c.Name ?? '';
        device[k] = [c.Manufacturer, c.DeviceModel, c.AddressInfo?.Address].filter(Boolean).join(' · ');
      }
    } catch {}
    this.nameCache = { z: Date.now(), list, device };
    this.channelNames = list;
    return list;
  }

  async recordStatus() {
    if (this.statusCache && Date.now() - this.statusCache.z < 120_000) return this.statusCache.v;
    const d = await this.lapi('/LAPI/V1.0/Channels/System/RecordStatus');
    const v = new Map((d.Statuses ?? []).map((s) => [s.ID, s]));
    for (const [id, s] of v) this.bitRate[id - 1] = s.BitRate;
    this.statusCache = { z: Date.now(), v };
    return v;
  }

  async info() {
    const CHANNEL = this.channelCount;
    const [device, clock, names, status, diskData, dayEstimate] = await Promise.all([
      this.lapi('/LAPI/V1.0/System/DeviceInfo'),
      this.clockDifference(),
      this.loadChannelNames(CHANNEL),
      this.recordStatus().catch(() => null),
      this.lapi('/LAPI/V1.0/Storage/Containers/DetailInfos').catch(() => null),
      this.lapi('/LAPI/V1.0/Channels/Media/Record/EstimatedDays').catch(() => null),
    ]);
    // Disk sagligi: LAPI yalniz durum kodu + sicaklik verir (SMART ayrintisi yok). 3 = calisiyor (kayit sirasinda saglikli diskte goruldu).
    const disks = (diskData?.LocalHDDList ?? []).map((h) => ({
      name: `Disk ${h.ID}`, manufacturer: h.Manufacturer ?? '', totalMB: h.TotalCapacity ?? 0, freeMB: h.RemainCapacity ?? 0, temperature: h.Temperature ?? null,
      status: h.Status === 3 ? ((h.Temperature ?? 0) > 60 ? 'error' : (h.Temperature ?? 0) > 50 ? 'warning' : 'good') : 'warning',
      statusText: h.Status === 3 ? 'Normal' : `Durum kodu ${h.Status}`,
      recordStart: null, recordEnd: null, existing: true,
    }));
    const k = device.BuildDate ?? {};
    return {
      channelEmpty: await this.channelEmptyStatus(CHANNEL),
      serverClock: clock.server,
      host: this.setting.host, model: device.DeviceModel, version: device.FirmwareVersion, serialNo: device.SerialNumber,
      build: k.Year ? `${k.Year}-${String(k.Month).padStart(2, '0')}-${String(k.Day).padStart(2, '0')}` : '',
      uptimeSec: 0, clock: clock.dvr, channel: CHANNEL,
      channelNames: names.map((a, i) => a || `Kanal ${i + 1}`),
      channelCodes: names.map((_, i) => `${this.label}${i + 1}`),
      channelCamera: this.nameCache?.device ?? [],
      diskMB: { total: disks.reduce((a, x) => a + x.totalMB, 0), empty: disks.reduce((a, x) => a + x.freeMB, 0) },
      disks, recordDayEstimated: dayEstimate?.EstimatedDays ?? null,
      recordActive: status ? [...status.values()].filter((s) => s.RecordStatus === 1).length : null,
    };
  }

  /** Kayit durumu listesinde olmayan kanal (kamera tanimli degil) bostur. */
  async channelEmptyStatus(channel) {
    const force = new Set(this.setting.hiddenChannels ?? []);
    try {
      const status = await this.recordStatus();
      return Array.from({ length: channel }, (_, k) => force.has(k) || !status.has(k + 1));
    } catch { return Array.from({ length: channel }, (_, k) => force.has(k)); }
  }

  // ---------- kayit listesi ----------
  async records(channel, from, to) {
    const bDay = from.slice(0, 10), eDay = to.slice(0, 10);
    const now = await this.deviceNow();
    const days = [];
    for (let g = Date.parse(`${bDay}T00:00:00Z`); g <= Date.parse(`${eDay}T00:00:00Z`); g += 864e5) days.push(new Date(g).toISOString().slice(0, 10));
    const months = [...new Set(days.map((g) => g.slice(0, 7)))];
    const var_ = new Set();
    await Promise.all(months.map(async (month) => {
      const [y, m] = month.split('-').map(Number);
      const d = await this.lapi(`/LAPI/V1.0/Channels/${channel + 1}/Media/Video/Streams/0/Records/DailyDistribution?Year=${y}&Month=${m}`);
      (d.DailyStatus ?? []).forEach((s, i) => { if (s) var_.add(`${month}-${String(i + 1).padStart(2, '0')}`); });
    }));
    await this.recordStatus().catch(() => {});
    const rate = (this.bitRate[channel] ?? 1500) * 125;     // kbit/sn -> bayt/sn (tahmini)
    const result = [];
    for (const g of days) {
      if (!var_.has(g)) continue;
      const g0 = localSec(`${g} 00:00:00`);
      for (let b = g0; b < g0 + 86400; b += SLICE) {
        if (b >= now) break;
        const e = Math.min(b + SLICE, Math.floor(now));
        const bm = localText(b), em = localText(e);
        if (em < from || bm > to) continue;
        result.push({ name: `/nvr/c${channel + 1}/${this.epoch(bm)}.h264`, from: bm, to: em, size: Math.round(rate * (e - b)), type: 'R' });
      }
    }
    return result;
  }

  /** Hareketli araliklar (zaman cizelgesinde isaret). Cihazin kayit parcalarindan: tur 128 surekli, 132 = surekli + hareket (bit 4). */
  async motions(channel, from, to) {
    await this.deviceNow();                             // saat dilimi guncel olsun (epoch <-> yerel)
    const b = this.epoch(from), e = this.epoch(to);
    const [d, lastRecord] = await Promise.all([this.lapi(`/LAPI/V1.0/Channels/${channel + 1}/Media/Video/Streams/0/Records?Begin=${b}&End=${e}`), this.#lastRecord(channel)]);
    return univiewMotion(d.RecordInfos, this.tzSec, lastRecord, [b, e]);
  }
  /** Kanalin son kayit suresi (sn; kayit plani). Saatte bir okunur; okunamazsa 0 (parca oldugu gibi) ve 5 dk sonra yeniden denenir. */
  async #lastRecord(channel) {
    this.lastRecordCache ??= new Map();
    const k = this.lastRecordCache.get(channel);
    if (k && Date.now() < k.last) return k.sec;
    let sec = 0, duration = 3_600_000;
    try { sec = Number((await this.lapi(`/LAPI/V1.0/Channels/${channel + 1}/Storage/Private/Schedule/Record/`)).RecordRule?.PostRecordTime) || 0; }
    catch { sec = k?.sec ?? 0; duration = 300_000; }
    this.lastRecordCache.set(channel, { sec, last: Date.now() + duration });
    return sec;
  }

  // ---------- RTSP adresleri ----------
  livePath(channel, type) { return `unicast/c${channel + 1}/s${type === 'Extra1' || type === 'Mini' ? 1 : 0}/live`; }
  playPath(channel, from, to) { return `c${channel + 1}/b${this.epoch(from)}/e${this.epoch(to)}/replay/`; }
}
