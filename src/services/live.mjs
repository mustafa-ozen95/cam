/**
 * Canli izleme sayfasi (/live) hizmeti: uyeliksiz, gecikmesiz izleme.
 * Goruntuyu mediamtx verir (ayri konteyner, WebRTC/WHEP); bu hizmet onu yonetir:
 *  - her kanalin alt akis kodegini bir kez olcer (ffprobe);
 *  - mediamtx'e API ile yol yazar: H.264 kanal dogrudan kaynak, digerleri (H.265) izlenirken KAYNAK KALITEDE H.264'e cevrilir
 *    (Chrome WebRTC'de H.265 oynatmiyor). Cihaz parolasi dosyaya yazilmaz, yalniz bellekte ve mediamtx'in belleginde durur;
 *  - herkesin gordugu ORTAK duzeni tutar (ayarlar tablosu, "live-duzen"; veritabani yedegine girer).
 * mediamtx yeniden baslarsa yollar bir sonraki esitlemede (en gec 1 dk) geri yazilir. CAM_RTC_API bossa kapali.
 */
import { spawn } from 'node:child_process';
import { DatabaseError } from '../core/errors.mjs';

/**
 * Cevirme kaynak kalitede: cozunurluk ve kare hizi oldugu gibi (goruntu kalitesinden odun verilmez).
 * Olcum: alt akis 704x576 25 kare/sn -> %18 cekirdek, 1,04 Mbps. -g 25: yeni izleyici en gec 1 sn'de anahtar kare alir; -bf 0: WebRTC.
 */
export const LIVE_TRANSCODE = '-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 1000k -maxrate 1000k -bufsize 2000k -g 25 -bf 0';

/** Kayitli duzen ve CAM_LIVE_DEFAULT yokken gosterilecek kamera sayisi (ilk N kamera). */
export const LIVE_FIRST_COUNT = 12;
export const LIVE_COLUMNS = [1, 2, 3, 4, 5, 6];

/** Kanal listesi + kodekler -> mediamtx yollari (test/live.test.mjs). */
export function livePaths(list, codec) {
  const y = {};
  for (const x of list) {
    const kd = codec.get(x.k);
    if (!kd) continue;
    const source = { source: x.url, rtspTransport: 'tcp', sourceOnDemand: true };
    if (kd === 'h264') y[`k${x.k}`] = source;
    else {
      y[`k${x.k}_source`] = source;
      y[`k${x.k}`] = { source: 'publisher', runOnDemand: `ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/k${x.k}_source -an ${LIVE_TRANSCODE} -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/k${x.k}`, runOnDemandRestart: true };
    }
  }
  return y;
}

function codecMeasure(ffprobe, url) {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', url], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let c = ''; const z = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (b) => { c += b; });
    p.on('error', () => { clearTimeout(z); resolve(null); });   // dinleyicisiz 'error' paneli dusurur
    p.on('close', () => { clearTimeout(z); resolve(c.trim().split('\n')[0] || null); });
  });
}

export class LiveService {
  /** ayarlar: Ayarlar (veritabani); kayitli duzeni yukle() getirir. */
  constructor({ config, devices, settings }) {
    this.y = config.live; this.devices = devices; this.settings = settings; this.savedLayout = null;
    this.codec = new Map(); this.written = new Map(); this.cameras = []; this.last = null;
    this.ffprobe = (devices.ffmpeg ?? 'ffmpeg').replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  }
  async load() { const d = await this.settings.read('live-layout'); this.savedLayout = d && Array.isArray(d.paths) ? d : null; return this; }
  get open() { return !!this.y.rtcApi; }

  /** ilk: ilk esitlemenin sozu (testler bekler). */
  start() { if (this.open && !this.first) this.first = this.#loop(); }
  close() { clearTimeout(this.time); this.time = null; this.closed = true; }
  async #loop() {
    try { const r = await this.sync(); if (JSON.stringify(r) !== JSON.stringify(this.last)) console.log(`live: ${r.ready}/${r.channel} kanal mediamtx'te`); this.last = r; }
    catch (e) { console.error('live esitleme:', e.message); }
    if (!this.closed) { this.time = setTimeout(() => this.#loop(), 60_000); this.time.unref?.(); }
  }

  async #api(method, path, body) {
    const r = await fetch(this.y.rtcApi + path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`mediamtx ${method} ${path.split('/').slice(0, 5).join('/')}: HTTP ${r.status}`);
    return r.headers.get('content-type')?.includes('json') ? r.json() : null;
  }

  async sync() {
    const b = await this.devices.info();
    const list = [];
    for (const c of this.devices.group.devices) {
      if (typeof c.livePath !== 'function' || typeof c.rtspUrl !== 'function') continue;   // RTSP'siz surucu (Xiongmai, sahte) yok sayilir
      for (let i = 0; i < c.channelCount; i++) {
        const k = c.startIndex + i;
        if (b.channelEmpty?.[k]) continue;
        list.push({ k, name: b.channelNames?.[k] ?? `Kamera ${k + 1}`, device: c.setting.name ?? '', url: c.rtspUrl(c.livePath(i, 'Extra1')) });
      }
    }
    const toMeasure = list.filter((x) => !this.codec.has(x.k));
    await Promise.all(Array.from({ length: 4 }, async () => { while (toMeasure.length) { const x = toMeasure.shift(); const kd = await codecMeasure(this.ffprobe, x.url); if (kd) this.codec.set(x.k, kd); } }));
    const ready = list.filter((x) => this.codec.has(x.k));
    const requested = livePaths(ready, this.codec);
    const existing = new Set(((await this.#api('GET', '/v3/config/paths/list?itemsPerPage=10000'))?.items ?? []).map((p) => p.name));
    for (const [name, setting] of Object.entries(requested)) {
      const j = JSON.stringify(setting);
      if (existing.has(name) && this.written.get(name) === j) continue;   // degismeyen yol yeniden yazilmaz: acik izleyici dusmesin
      await this.#api('POST', `/v3/config/paths/${existing.has(name) ? 'replace' : 'add'}/${name}`, setting);
      this.written.set(name, j);
    }
    for (const name of existing) if (!(name in requested)) { await this.#api('DELETE', `/v3/config/paths/delete/${name}`); this.written.delete(name); }
    this.cameras = ready.map((x) => ({ path: `k${x.k}`, name: x.name, device: x.device, converted: this.codec.get(x.k) !== 'h264' }));
    return { channel: list.length, ready: ready.length };
  }

  /**
   * Izleme (WHEP): tarayicinin SDP teklifini mediamtx'e iletir, cevabi dondurur. Yalniz panelin listeledigi yollar
   * (cihaz yolu ya da cevirici kaynagi degil); mediamtx'in geri kalani disariya acilmaz. { durum, sdp } doner.
   */
  async whep(path, offer) {
    if (!this.cameras.some((k) => k.path === path)) return { status: 404, sdp: '' };
    const r = await fetch(`${this.y.rtcWhep}/${encodeURIComponent(path)}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, signal: AbortSignal.timeout(10_000) });
    return { status: r.status, sdp: await r.text() };
  }

  // ---- ortak duzen
  layout() {
    if (this.savedLayout) return this.savedLayout;
    // Kayitli duzen yoksa: CAM_LIVE_DEFAULT sirasi (listede olmayan atlanir), o da bossa ilk LIVE_FIRST_COUNT kamera.
    const order = this.y.defaultOrder ?? [];
    const paths = order.length ? order.filter((y) => !this.cameras.length || this.cameras.some((k) => k.path === y)) : this.cameras.slice(0, LIVE_FIRST_COUNT).map((k) => k.path);
    return { column: 4, paths, isDefault: true };
  }
  /** g: { sutun, yollar }. Gecersizse hata. */
  async writeLayout(g, savedBy) {
    const paths = Array.isArray(g?.paths) ? [...new Set(g.paths)] : null;
    if (!paths || paths.length > 64 || !paths.every((y) => this.cameras.some((k) => k.path === y)) || !LIVE_COLUMNS.includes(g.column)) throw new Error('Geçersiz düzen');
    const d = { column: g.column, paths, savedBy, time: new Date().toISOString() };
    try { await this.settings.write('live-layout', d); } catch (e) { console.error('live duzeni yazilamadi:', e?.code ?? '', e?.message ?? e); throw new DatabaseError(e); }
    this.savedLayout = d;
    return d;
  }
}
