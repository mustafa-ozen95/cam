/**
 * Hikvision NVR surucusu (ISAPI + RTSP).
 * Canli: rtsp://.../Streaming/Channels/<kanal*100+1|2> (1 = ana akis, 2 = alt akis). Kayit: .../Streaming/tracks/<kanal*100+1>?starttime=..Z&endtime=..Z
 * Kayit listesi: ISAPI /ContentMgmt/search gercek kayit araliklarini verir; araliklar 15 dk'lik dilimlere bolunur (liste/indirme icin).
 * Zaman: cihaz yerel saati "Z" ekiyle yazar ve okur (UTC degil); panel de yerel saat kullanir, donusum gerekmez.
 */
import { DeviceBase, requestDigest, localText, localSec } from './base.mjs';
import { RtspDevice } from './rtsp.mjs';

const SLICE = 900;
const resolve = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const get = (xml, label) => { const m = new RegExp(`<${label}>([^<]*)</${label}>`).exec(xml); return m ? resolve(m[1]).trim() : ''; };
const blocks = (xml, label) => [...xml.matchAll(new RegExp(`<${label}[\\s>][\\s\\S]*?</${label}>`, 'g'))].map((m) => m[0]);
/**
 * Olay gunlugundeki hareket baslangic/bitislerinden kanal basina araliklar. Kayit surekli (CMR) oldugu icin kayit aramasi
 * hareketi ayirmiyor; NVR gunlugu ayiriyor: metaId "log.hikvision.com/Alarm/motionStart/7" (7 = kanal no, 1'den).
 * Bitisi gelmemis baslangic: aralik sonuna (ya da su ana) kadar; baslangici araliktan once kalan bitis: aralik basindan.
 */
export function hikMotionMatch(events, from, to) {
  const channels = new Map();
  for (const o of [...events].sort((x, y) => x.t.localeCompare(y.t))) {
    const k = channels.get(o.channel) ?? { open: null, ranges: [] };
    channels.set(o.channel, k);
    if (o.begin) { if (k.open === null) k.open = o.t; }
    else { k.ranges.push({ from: k.open ?? from, to: o.t }); k.open = null; }
  }
  for (const k of channels.values()) if (k.open !== null) k.ranges.push({ from: k.open, to });
  return new Map([...channels].map(([n, k]) => [n, k.ranges.filter((a) => a.to > a.from)]));
}
const MOTION_EVENT = /\/Alarm\/motion(Start|Stop)\/(\d+)$/;
const rtspTime = (local) => `${local.slice(0, 10).replaceAll('-', '')}T${local.slice(11, 19).replaceAll(':', '')}Z`;

export class Hikvision extends RtspDevice {
  constructor(o) {
    super(o);
    this.httpHost = `http://${this.setting.host}:${Number(this.setting.httpPort ?? 80)}`;
    this.channelCount = Number(this.setting.channelCount ?? 16);
    this.label = this.setting.label ?? 'H';
  }

  async isapi(path, method = 'GET', xml) {
    const { status, text } = await requestDigest(this.httpHost + path, { username: this.setting.username, password: this.setting.password, method, body: xml, type: 'application/xml' });
    if (status >= 400) throw new Error(`Cihaz hatası: HTTP ${status}`);
    this.lastError = null;
    return text;
  }

  // ---------- saat ----------
  async clockDifference() {
    const t = await this.isapi('/ISAPI/System/time');
    const local = get(t, 'localTime').slice(0, 19).replace('T', ' ');          // 2026-10-05T10:48:16+03:00 -> cihaz yerel saati
    if (!local) throw new Error('Cihaz saati okunamadı');
    const server = DeviceBase.localTime();
    this.deviceLocal = { sec: localSec(local), z: Date.now() };
    return { dvr: local, server, diff: Math.round(localSec(local) - localSec(server)) };
  }
  /** Cihaz saatini sunucu saatine esitler. Cihaz NTP modundaysa elle (manual) moda gecer: NTP kaynagi sapmaliysa ayar kalici olarak elle olur. */
  async syncClock() {
    const before = await this.clockDifference();
    const t = await this.isapi('/ISAPI/System/time');
    const offset = /([+-]\d\d:\d\d)$/.exec(get(t, 'localTime'))?.[1] ?? '+03:00', tz = get(t, 'timeZone') || 'CST-3:00:00';
    const xml = `<Time version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><timeMode>manual</timeMode><localTime>${DeviceBase.localTime().replace(' ', 'T')}${offset}</localTime><timeZone>${tz}</timeZone></Time>`;
    const y = await this.isapi('/ISAPI/System/time', 'PUT', xml);
    if (get(y, 'statusCode') !== '1') throw new Error(`Cihaz saati ayarlamadı (${get(y, 'statusString') || 'bilinmeyen hata'})`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await this.clockDifference();
    return { before: before.dvr, previousDiff: before.diff, after: after.dvr, server: after.server, lastDiff: after.diff };
  }
  async deviceNow() {
    if (!this.deviceLocal || Date.now() - this.deviceLocal.z > 600_000) await this.clockDifference();
    return this.deviceLocal.sec + (Date.now() - this.deviceLocal.z) / 1000;
  }

  // ---------- bilgi ----------
  async channels() {
    if (this.channelCache && Date.now() - this.channelCache.z < 300_000) return this.channelCache.v;
    const n = this.channelCount;
    const name = new Array(n).fill(''), camera = new Array(n).fill(''), online = new Array(n).fill(false), defined = new Array(n).fill(false);
    const list = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels');
    for (const b of blocks(list, 'InputProxyChannel')) {
      const k = Number(get(b, 'id')) - 1; if (!(k >= 0 && k < n)) continue;
      defined[k] = true; name[k] = get(b, 'name');
      camera[k] = ['Hikvision', get(b, 'model'), get(b, 'ipAddress')].filter(Boolean).join(' · ');
    }
    try {
      const status = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels/status');
      for (const b of blocks(status, 'InputProxyChannelStatus')) { const k = Number(get(b, 'id')) - 1; if (k >= 0 && k < n) online[k] = get(b, 'online') === 'true'; }
    } catch { online.fill(true); }
    const v = { name, camera, online, defined };
    this.channelCache = { z: Date.now(), v };
    this.channelNames = name;
    return v;
  }

  async info() {
    const n = this.channelCount;
    const [device, clock, channel, repo] = await Promise.all([
      this.isapi('/ISAPI/System/deviceInfo'),
      this.clockDifference(),
      this.channels(),
      this.isapi('/ISAPI/ContentMgmt/Storage').catch(() => ''),
    ]);
    // Disk sagligi: cihazin SMART ozeti (sicaklik, calisma gunu, oz degerlendirme, bozuk/yeniden atanan sektor)
    const disks = await Promise.all(blocks(repo, 'hdd').map(async (h) => {
      const id = get(h, 'id'), status = get(h, 'status'), tp = Number(get(h, 'capacity')) || 0;
      const sm = await this.isapi(`/ISAPI/ContentMgmt/Storage/hdd/${id}/SMARTTest/status`).catch(() => '');
      const sic = sm && get(sm, 'temprature') !== '' ? Number(get(sm, 'temprature')) : null;
      const day = sm && get(sm, 'powerOnDay') !== '' ? Number(get(sm, 'powerOnDay')) : null;
      const oz = get(sm, 'selfEvaluaingStatus');
      const attributes = blocks(sm, 'TestResult');
      const broken = attributes.filter((a) => get(a, 'attributeID') !== '0' && !['ok', 'illegal'].includes(get(a, 'status'))).length;   // id 0 / illegal = bos oznitelik yuvasi
      const raw = (no) => Number(get(attributes.find((a) => get(a, 'attributeID') === String(no)) ?? '', 'rawValue')) || 0;
      const assigned = raw(5), pending = raw(197), unfixable = raw(198);
      const error = status !== 'ok' || (oz && oz !== 'ok') || (sic ?? 0) > 60;
      const warning = (sic ?? 0) > 50 || broken > 0 || assigned > 0 || pending > 0 || unfixable > 0;
      const detail = sm ? [`SMART: ${oz || '—'}`, day !== null ? `${day} gün çalışıyor` : '', `yeniden atanan sektör ${assigned}`, pending ? `bekleyen sektör ${pending}` : '', unfixable ? `düzeltilemeyen ${unfixable}` : '', broken ? `${broken} SMART özniteliği eşik dışı` : ''].filter(Boolean).join(' · ') : 'SMART okunamadı';
      return {
        name: `Disk ${id}`, manufacturer: get(h, 'hddType'), totalMB: tp, freeMB: Number(get(h, 'freeSpace')) || 0, temperature: sic, uptimeDays: day,
        status: error ? 'error' : warning ? 'warning' : 'good', statusText: error ? 'Arıza' : warning ? 'Dikkat' : 'Normal', detail,
        recordStart: null, recordEnd: null, existing: true,
      };
    }));
    const force = new Set(this.setting.hiddenChannels ?? []);
    return {
      channelEmpty: Array.from({ length: n }, (_, k) => force.has(k) || !channel.defined[k] || !channel.online[k]),
      serverClock: clock.server,
      host: this.setting.host, model: get(device, 'model'), version: `${get(device, 'firmwareVersion')} ${get(device, 'firmwareReleasedDate')}`.trim(), serialNo: get(device, 'serialNumber'),
      build: get(device, 'firmwareReleasedDate'),
      uptimeSec: 0, clock: clock.dvr, channel: n,
      channelNames: channel.name.map((a, i) => a || `Kanal ${i + 1}`),
      channelCodes: channel.name.map((_, i) => `${this.label}${i + 1}`),
      channelCamera: channel.camera,
      diskMB: { total: disks.reduce((a, x) => a + x.totalMB, 0), empty: disks.reduce((a, x) => a + x.freeMB, 0) },
      disks, recordDayEstimated: null,
    };
  }

  /**
   * NVR'a IP kamera kaydeder (kayit NVR'da yapilir). Bos kanal numarasi (1..channelCount) otomatik secilir; yalniz EKLER, mevcut kanallara dokunmaz.
   * protokol: HIKVISION (port 8000) ya da ONVIF (port 80). Dondurur { kanal (0 tabanli yerel), cevrimici }.
   */
  async addCamera({ name, ip, username, password, protocol = 'HIKVISION', port }) {
    if (!['HIKVISION', 'ONVIF'].includes(protocol)) throw new Error('Protokol geçersiz');
    const xml = (m) => String(m).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const list = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels');
    const full = new Set(blocks(list, 'InputProxyChannel').map((b) => Number(get(b, 'id'))));
    if ([...full].some((id) => get(blocks(list, 'InputProxyChannel').find((b) => Number(get(b, 'id')) === id) ?? '', 'ipAddress') === ip)) throw new Error('Bu IP adresli bir kamera NVR\'da zaten kayıtlı');
    let id = 0; for (let i = 1; i <= this.channelCount; i++) if (!full.has(i)) { id = i; break; }
    if (!id) throw new Error('NVR\'da boş kanal yok');
    const body = `<InputProxyChannel version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><id>${id}</id><name>${xml(name)}</name><sourceInputPortDescriptor><proxyProtocol>${protocol}</proxyProtocol><addressingFormatType>ipaddress</addressingFormatType><ipAddress>${xml(ip)}</ipAddress><managePortNo>${Number(port) || (protocol === 'ONVIF' ? 80 : 8000)}</managePortNo><srcInputPort>1</srcInputPort><userName>${xml(username)}</userName><password>${xml(password)}</password><streamType>auto</streamType></sourceInputPortDescriptor></InputProxyChannel>`;
    const y = await this.isapi('/ISAPI/ContentMgmt/InputProxy/channels', 'POST', body);
    if (get(y, 'statusCode') && get(y, 'statusCode') !== '1') throw new Error(`NVR kamerayı kabul etmedi (${get(y, 'statusString') || 'bilinmeyen hata'})`);
    this.channelCache = null;
    await new Promise((r) => setTimeout(r, 4000));                       // NVR kameraya baglanip durumu guncellesin
    const k = await this.channels().catch(() => null);
    return { channel: id - 1, online: !!k?.online[id - 1] };
  }

  // ---------- kayit listesi ----------
  async records(channel, from, to) {
    const trace = (channel + 1) * 100 + 1;
    const range = [];
    for (let position = 0, type = 0; type < 60; type++) {
      const xml = `<CMSearchDescription><searchID>{${crypto.randomUUID().toUpperCase()}}</searchID><trackIDList><trackID>${trace}</trackID></trackIDList>`
        + `<timeSpanList><timeSpan><startTime>${from.replace(' ', 'T')}Z</startTime><endTime>${to.replace(' ', 'T')}Z</endTime></timeSpan></timeSpanList>`
        + `<maxResults>40</maxResults><searchResultPostion>${position}</searchResultPostion><metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>`;
      const y = await this.isapi('/ISAPI/ContentMgmt/search', 'POST', xml);
      const items = blocks(y, 'searchMatchItem');
      for (const o of items) {
        const b = get(o, 'startTime').slice(0, 19).replace('T', ' '), e = get(o, 'endTime').slice(0, 19).replace('T', ' ');
        const size = Number(/[?&;]size=(\d+)/.exec(resolve(get(o, 'playbackURI')))?.[1]) || 0;
        if (b && e && e > b) range.push({ b, e, size });
      }
      if (items.length < 40 || get(y, 'responseStatusStrg') !== 'MORE') break;
      position += items.length;
    }
    // gercek araliklar 15 dk dilimlere bolunur (dilim sinirlari duvar saatine hizali)
    const result = [];
    for (const a of range) {
      const as = localSec(a.b), ae = localSec(a.e), duration = ae - as;
      for (let t = as; t < ae; t = (Math.floor(t / SLICE) + 1) * SLICE) {
        const expiresAt = Math.min(ae, (Math.floor(t / SLICE) + 1) * SLICE);
        const bm = localText(t), em = localText(expiresAt);
        if (em < from || bm > to) continue;
        result.push({ name: `/hik/c${channel + 1}/${t}.h264`, from: bm, to: em, size: Math.round(a.size * ((expiresAt - t) / duration)), type: 'R' });
      }
    }
    return result.sort((x, y) => x.from.localeCompare(y.from));
  }

  /**
   * Hareketli araliklar (zaman cizelgesinde isaret). Gunluk cihazin tamami icin tek: ayni gun icin her kanal ayri sorsa da
   * cihaz bir kez taranir (bugun 30 sn, gecmis gun 10 dk saklanir).
   */
  async motions(channel, from, to) {
    this.motionMemory ??= new Map();
    const key = `${from}|${to}`, now = Date.now();
    for (const [a, v] of this.motionMemory) if (v.last < now) this.motionMemory.delete(a);
    let k = this.motionMemory.get(key);
    if (!k) {
      // Bitisi gelmemis hareket su ana kadar (gun sonuna uzayip gelecegi isaretlemesin)
      const deviceNow = localText(Math.floor(await this.deviceNow())), today = to >= deviceNow;
      k = { last: now + (today ? 30_000 : 600_000), promise: this.#motionScan(from, to, today ? deviceNow : to) };
      this.motionMemory.set(key, k);
      k.promise.catch(() => this.motionMemory.delete(key));
    }
    return (await k.promise).get(channel + 1) ?? [];
  }
  async #motionScan(from, to, openLast) {
    const events = [];
    for (let position = 0, type = 0; type < 200; type++) {
      const xml = `<CMSearchDescription><searchID>{${crypto.randomUUID().toUpperCase()}}</searchID><metaId>log.std-cgi.com/Alarm</metaId>`
        + `<timeSpanList><timeSpan><startTime>${from.replace(' ', 'T')}Z</startTime><endTime>${to.replace(' ', 'T')}Z</endTime></timeSpan></timeSpanList>`
        + `<maxResults>50</maxResults><searchResultPostion>${position}</searchResultPostion></CMSearchDescription>`;
      const y = await this.isapi('/ISAPI/ContentMgmt/logSearch', 'POST', xml);
      const items = blocks(y, 'searchMatchItem');
      for (const o of items) {
        const m = MOTION_EVENT.exec(get(o, 'metaId')), t = get(o, 'StartDateTime').slice(0, 19).replace('T', ' ');
        if (m && t) events.push({ channel: Number(m[2]), begin: m[1] === 'Start', t });
      }
      if (!items.length || get(y, 'responseStatusStrg') !== 'MORE') break;
      position += items.length;
    }
    return hikMotionMatch(events, from, openLast);
  }

  // ---------- RTSP adresleri ----------
  livePath(channel, type) { return `Streaming/Channels/${(channel + 1) * 100 + (type === 'Extra1' || type === 'Mini' ? 2 : 1)}`; }
  playPath(channel, from, to) { return `Streaming/tracks/${(channel + 1) * 100 + 1}?starttime=${rtspTime(from)}&endtime=${rtspTime(to)}`; }
}
