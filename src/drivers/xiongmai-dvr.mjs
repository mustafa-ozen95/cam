/**
 * DVR/NVR yoneticisi: kalici denetim oturumu (giris + canli tutma + yeniden baglanma), canli yayin dagitici
 * (kanal basina tek ffmpeg, cok izleyici), kayit sorgusu, kayitli oynatma (fMP4), kayit indirme (mp4).
 * Cihazin TCP baglanti siniri 10: izleyiciler yayini paylasir, her yayin yalniz 1 ek baglanti (claim) acar.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, FrameSplitter } from './xiongmai-dvrip.mjs';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export class Dvr {
  constructor({ setting, ffmpeg, dataDir }) {
    this.setting = setting; this.ffmpeg = ffmpeg;
    this.audit = null; this.loginPromise = null; this.lock = Promise.resolve();
    this.feeds = new Map(); this.downloadCounter = 0;
    this.channelNames = null; this.lastError = null;
    this.playCounter = 0;
    this.playMax = Number(process.env.CAM_PLAYBACK_MAX ?? 4);                  // ayni anda cihazdan en fazla bu kadar kayit oynatma
    this.downloadMax = Number(process.env.CAM_DOWNLOAD_MAX ?? 2);                  // ayni anda cihazdan en fazla bu kadar kayit indirme (digerleri sirada bekler)
    this.event = null;   // saat yalniz elle (Esitle dugmesi) ayarlanir
  }

  /** Goruntu orani [en, boy] ya da null (kaynak oranini koru). ayar.oran: "16:9" | "4:3" | "kaynak"; CAM_RATIO ile de verilir. */
  get ratio() {
    const o = String(process.env.CAM_RATIO ?? this.setting.ratio ?? '16:9');
    const m = /^(\d+):(\d+)$/.exec(o);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** ffmpeg olcek suzgeci: genislik w, oran duzeltilmis yukseklik. */
  scale(w) { const o = this.ratio; return o ? `scale=${w}:${Math.max(2, Math.round((w * o[1]) / o[0] / 2) * 2)}` : `scale='min(${w},iw)':-2`; }

  // ---------- cihaz saati ----------
  static localTime(d = new Date()) { return d.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }); }
  async clockDifference() {
    const dvr = await this.req(1452, 'OPTimeQuery').then((y) => y.OPTimeQuery);
    const server = Dvr.localTime();
    return { dvr, server, diff: Math.round((Date.parse(dvr.replace(' ', 'T') + 'Z') - Date.parse(server.replace(' ', 'T') + 'Z')) / 1000) };
  }
  /** Cihaz saatini sunucu saatine (Europe/Istanbul) esitler. fark: cihaz - sunucu (sn). */
  async syncClock() {
    const before = await this.clockDifference();
    const y = await this.req(1450, 'OPTimeSetting', Dvr.localTime(), 10_000);
    if (y.Ret !== 100) throw new Error(`Cihaz saati ayarlamadı (Ret ${y.Ret})`);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await this.clockDifference();
    return { before: before.dvr, previousDiff: before.diff, after: after.dvr, server: after.server, lastDiff: after.diff };
  }

  /** Cihaz TCP baglanti butcesi (10): denetim 1 + canli yayin basina 1 + oynatma/indirme basina 2 (ayri oturum + veri soketi). */
  budgetVar() { return 1 + this.feeds.size + 2 * (this.playCounter + this.downloadCounter) + 2 <= 10; }
  canPlay() { return this.playCounter < this.playMax && this.budgetVar(); }
  canDownload() { return this.downloadCounter < this.downloadMax && this.budgetVar(); }

  // ---------- denetim oturumu ----------
  async session() {
    if (this.audit && !this.audit.closed) return this.audit;
    this.loginPromise ??= (async () => {
      try {
        const b = new Connection(this.setting.host, this.setting.port);
        await b.connect();
        await b.login(this.setting.username, this.setting.password);
        b.shutdownListener = () => { clearInterval(b.live); if (this.audit === b) this.audit = null; };
        b.live = setInterval(() => { if (!b.closed) b.send(1006, { Name: 'KeepAlive', SessionID: b.sessionIdentity }); }, 10_000);
        b.dataListener = (m) => m === 1007;
        this.audit = b; this.lastError = null;
        return b;
      } catch (e) { this.lastError = e.message; throw e; } finally { this.loginPromise = null; }
    })();
    return this.loginPromise;
  }

  /** Denetim isteklerini sirayla yurutur (ayni mesaj numarasi cakismasin). */
  req(msg, name, inner, timeOverflow) {
    const run = async () => {
      const b = await this.session();
      const body = { Name: name, SessionID: b.sessionIdentity };
      if (inner !== undefined) body[name] = inner;
      return b.req(msg, body, timeOverflow);
    };
    const s = this.lock.then(run, run);
    this.lock = s.catch(() => {});
    return s;
  }

  async getSetting(name) {
    const y = await this.req(1042, name);
    if (y.Ret !== 100) throw new Error(`${name}: Ret ${y.Ret}`);
    return y[name];
  }

  async info() {
    const [sysInfo, disk, clock] = await Promise.all([
      this.req(1020, 'SystemInfo').then((y) => y.SystemInfo),
      this.req(1020, 'StorageInfo').then((y) => y.StorageInfo).catch(() => null),
      this.req(1452, 'OPTimeQuery').then((y) => y.OPTimeQuery).catch(() => null),
    ]);
    const channel = sysInfo.VideoInChannel ?? this.setting.channelCount;
    this.channelNames ??= await this.getSetting('AVEnc.VideoWidget').then((v) => v.map((k) => k?.ChannelTitle?.Name)).catch(() => []);
    let total = 0, empty = 0;
    for (const p of disk ?? []) for (const x of p.Partition ?? []) { total += parseInt(x.TotalSpace, 16) || 0; empty += parseInt(x.RemainSpace, 16) || 0; }
    const channelEmpty = await this.channelEmptyStatus(channel);
    const disks = [];
    for (const [pi, p] of (disk ?? []).entries()) for (const [xi, x] of (p.Partition ?? []).entries()) {
      const tp = parseInt(x.TotalSpace, 16) || 0; if (!tp) continue;
      const valid = (z) => (z && !z.startsWith('0000') && !z.startsWith('2000') ? z : null);
      disks.push({ name: `Disk ${pi + 1}${(p.Partition ?? []).filter((y) => parseInt(y.TotalSpace, 16)).length > 1 ? `.${xi + 1}` : ''}`, manufacturer: '', totalMB: tp, freeMB: parseInt(x.RemainSpace, 16) || 0, temperature: null,
        status: x.Status === 0 ? 'good' : 'error', statusText: x.Status === 0 ? 'Normal' : `Durum kodu ${x.Status}`, recordStart: valid(x.NewStartTime), recordEnd: valid(x.NewEndTime), existing: !!x.IsCurrent });
    }
    return {
      disks,
      channelEmpty,
      serverClock: Dvr.localTime(),
      host: this.setting.host, model: sysInfo.HardWare, version: sysInfo.SoftWareVersion, serialNo: sysInfo.SerialNo, build: sysInfo.BuildTime,
      uptimeSec: (parseInt(sysInfo.DeviceRunTime, 16) || 0) * 1, clock, channel,
      channelNames: Array.from({ length: channel }, (_, i) => this.channelNames[i] || `Kanal ${i + 1}`),
      diskMB: { total, empty },
    };
  }

  // ---------- bos (kamera takili olmayan) kanal tespiti ----------
  /** Dondurur: kanal basina true = bos. ayar.hiddenChannels (0 tabanli) kesin gizler; ayar.hideAuto=false tespiti kapatir. */
  async channelEmptyStatus(channel) {
    const force = new Set(this.setting.hiddenChannels ?? []);
    const from = (k) => force.has(k);
    if (this.setting.hideAuto === false) return Array.from({ length: channel }, (_, k) => from(k));
    const now = Date.now();
    if (this.emptyCache && now - this.emptyCache.z < 5 * 60_000 && this.emptyCache.n === channel) return this.emptyCache.list.map((b, k) => b || from(k));
    const compute = async () => {
      // Her kanal: 'empty' (siyah goruntu), 'live' ya da 'none' (akistan kare alinamadi: bagli kamera yok ya da gecici hata)
      const result = await Promise.all(Array.from({ length: channel }, async (_, k) => {
        if (from(k)) return 'empty';
        this.liveSeen ??= new Set();
        if (this.liveSeen.has(k)) return 'live';   // bir kez goruntu verdi: asla gizleme (gece/karanlik sahne yaniltmasin)
        try {
          // Alt akisin ilk karesi bozuk gelebiliyor: ana akistan iki ayri kare (1.5 sn arayla), ikisi de siyahsa bos
          const [x, y] = await this.twoFrame(k);
          const [px, py] = [await this.brightness(x), await this.brightness(y)];
          if (px >= 6 || py >= 6) { this.liveSeen.add(k); return 'live'; }
          return 'empty';
        } catch { return 'none'; }
      }));
      // Bazi ffmpeg surumleri bos kanaldan hic kare uretmez: baska kanallar goruntu veriyorsa, kare vermeyen ve hic goruntu gormemis kanal bostur.
      const oneLive = result.includes('live');
      const list = result.map((r, k) => r === 'empty' || (r === 'none' && oneLive && !this.liveSeen.has(k)));
      this.emptyCache = { z: Date.now(), n: channel, list };
      return list;
    };
    // Ilk seferde bekle (arayuz bos kanali hic cizmesin); sonra arka planda tazele, eski sonucu dondur.
    if (!this.emptyCache || this.emptyCache.n !== channel) return compute();
    this.pendingCompute ??= compute().finally(() => { this.pendingCompute = null; });
    return this.emptyCache.list.map((b, k) => b || from(k));
  }

  /** Ana akistan iki kare: ilk kare + 1.5 sn sonraki. */
  async twoFrame(channel) {
    const y = this.feed(channel, 'Main', 320);
    try {
      const a = await y.firstFrame();
      if (!a) throw new Error('kare yok');
      await new Promise((r) => setTimeout(r, 1500));
      return [a, y.last ?? a];
    } finally { if (!y.subscribers.size) { clearTimeout(y.idleTimer); y.idleTimer = setTimeout(() => y.stop(), 1500); } }
  }

  /** Bir kanaldan tek kare (JPEG) alir ve akisi hemen birakir. */
  async instantFrame(channel, type, width) {
    const y = this.feed(channel, type, width);
    try { return await y.firstFrame(); } finally { if (!y.subscribers.size) { clearTimeout(y.idleTimer); y.idleTimer = setTimeout(() => y.stop(), 1500); } }
  }

  /** JPEG'in ortalama parlakligi (0-255): ffmpeg signalstats YAVG. */
  brightness(jpeg) {
    return new Promise((resolve, red) => {
      const ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      ff.on('error', red);          // baslatilamazsa dinleyicisiz 'error' paneli dusurur
      let output = '';
      ff.stdout.on('data', (b) => (output += b));
      ff.stdin.on('error', () => {});
      ff.on('close', () => { const m = /YAVG=([\d.]+)/.exec(output); m ? resolve(Number(m[1])) : red(new Error('parlaklik okunamadi')); });
      ff.stdin.end(jpeg);
    });
  }

  // ---------- kayit sorgusu ----------
  async records(channel, from, to) {
    const result = new Map();
    let b = from;
    for (let type = 0; type < 40; type++) {
      const y = await this.req(1440, 'OPFileQuery', { BeginTime: b, EndTime: to, Channel: channel, DriveNo: '0', Event: '*', StreamType: '0x00000000', Type: 'h264' }, 15_000);
      const list = Array.isArray(y.OPFileQuery) ? y.OPFileQuery : [];
      for (const f of list) result.set(f.FileName, f);
      if (list.length < 64) break;
      const last = list[list.length - 1].EndTime;
      if (!last || last <= b) break;
      b = last;
    }
    return [...result.values()].map((f) => ({
      name: f.FileName, from: f.BeginTime, to: f.EndTime, size: (parseInt(f.FileLength, 16) || 0) * 1024,
      type: /\[([RMAH])\]/.exec(f.FileName)?.[1] ?? 'R',
    })).sort((x, y) => x.from.localeCompare(y.from));
  }

  // ---------- akis (claim soketi + baslat) ----------
  /** ic(eylem) -> komut govdesi. Veri paketleri `veri(buf)`'a gider. Dondurur { soket, durdur() }. */
  async openStream({ name, claimMsg, startMsg, inner, dataMsg, data, closed, separateSession = false }) {
    let host, custom = null;
    if (separateSession) {
      custom = new Connection(this.setting.host, this.setting.port);
      await custom.connect();
      try { await custom.login(this.setting.username, this.setting.password); } catch (e) { custom.close(); throw e; }
      custom.dataListener = (m) => m === 1007;
      custom.live = setInterval(() => { if (!custom.closed) custom.send(1006, { Name: 'KeepAlive', SessionID: custom.sessionIdentity }); }, 10_000);
      host = custom;
    } else host = await this.session();
    const start = (action, ms) => (custom ? custom.req(startMsg, { Name: name, SessionID: custom.sessionIdentity, [name]: inner(action) }, ms) : this.req(startMsg, name, inner(action), ms));
    const closeCustom = () => { if (custom) { clearInterval(custom.live); setTimeout(() => custom.close(), 150); } };
    const s = new Connection(this.setting.host, this.setting.port);
    await s.connect();
    s.session = host.session;
    let parseClaim;
    const claim = new Promise((resolve, red) => { parseClaim = resolve; setTimeout(() => red(new Error('Akış sahiplenme yanıtı gelmedi')), 6000); });
    s.dataListener = (m, g) => {
      if (dataMsg.includes(m)) { data(g); return true; }
      if (m === claimMsg + 1) { try { parseClaim(JSON.parse(g.toString().replace(/[\0\n]+$/, ''))); } catch { parseClaim({ Ret: -1 }); } }
      return true;
    };
    s.shutdownListener = () => { closed?.(); closeCustom(); };
    try {
      s.send(claimMsg, { Name: name, SessionID: host.sessionIdentity, [name]: inner('Claim') });
      const c = await claim;
      if (c.Ret !== 100) throw new Error(`Akış reddedildi (Ret ${c.Ret}; bağlantı sınırı dolu olabilir)`);
      const y = await start('Start', 8000);
      if (y.Ret !== 100) throw new Error(`Akış başlatılamadı (Ret ${y.Ret})`);
    } catch (e) { s.close(); closeCustom(); throw e; }
    let ended = false;
    return {
      connection: s,
      stop: () => {
        if (ended) return; ended = true;
        start('Stop', 2000).catch(() => {});
        setTimeout(() => s.close(), 100);
        closeCustom();
      },
    };
  }

  watchInner = (channel, type) => (action) => ({ Action: action, Parameter: { Channel: channel, CombinMode: 'NONE', StreamType: type, TransMode: 'TCP' } });
  playInner = (channel, from, to, file) => (action) => ({
    Action: action, StartTime: from, EndTime: to,
    Parameter: { PlayMode: file ? 'ByName' : 'ByTime', FileName: file ?? '', StreamType: 0, Value: 0, TransMode: 'TCP', Channel: channel, Type: 'h264' },
  });

  // ---------- canli yayin (MJPEG, paylasimli) ----------
  feed(channel, type, _width) {
    // Genislik tur basina SABIT (istemci ne isterse): her kanal/tur icin cihaza tek baglanti, tum izleyiciler paylasir.
    const width = type === 'Extra1' ? 480 : 1280;
    const key = `${channel}/${type}/${width}`;
    let y = this.feeds.get(key);
    if (!y) { y = new LiveFeed(this, channel, type, width, () => this.feeds.delete(key)); this.feeds.set(key, y); y.start(); }
    return y;
  }

  // ---------- kayitli oynatma (MJPEG, izleyici basina; tum tarayicilarda calisir) ----------
  playMjpeg(res, channel, from, to, width) {
    if (!this.canPlay()) { try { res.end(); } catch {} return null; }   // cihaz bagli kalmasin: sinir doluysa istemci birazdan yeniden dener
    this.playCounter++;
    res.on('close', () => { this.playCounter = Math.max(0, this.playCounter - 1); });
    // Cihaz ByTime oynatmada kanal parametresini yok sayiyor (hep CAM01): kanal klasorundeki dosya adiyla (ByName) oynatilir.
    const mod = { playback: { channel, from } };
    const y = new LiveFeed(this, channel, 'play', width, () => {}, mod);
    y.start();
    y.subscriber(res);
    // Kayit bitince (cihaz akisi kapatir ya da sessizlesir) yaniti kapat: istemci "kayit sonu" gorur.
    let last = Date.now(), counter = -1;
    const watcher = setInterval(() => {
      if (y.stopped) return clearInterval(watcher);
      if (y.frameCounter !== counter) { counter = y.frameCounter; last = Date.now(); } else if (Date.now() - last > 8000) { clearInterval(watcher); y.stop(); }
    }, 1000);
    res.on('close', () => { clearInterval(watcher); });
    return y;
  }

  // ---------- kayit indirme: cihazdan dogrudan indirenin tarayicisina AKAR; sunucu diskine hicbir sey yazilmaz ----------
  downloadName(channel, record) {
    // Kamera adi + tarih + baslangic-bitis saati: CAM01_2026-01-01_10.00.00-10.01.00.mp4
    const camera = String(this.nameOverrides?.[channel] || this.channelNames?.[channel] || `K${channel + 1}`).replace(/[ıİğĞüÜşŞöÖçÇ]/g, (c) => ({ ı: 'i', İ: 'I', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ş: 's', Ş: 'S', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' })[c]).replace(/\s+/g, '-').replace(/[^\w-]+/g, '') || `K${channel + 1}`;
    return `${camera}_${record.from.slice(0, 10)}_${record.from.slice(11).replaceAll(':', '.')}-${record.to.slice(11).replaceAll(':', '.')}.mp4`;
  }

  /** Kuyrukta sirasini bekler, sonra DownloadStart ile cihazdan cekip parcali mp4 olarak res'e yazar. bitince({ tamam, bayt }) */
  async pipeDownload(res, channel, record, name, onEnd) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    let ff = null, stream = null, closed = false, byte = 0, finished = false, lastZ = Date.now(), taken = 0, counted = false;
    const watcher = setInterval(() => {
      if (!stream || finished) return;
      const muted = Date.now() - lastZ;
      if (taken > 0 && muted > 4000) complete(true);            // dosya sonunda cihaz akisi kapatmaz, yalniz veri kesilir
      else if (muted > 20_000) complete(false);
    }, 1000);
    const count = (art) => { if (art && !counted) { counted = true; this.downloadCounter++; } else if (!art && counted) { counted = false; this.downloadCounter = Math.max(0, this.downloadCounter - 1); } };
    const finish = (ok) => { if (finished) return; finished = true; clearInterval(watcher); count(false); try { stream?.stop(); } catch {} onEnd?.({ ok, byte }); };
    function complete(ok) { if (finished) return; try { stream?.stop(); } catch {} if (ff && ok) { try { ff.stdin.end(); } catch {} } else { try { ff?.kill('SIGKILL'); } catch {} try { res.end(); } catch {} } finish(ok && taken > 0); }
    res.on('close', () => { closed = true; if (!finished) { try { ff?.stdin.destroy(); ff?.kill('SIGKILL'); } catch {} finish(false); } });
    // sira: ayni anda en fazla downloadMax; cihaz baglanti butcesi doluysa bekle
    for (let t = 0; !this.canDownload(); t++) { if (closed || t > 900) { finish(false); try { res.end(); } catch {} return; } await new Promise((r) => setTimeout(r, 1000)); }
    if (closed) return finish(false);
    count(true);
    const splitter = new FrameSplitter((v) => {
      if (finished) return;
      if (!ff) {
        const fps = splitter.info.fps || 25;
        ff = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-framerate', String(fps), '-i', 'pipe:0', ...(this.ratio ? ['-aspect', this.ratio.join(':')] : []),
          '-c:v', 'copy', '-bsf:v', `setts=ts=N/${fps}/TB`, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        ff.on('error', () => complete(false));          // baslatilamazsa dinleyicisiz 'error' paneli dusurur
        ff.stdin.on('error', () => {}); ff.stderr.on('data', () => {});
        ff.stdout.on('data', (b) => { byte += b.length; });
        ff.stdout.pipe(res);
        ff.on('close', () => { try { res.end(); } catch {} if (!finished) finish(taken > 0); });
      }
      if (!ff.stdin.write(v)) { stream?.connection.socket.pause(); ff.stdin.once('drain', () => stream?.connection.socket.resume()); }
    }, null);
    const action = (e) => ({ ...this.playInner(channel, record.from, record.to, record.name)(e), Action: e === 'Start' ? 'DownloadStart' : e === 'Stop' ? 'DownloadStop' : e });
    try {
      stream = await this.openStream({ name: 'OPPlayBack', claimMsg: 1424, startMsg: 1420, inner: action, dataMsg: [1426, 1422], separateSession: true,
        data: (g) => { taken += g.length; lastZ = Date.now(); splitter.add(g); }, closed: () => { if (!finished && taken > 0) complete(true); } });
      if (finished) stream.stop();
    } catch (e) { lastZ = 0; try { res.end(); } catch {} finish(false); throw e; }
  }

  /** DVR diskindeki TUM kayitlari siler (bicimlendirme). Cihaz tek tek dosya silmeyi desteklemez. */
  async diskClear() {
    return this.req(1450, 'OPStorageManager', { Action: 'Clear', PartNo: 0, PlysicalNo: 0, Type: 'Data' }, 60_000);
  }

  close() { for (const y of [...this.feeds.values()]) y.stop(); this.audit?.close(); }
}

class LiveFeed {
  constructor(dvr, channel, type, width, onEnd, mod = null) {
    Object.assign(this, { dvr, channel, type, width, onEnd, mod });
    this.subscribers = new Set(); this.lastZ = Date.now(); this.last = null; this.stopped = false; this.jpegBuffer = Buffer.alloc(0); this.error = null;
  }

  start() {
    this.ready = this.#setup().catch((e) => { this.error = e.message; this.stop(); });
    // Kare akisi 10 sn durursa (kamera/cihaz takildi) yayini kapat: izleyiciler kendiliginden yeniden baglanir.
    this.watcher = setInterval(() => { if (this.last && Date.now() - this.lastZ > 10_000) this.stop(); }, 2000);
  }

  async #setup() {
    const { dvr } = this;
    const splitter = new FrameSplitter((v) => {
      if (this.stopped) return;
      if (!this.ff.stdin.write(v)) { this.stream?.connection.socket.pause(); this.ff.stdin.once('drain', () => this.stream?.connection.socket.resume()); }
    }, null);
    const w = Math.max(160, Math.min(1920, this.width || 640));
    this.ff = spawn(dvr.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0', '-an', '-vf', dvr.scale(w), '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.ff.on('error', () => this.stop());       // baslatilamazsa dinleyicisiz 'error' paneli dusurur
    this.ff.stdin.on('error', () => {}); this.ff.stderr.on('data', () => {});
    this.ff.stdout.on('data', (b) => this.#jpeg(b));
    this.ff.on('close', () => this.stop());
    if (this.mod?.playback) { this.splitter = splitter; await this.#playSetup(); }
    else {
      this.stream = await dvr.openStream({ name: 'OPMonitor', claimMsg: 1413, startMsg: 1410, inner: dvr.watchInner(this.channel, this.type), dataMsg: [1412], data: (g) => splitter.add(g), closed: () => this.stop() });
      if (this.stopped) { this.stream.stop(); return; }
    }
    const t0 = Date.now();
    while (!this.last && !this.stopped) {
      if (Date.now() - t0 > 8000) throw new Error('Kameradan görüntü gelmedi');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Kayitli oynatma: hedef andan baslayarak kanalin dosyalarini sirayla (ByName + dosya ici baslangic zamani) oynatir. */
  async #playSetup() {
    const { dvr } = this; const { channel, from } = this.mod.playback;
    const day = from.slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    this.files = (await dvr.records(channel, `${day} 00:00:00`, `${next} 23:59:59`)).filter((f) => f.to > from);
    if (!this.files.length) throw new Error('Bu anda kayıt yok');
    this.order = 0; this.target = from; this.token = 0; this.taken = 0; this.lastDataZ = Date.now();
    await this.#playFile();
    // dosya sonunda cihaz akisi kapatmaz, yalniz veri kesilir: 4 sn sessizlikte siradaki dosyaya gec
    this.fileWatcher = setInterval(() => { if (this.stream && this.taken > 0 && Date.now() - this.lastDataZ > 4000) this.#playFile().catch(() => this.stop()); }, 1000);
  }
  async #playFile() {
    if (this.transition || this.stopped) return;
    this.transition = true;
    try {
      const token = ++this.token;
      this.stream?.stop(); this.stream = null;
      const f = this.files[this.order++];
      if (!f) { this.stop(); return; }
      const startIndex = f.from > this.target ? f.from : this.target;
      this.taken = 0; this.lastDataZ = Date.now();
      this.stream = await this.dvr.openStream({
        name: 'OPPlayBack', claimMsg: 1424, startMsg: 1420, inner: this.dvr.playInner(this.channel, startIndex, f.to, f.name), dataMsg: [1422, 1426], separateSession: true,
        data: (g) => { this.taken += g.length; this.lastDataZ = Date.now(); this.splitter.add(g); },
        closed: () => { if (token === this.token && !this.transition) this.#playFile().catch(() => this.stop()); },
      });
      if (this.stopped) this.stream.stop();
    } finally { this.transition = false; }
  }

  // ham=true: fetch okuyucusu icin yalniz ardisik JPEG baytlari (WebKit fetch'te multipart/x-mixed-replace'i reddeder)
  #part(frame, r) { return r.raw ? [frame] : [`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`, frame, '\r\n']; }

  #jpeg(b) {
    this.jpegBuffer = this.jpegBuffer.length ? Buffer.concat([this.jpegBuffer, b]) : b;
    for (;;) {
      const from = this.jpegBuffer.indexOf(JPEG_START);
      if (from < 0) { this.jpegBuffer = Buffer.alloc(0); return; }
      const last = this.jpegBuffer.indexOf(JPEG_END, from + 2);
      if (last < 0) { this.jpegBuffer = this.jpegBuffer.subarray(from); return; }
      const frame = Buffer.from(this.jpegBuffer.subarray(from, last + 2));
      this.jpegBuffer = this.jpegBuffer.subarray(last + 2);
      this.last = frame; this.lastZ = Date.now(); this.frameCounter = (this.frameCounter ?? 0) + 1;
      for (const r of this.subscribers) {
        if (r.writableNeedDrain) continue;
        for (const p of this.#part(frame, r)) r.write(p);
      }
    }
  }

  subscriber(res) {
    this.subscribers.add(res);
    clearTimeout(this.idleTimer);
    if (this.last) for (const p of this.#part(this.last, res)) res.write(p);
    res.on('close', () => {
      this.subscribers.delete(res);
      if (!this.subscribers.size) this.idleTimer = setTimeout(() => this.stop(), this.mod ? 300 : 4000);
    });
  }

  /** Ilk kare gelene dek bekler (anlik goruntu icin). */
  async firstFrame() {
    await this.ready;
    return this.last;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer); clearInterval(this.watcher); clearInterval(this.fileWatcher);
    this.stream?.stop();
    try { this.ff?.stdin.destroy(); this.ff?.kill('SIGKILL'); } catch {}
    for (const r of this.subscribers) { try { r.end(); } catch {} }
    this.subscribers.clear();
    this.onEnd();
  }
}
