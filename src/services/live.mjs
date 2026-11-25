/**
 * Canli izleme sayfalari (/<yol>/, bkz. models/live-page.mjs) hizmeti: gecikmesiz izleme. Kamera havuzu tek, sayfalar onu paylasir.
 * Goruntuyu mediamtx verir (ayri konteyner, WebRTC/WHEP); bu hizmet onu yonetir:
 *  - her kanalin alt akis kodegini bir kez olcer (ffprobe);
 *  - mediamtx'e API ile yol yazar: H.264 kanal dogrudan kaynak, digerleri (H.265) izlenirken KAYNAK KALITEDE H.264'e cevrilir
 *    (Chrome WebRTC'de H.265 oynatmiyor). Cihaz parolasi dosyaya yazilmaz, yalniz bellekte ve mediamtx'in belleginde durur;
 *  - her sayfanin ORTAK duzenini sayfa kaydinda tutar (live_pages tablosu; veritabani yedegine girer).
 * mediamtx yeniden baslarsa yollar bir sonraki esitlemede (en gec 1 dk) geri yazilir. CAM_RTC_API bossa kapali.
 *
 * Canli izlemede kayit cihazina YALNIZ mediamtx baglanir: panelin canli akislari (MP4 kopya/H.264, MJPEG, goruntu al, AI)
 * cihaz yerine mediamtx yollarindan okur (relay). Olculen: panel 16 + mediamtx 11 = 27 es zamanli cihaz oturumu, 7 kanal
 * iki yerden; ceviri de iki yerde (panel %300, mediamtx %225 cekirdek). Cihaz oturum sinirina dayaninca kanallar dusup
 * yeniden baglanmada 500 donuyordu (izleyicide donma). Kayitli oynatma ve indirme dogrudan cihazdadir.
 */
import { spawn } from 'node:child_process';
import { KEYFRAME_EXPR, TIMESTAMP_FILTER } from '../drivers/mp4-stream.mjs';

/**
 * Cevirme kaynak kalitede: cozunurluk ve kare hizi oldugu gibi (goruntu kalitesinden odun verilmez).
 * Olcum: alt akis 704x576 25 kare/sn -> %18 cekirdek, 1,04 Mbps. -bf 0: WebRTC.
 * Zaman damgasi ve kare hizi panelin cevirisiyle ayni (bkz. drivers/mp4-stream.mjs): -fps_mode passthrough olmadan kayit
 * cihazinin zaman damgasi ileri sicrayinca ffmpeg boslugu kopya karelerle doldurdu (olculen: ~1 MB/sn, cekirdek dolu),
 * mediamtx "reader is too slow" deyip kareleri atti ve goruntu dondu. Damga kaynaktaki kare araligini korur, gercek saatten en cok 0,5 sn uzaklasir; anahtar
 * kare saniyede bir, onceki zorlanmis kareye gore. settb: ffmpeg 8 suzgec zaman tabanini 1/kare hizi yapiyordu; 1 ms adim
 * yuvarlanip damgalar cakisti ("non monotonically increasing dts"). mediamtx komutu kabuk gibi boler: suzgec cift tirnak icinde.
 */
export const LIVE_TRANSCODE = `-vf "settb=1/90000,${TIMESTAMP_FILTER}" -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 1000k -maxrate 1000k -bufsize 2000k -force_key_frames "${KEYFRAME_EXPR}" -bf 0 -fps_mode passthrough`;

/** Kayitli duzen ve CAM_LIVE_DEFAULT yokken gosterilecek kamera sayisi (ilk N kamera). */
export const LIVE_FIRST_COUNT = 12;
export const LIVE_COLUMNS = [1, 2, 3, 4, 5, 6];

/**
 * Kanal listesi + kodekler -> mediamtx yollari (test/live.test.mjs). Her kanala ana akis yolu kN_main (yalniz okunurken
 * cihaza baglanir). Kodegi henuz olculmemis kanal yalniz kaynak yolunu (kN_source) alir: olcum de cihaza degil mediamtx'e gider.
 */
export function livePaths(list, codec) {
  const y = {};
  for (const x of list) {
    const kd = codec.get(x.k);
    const source = { source: x.url, rtspTransport: 'tcp', sourceOnDemand: true };
    if (x.main) y[`k${x.k}_main`] = { source: x.main, rtspTransport: 'tcp', sourceOnDemand: true };
    if (!kd) y[`k${x.k}_source`] = source;
    else if (kd === 'h264') y[`k${x.k}`] = source;
    else {
      y[`k${x.k}_source`] = source;
      y[`k${x.k}`] = { source: 'publisher', runOnDemand: `ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/k${x.k}_source -an ${LIVE_TRANSCODE} -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/k${x.k}`, runOnDemandRestart: true };
    }
  }
  return y;
}

/**
 * Donmus kaynaklar (test/live.test.mjs). Bazi kayit cihazlari akisin ortasinda SSRC degistirir; mediamtx yeni paketleri
 * atar ama yolu "hazir" tutar: goruntu donar, izleyici ve cevirici sonsuza dek bekler, kaynak hic kapanmaz.
 * received: onceki esitlemedeki { yol -> alinan bayt }; items: /v3/paths/list. Iki esitleme boyunca hazir kalip tek
 * bayt almayan, panelin yazdigi cihaz kaynagi donmus sayilir. { frozen: [yol], received: yeni olcum } doner.
 */
export function frozenPaths(received, items, requested) {
  const now = new Map();
  for (const p of items) if (p.ready && p.source?.type === 'rtspSource' && p.name in requested) now.set(p.name, p.bytesReceived);
  const frozen = [...now.keys()].filter((name) => received.get(name) === now.get(name));
  for (const name of frozen) now.delete(name);
  return { frozen, received: now };
}

/** Cevirici cikisi bunun ustundeyse kopya kare yigini sayilir (B/sn). Normal: 1000 kbit ~ 125 KB/sn; kilitlenen ~1,2 MB/sn. */
export const CONVERTER_FLOOD = 500 * 1024;
/**
 * WHEP bekleme suresi (panel -> mediamtx). Kayit cihazi bir kanali dusurunce (olculen: k22/k17/k27, 34 dk'da 18 kez) yol
 * hazir degilken gelen izleme istegi, mediamtx cevirici yeniden ayaga kalkana dek bekler. Eskiden 10 sn'de kesiliyordu:
 * izleyici "zaman asimi" goruyor, bekleyen kalmayinca mediamtx ceviriciyi "not needed by anyone" diye durdurup sonraki
 * denemede bastan baslatiyordu (kesinti 8 sn yerine ~24 sn). mediamtx'in acilis suresinden (runOnDemandStartTimeout
 * 20 sn, sourceOnDemandStartTimeout 15 sn; docker/mediamtx.yml) uzun olmali; tarayicinin beklemesi bundan da uzundur.
 */
export const WHEP_TIMEOUT = 25_000;

/**
 * Takilan ceviriciler (test/live.test.mjs). Cevirici (runOnDemand ffmpeg) olmeden kilitlenebiliyor: kaynagi okumayi
 * birakip kopya kare basiyordu (TERAS, GUVENLIK: ~1,2 MB/sn, %95 cekirdek). Tarayiciya kare geldigi, cihaz kaynagina da
 * bayt geldigi icin ne tarayicinin bekcisi ne frozenPaths bunu goruyordu; elle yeniden baslatildi.
 * Takili sayilir: ayni yayin oturumunda cikis iki esitleme arasinda ortalama CONVERTER_FLOOD'u asarsa, ya da iki
 * esitleme ust uste kaynak yolunu okuyan kimse yoksa. prev: onceki { yol -> { session, bytes, time, strikes } }.
 * local: mediamtx'in kendi icinden (127.0.0.1) gelen RTSP oturumlarinin kimlikleri; verilirse kaynak yolunun okuyucusu
 * yalniz bunlardan sayilir (panel de kaynak yolunu okur; onu sayarsak okumayan cevirici gorunmez).
 * { stuck: [{ name, session, reason }], state } doner; takilan yol state'e girmez (yeni oturum sifirdan olculur).
 */
export function stuckConverters(prev, items, requested, now = Date.now(), local = null) {
  const by = new Map(items.map((p) => [p.name, p]));
  const state = new Map(); const stuck = [];
  for (const [name, setting] of Object.entries(requested)) {
    if (setting.source !== 'publisher') continue;
    const p = by.get(name);
    if (!p?.ready || p.source?.type !== 'rtspSession' || !p.source.id) continue;
    const o = prev.get(name); const same = o?.session === p.source.id;
    const rate = same && now > o.time ? (p.bytesReceived - o.bytes) / ((now - o.time) / 1000) : 0;
    const readers = (by.get(`${name}_source`)?.readers ?? []).filter((r) => !local || local.has(r.id));
    const strikes = readers.length ? 0 : (same ? o.strikes : 0) + 1;
    if (rate > CONVERTER_FLOOD) stuck.push({ name, session: p.source.id, reason: `cikis ${Math.round(rate / 1024)} KB/sn (kopya kare)` });
    else if (strikes >= 2) stuck.push({ name, session: p.source.id, reason: 'kaynagi okumuyor' });
    else state.set(name, { session: p.source.id, bytes: p.bytesReceived, time: now, strikes });
  }
  return { stuck, state };
}

/**
 * mediamtx'in su an kayit cihazina acik oturumlari, cihaz basina (test/live.test.mjs). items: /v3/paths/list; hazir ve kaynagi
 * cihaz (rtspSource) olan yol bir oturumdur (kN, kN_source, kN_main; cevirici yayini kN rtspSession, sayilmaz).
 * deviceOf(k): global kanalin cihaz kimligi. Panelin akis butcesi (base.mjs budgetVar) bunu ekler: canli izleme cihaza
 * yalniz mediamtx'ten baglaninca kayitli oynatma/indirme siniri ancak boyle cihazin gercek yukunu gorur.
 */
export function deviceSources(items, deviceOf) {
  const n = new Map();
  for (const p of items) {
    const m = /^k(\d+)(_source|_main)?$/.exec(p.name ?? '');
    if (!m || !p.ready || p.source?.type !== 'rtspSource') continue;
    const id = deviceOf(Number(m[1]));
    if (id != null) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return n;
}

/** Panelin yonlendirilmis yayini takilinca kaynak yolu en cok bu araliklarla yeniden kurulur (yol basina, ms). */
export const STALL_INTERVAL = 20_000;

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
  /** livePages: LivePageStore (sayfa kayitlari ve duzenleri). */
  constructor({ config, devices, livePages }) {
    this.y = config.live; this.devices = devices; this.livePages = livePages;
    this.codec = new Map(); this.written = new Map(); this.received = new Map(); this.converters = new Map(); this.cameras = []; this.last = null;
    this.healthy = false; this.stalls = new Map(); this.sources = new Map();
    this.ffprobe = (devices.ffmpeg ?? 'ffmpeg').replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    // mediamtx RTSP adresi (panel canli akislari buradan okur): verilmezse yonetim adresinin konagi, 8554.
    this.rtsp = (this.y.rtcRtsp || (this.y.rtcApi ? this.y.rtcApi.replace(/^https?:/, 'rtsp:').replace(/:\d+$/, ':8554') : '')).replace(/\/+$/, '');
  }
  get open() { return !!this.y.rtcApi; }
  /** mediamtx'in bu cihaza acik oturum sayisi (son esitlemede; en cok ~60 sn eski). */
  deviceSessions(id) { return this.sources.get(id) ?? 0; }

  /**
   * Panelin canli akisi icin mediamtx kaynagi (grup cagirir; k: global kanal, type: Main | Extra1 | Mini).
   * { copy, h264, stall } ya da null (null: cihaza dogrudan, eskisi gibi). copy: kameranin kendi videosu; h264: mediamtx'in
   * cevirdigi H.264 (Extra1; H.264 kanalda copy ile ayni), Main icin null (panel kopyadan cevirir; Main'in WebRTC izleyicisi yok).
   * null: /live kapali, son esitleme basarisiz (mediamtx'e ulasilamiyor), yol yazilmamis ya da Extra1 kodegi olculmemis.
   */
  relay(k, type) {
    if (!this.open || !this.healthy || !this.rtsp) return null;
    const url = (name) => `${this.rtsp}/${name}`;
    const stall = () => this.stall(k, type);
    if (type === 'Main') return this.written.has(`k${k}_main`) ? { copy: url(`k${k}_main`), h264: null, stall } : null;
    const kd = this.codec.get(k);
    if (!kd || !this.written.has(`k${k}`)) return null;
    const copy = kd === 'h264' ? `k${k}` : `k${k}_source`;
    return this.written.has(copy) ? { copy: url(copy), h264: url(`k${k}`), stall } : null;
  }

  /**
   * Yonlendirilmis yayin goruntu vermedi ya da veri kesildi: cihaza giden kaynak yolu hemen silinip yeniden eklenir (mediamtx
   * cihaza yeni oturum acar; cevirici de dusup yeniden kalkar). Donmus yolu esitleme ancak 1-2 dk'da yakaliyordu.
   * Yol basina STALL_INTERVAL'de bir; cihaza dogrudan donulmez (oturum sinirini yeniden asmamak icin).
   */
  async stall(k, type, now = Date.now()) {
    const name = type === 'Main' ? `k${k}_main` : this.codec.get(k) === 'h264' ? `k${k}` : `k${k}_source`;
    const j = this.written.get(name);
    if (!j || now - (this.stalls.get(name) ?? 0) < STALL_INTERVAL) return false;
    this.stalls.set(name, now);
    try {
      await this.#api('DELETE', `/v3/config/paths/delete/${name}`);
      await this.#api('POST', `/v3/config/paths/add/${name}`, JSON.parse(j));
      console.log(`live: ${name} panel akisi takildi, kaynak yeniden baglandi`);
      return true;
    } catch (e) { console.error(`live: ${name} yeniden baglanamadi:`, e.message); return false; }
  }

  /** ilk: ilk esitlemenin sozu (testler bekler). */
  start() { if (this.open && !this.first) this.first = this.#loop(); }
  close() { clearTimeout(this.time); this.time = null; this.closed = true; }
  async #loop() {
    try { const r = await this.sync(); if (JSON.stringify(r) !== JSON.stringify(this.last)) console.log(`live: ${r.ready}/${r.channel} kanal mediamtx'te`); this.last = r; }
    catch (e) { this.healthy = false; this.sources = new Map(); console.error('live esitleme:', e.message); }
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
        list.push({ k, name: b.channelNames?.[k] ?? `Kamera ${k + 1}`, device: c.setting.name ?? '', url: c.rtspUrl(c.livePath(i, 'Extra1')), main: c.rtspUrl(c.livePath(i, 'Main')) });
      }
    }
    // Olculmemis kanallar once kaynak yoluyla yazilir; ffprobe cihaza degil mediamtx'e (kN_source) baglanir.
    const toMeasure = list.filter((x) => !this.codec.has(x.k));
    if (toMeasure.length) {
      await this.#write(livePaths(list, this.codec));
      await Promise.all(Array.from({ length: 4 }, async () => { while (toMeasure.length) { const x = toMeasure.shift(); const kd = await codecMeasure(this.ffprobe, `${this.rtsp}/k${x.k}_source`); if (kd) this.codec.set(x.k, kd); } }));
    }
    const requested = livePaths(list, this.codec);
    await this.#write(requested);
    await this.#revive(requested);
    const ready = list.filter((x) => this.codec.has(x.k));
    this.cameras = ready.map((x) => ({ path: `k${x.k}`, name: x.name, device: x.device, converted: this.codec.get(x.k) !== 'h264' }));
    this.healthy = true;
    const moved = this.devices.group?.toRelay?.() ?? 0;   // yol hazir olmadan cihaza dogrudan acilmis yayinlar mediamtx'e gecer
    if (moved) console.log(`live: cihaza dogrudan acik ${moved} canli yayin kapatildi (mediamtx'ten yeniden acilir)`);
    return { channel: list.length, ready: ready.length };
  }

  /** Istenen yollari mediamtx'e yazar, fazlasini siler. mediamtx'te olmayan yol (yeniden basladi) written'dan da duser. */
  async #write(requested) {
    const existing = new Set(((await this.#api('GET', '/v3/config/paths/list?itemsPerPage=10000'))?.items ?? []).map((p) => p.name));
    for (const name of this.written.keys()) if (!existing.has(name)) this.written.delete(name);
    for (const [name, setting] of Object.entries(requested)) {
      const j = JSON.stringify(setting);
      if (existing.has(name) && this.written.get(name) === j) continue;   // degismeyen yol yeniden yazilmaz: acik izleyici dusmesin
      await this.#api('POST', `/v3/config/paths/${existing.has(name) ? 'replace' : 'add'}/${name}`, setting);
      this.written.set(name, j);
    }
    for (const name of existing) if (!(name in requested)) { await this.#api('DELETE', `/v3/config/paths/delete/${name}`); this.written.delete(name); }
  }

  /**
   * Donmus kaynagi (bkz. frozenPaths) silip ayni ayarla yeniden ekler; mediamtx cihaza yeni oturumla baglanir, cevirici de
   * dusup yeniden kalkar. Takilan ceviricinin (bkz. stuckConverters) yayin oturumu atilir: ffmpeg yazamayinca kapanir,
   * mediamtx onu yeniden baslatir (runOnDemandRestart); izleyicinin oynaticisi yeniden baglanir.
   */
  async #revive(requested) {
    const items = (await this.#api('GET', '/v3/paths/list?itemsPerPage=10000'))?.items ?? [];
    this.sources = deviceSources(items, (k) => this.devices.group?.deviceIdOf?.(k) ?? null);
    // Kaynak yolunun okuyucusu yalniz mediamtx'in kendi cevirici ffmpeg'i sayilir (panel de okur, bkz. stuckConverters).
    const sessions = (await this.#api('GET', '/v3/rtspsessions/list?itemsPerPage=10000'))?.items ?? [];
    const local = new Set(sessions.filter((x) => /^(127\.0\.0\.1|\[::1\]|::1)(:|$)/.test(String(x.remoteAddr ?? ''))).map((x) => x.id));
    const r = frozenPaths(this.received, items, requested);
    for (const name of r.frozen) {
      await this.#api('DELETE', `/v3/config/paths/delete/${name}`);
      await this.#api('POST', `/v3/config/paths/add/${name}`, requested[name]);
      console.log(`live: ${name} akisi donmustu, yeniden baglandi`);
    }
    this.received = r.received;
    const c = stuckConverters(this.converters, items, requested, Date.now(), local);
    for (const x of c.stuck) {
      try { await this.#api('POST', `/v3/rtspsessions/kick/${x.session}`); console.log(`live: ${x.name} cevirici takildi (${x.reason}), yeniden baslatildi`); }
      catch (e) { console.error(`live: ${x.name} cevirici yeniden baslatilamadi:`, e.message); }
    }
    this.converters = c.state;
  }

  /**
   * Izleme (WHEP): tarayicinin SDP teklifini mediamtx'e iletir, cevabi dondurur. Yalniz panelin listeledigi yollar
   * (cihaz yolu ya da cevirici kaynagi degil) ve allowed'daki yollar (denetleyici: sayfanin duzeni ya da editore tumu);
   * mediamtx'in geri kalani disariya acilmaz. { durum, sdp } doner.
   */
  async whep(path, offer, allowed) {
    if (!allowed?.includes(path) || !this.cameras.some((k) => k.path === path)) return { status: 404, sdp: '' };
    const r = await fetch(`${this.y.rtcWhep}/${encodeURIComponent(path)}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, signal: AbortSignal.timeout(WHEP_TIMEOUT) });
    return { status: r.status, sdp: await r.text() };
  }

  // ---- sayfanin ortak duzeni
  layoutOf(page) {
    if (page?.layout && Array.isArray(page.layout.paths)) return page.layout;
    // Kayitli duzen yoksa: CAM_LIVE_DEFAULT sirasi (listede olmayan atlanir), o da bossa ilk LIVE_FIRST_COUNT kamera.
    const order = this.y.defaultOrder ?? [];
    const paths = order.length ? order.filter((y) => !this.cameras.length || this.cameras.some((k) => k.path === y)) : this.cameras.slice(0, LIVE_FIRST_COUNT).map((k) => k.path);
    return { column: 4, paths, isDefault: true };
  }
  /** g: { sutun, yollar }. Gecersizse hata. */
  async writeLayout(page, g, savedBy) {
    const paths = Array.isArray(g?.paths) ? [...new Set(g.paths)] : null;
    if (!paths || paths.length > 64 || !paths.every((y) => this.cameras.some((k) => k.path === y)) || !LIVE_COLUMNS.includes(g.column)) throw new Error('Geçersiz düzen');
    const d = { column: g.column, paths, savedBy, time: new Date().toISOString() };
    await this.livePages.writeLayout(page.id, d);   // yazim hatasi DatabaseError (depo gunluge yazar ve bellegi geri alir)
    return d;
  }
}
