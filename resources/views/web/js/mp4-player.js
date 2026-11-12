/** Canli MP4 oynatici: panelin izgarasi/odagi ve /live ayni dosyayi kullanir (ayni akis, ayni oynatma). */
/**
 * Parcali MP4 akisindan anahtar kare zamanlari (sn). Tampon yalniz bir anahtar kareye kadar kirpilabilir: MediaSource
 * silinen karelere bagimli kareleri de (sonraki anahtar kareye kadar) siler, oynatma durur. Uniview NVR'da anahtar kare
 * 4-8,4 sn'de bir. Cozumlenemeyen kutuda (64 bit boy) durur; kirpma yapilmaz.
 */
export class Mp4Time {
  constructor() { this.t = new Uint8Array(0); this.skip = 0; this.scale = 0; this.key = []; this.broken = false; }
  add(v) {
    if (this.broken) return;
    if (this.skip) { const n = Math.min(this.skip, v.length); this.skip -= n; v = v.subarray(n); if (!v.length) return; }
    const t = this.t.length ? Mp4Time.merge([this.t, v]) : v;
    let i = 0;
    while (t.length - i >= 8) {
      const n = new DataView(t.buffer, t.byteOffset + i, 8).getUint32(0), type = String.fromCharCode(...t.subarray(i + 4, i + 8));
      if (n < 8) { this.broken = true; return; }
      if (type !== 'moov' && type !== 'moof') { if (t.length - i >= n) { i += n; continue; } this.skip = n - (t.length - i); i = t.length; break; }
      if (t.length - i < n) break;
      const box = new DataView(t.buffer, t.byteOffset + i, n);
      if (type === 'moov') this.#moov(box); else this.#moof(box);
      i += n;
    }
    this.t = t.slice(i);
  }
  /** Kutunun cocuklari arasinda yol (stsd yok, gerek de yok). */
  static find(d, path, from = 8, last = d.byteLength) {
    for (let i = from; i + 8 <= last;) {
      const n = d.getUint32(i), type = String.fromCharCode(d.getUint8(i + 4), d.getUint8(i + 5), d.getUint8(i + 6), d.getUint8(i + 7));
      if (n < 8 || i + n > last) return null;
      if (type === path[0]) return path.length === 1 ? { inner: i + 8, last: i + n } : Mp4Time.find(d, path.slice(1), i + 8, i + n);
      i += n;
    }
    return null;
  }
  #moov(d) {
    const m = Mp4Time.find(d, ['trak', 'mdia', 'mdhd']);
    if (m) this.scale = d.getUint32(m.inner + (d.getUint8(m.inner) === 1 ? 20 : 12));
  }
  #moof(d) {
    const traf = Mp4Time.find(d, ['traf']);
    if (!traf || !this.scale) return;
    let defaultValue = null, first = null, time = null;
    for (let i = traf.inner; i + 8 <= traf.last;) {
      const n = d.getUint32(i), type = String.fromCharCode(d.getUint8(i + 4), d.getUint8(i + 5), d.getUint8(i + 6), d.getUint8(i + 7)), inner = i + 8, flag = d.getUint32(inner) & 0xffffff;
      if (n < 8) return;
      if (type === 'tfdt') time = d.getUint8(inner) === 1 ? Number(d.getBigUint64(inner + 4)) : d.getUint32(inner + 4);
      if (type === 'tfhd' && flag & 0x20) { let p = inner + 8; for (const [to, uz] of [[1, 8], [2, 4], [8, 4], [0x10, 4]]) if (flag & to) p += uz; defaultValue = d.getUint32(p); }
      if (type === 'trun') { const p = inner + 8 + (flag & 1 ? 4 : 0); if (flag & 4) first = d.getUint32(p); else if (flag & 0x400) first = d.getUint32(p + (flag & 0x100 ? 4 : 0) + (flag & 0x200 ? 4 : 0)); }
      i += n;
    }
    const b = first ?? defaultValue;
    if (time !== null && b !== null && !(b & 0x10000)) { this.key.push(time / this.scale); if (this.key.length > 64) this.key.shift(); }
  }
  /** t'den once ya da t'de olan son anahtar kare (yoksa null). */
  cutting(t) { let k = null; for (const a of this.key) if (a <= t) k = a; return k; }
  static merge(parts) { const u = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { u.set(p, i); i += p.length; } return u; }
}
const MSSource = window.ManagedMediaSource ?? window.MediaSource;
/**
 * Canli MP4: kameranin kendi videosu (yeniden kodlamasiz) MediaSource ile oynar; Mjpeg ile ayni arayuz (baslat, durdur, hiz, calisiyor, frameVar).
 * Tarayici kodegi oynatamazsa ya da cihaz MP4 vermiyorsa (501) desteksiz() cagrilir; LiveMp4Player sunucuda cevirmeye gecer, o da olmazsa yeniden dener.
 * Canli kenarda kalir: 0,5 sn geride kalinca hafif hizlanir (1,1x), 1 sn'yi asinca sona atlar. Tampon 30 sn'yi asinca eski kisim
 * bir anahtar kareye kadar silinir. Bekci: veri 6 sn gelmezse ya da veri geldigi halde goruntu 4 sn ilerlemezse yeniden baglanir.
 */
export class Mp4Player {
  constructor(video, { url, status, first, unsupported, stall = 6000 }) {
    Object.assign(this, { video, url, status, first, unsupported, stall });
    this.attempts = 0; this.running = false; this.ctrl = null; this.msUrl = null; this.frameVar = false;
    video.muted = true; video.playsInline = true; video.disableRemotePlayback = true; video.disablePictureInPicture = true;
    video.addEventListener('playing', () => { if (this.running && !this.frameVar) { this.frameVar = true; this.attempts = 0; this.first?.(); } });
    // Kodek "destekleniyor" deyip cozemeyen tarayici: MJPEG'e gec
    video.addEventListener('error', () => { if (this.running && this.ctrl) this.#unsupported(this.ctrl); });
  }
  start(retry = false) {
    this.stop(true);
    if (!retry) this.attempts = 0;
    this.running = true; this.frameVar = false;
    const ctrl = (this.ctrl = new AbortController());
    this.lastZ = this.t0 = this.lastTZ = performance.now(); this.lastT = -1;
    this.measurement = { byte: 0, frame: this.#frameCount(), z: performance.now() }; this.rateLast = null;
    this.watcher = setInterval(() => {
      // Goruntu zamani: arka planda tarayici videoyu kendisi duraklatir, o zaman sayilmaz
      const t = this.video.currentTime;
      if (t !== this.lastT || document.hidden || this.video.paused) { this.lastT = t; this.lastTZ = performance.now(); }
      if (performance.now() - this.lastZ > this.stall) this.#drop(ctrl, 'Görüntü durdu');
      else if (this.frameVar && performance.now() - this.lastTZ > 4000) this.#drop(ctrl, 'Görüntü durdu');   // veri geliyor, goruntu donuk
      else if (!this.frameVar && performance.now() - this.t0 > 20_000) this.#unsupported(ctrl);   // veri geliyor ama kare cizilmiyor
    }, 1500);
    this.#read(ctrl);
  }
  #frameCount() { const q = this.video.getVideoPlaybackQuality?.(); return q ? q.totalVideoFrames : (this.video.webkitDecodedFrameCount ?? 0); }
  async #read(ctrl) {
    this.status?.(this.attempts ? `Yeniden bağlanıyor (${this.attempts})…` : 'Bağlanıyor…');
    let y;
    try { y = await fetch(this.url(), { signal: ctrl.signal, cache: 'no-store' }); }
    catch { if (!ctrl.signal.aborted) this.#drop(ctrl, 'Bağlanamadı'); return; }
    if (y.status === 401) { location.reload(); return; }
    if (y.status === 501) return this.#unsupported(ctrl);
    if (!y.ok) return this.#drop(ctrl, 'Bağlanamadı');
    const codec = y.headers.get('X-Codec'), type = `video/mp4; codecs="${codec}"`;
    if (!codec || !MSSource?.isTypeSupported(type)) return this.#unsupported(ctrl);
    const ms = new MSSource();
    if (this.msUrl) URL.revokeObjectURL(this.msUrl);
    this.msUrl = URL.createObjectURL(ms); this.video.src = this.msUrl;
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    if (ctrl.signal.aborted) return;
    const sb = ms.addSourceBuffer(type), time = new Mp4Time(), queue = [];
    let queueByte = 0;
    const feed = () => {
      if (sb.updating || ctrl.signal.aborted || ms.readyState !== 'open') return;
      const b = sb.buffered, v = this.video;
      if (b.length) {
        const from = b.start(b.length - 1), last = b.end(b.length - 1);
        const lag = last - v.currentTime;
        if (v.currentTime < from || lag > 1) { v.currentTime = Math.max(from, last - 0.2); v.playbackRate = 1; }
        else v.playbackRate = lag > 0.5 ? 1.1 : 1;
        const cut = time.cutting(v.currentTime - 10);
        if (cut !== null && last - b.start(0) > 30 && cut > b.start(0) + 1) { sb.remove(0, cut); return; }
      }
      if (!queue.length) return;
      const p = queue.length === 1 ? queue[0] : Mp4Time.merge(queue);
      queue.length = 0; queueByte = 0;
      try { sb.appendBuffer(p); } catch { this.#drop(ctrl, 'Oynatıcı hatası'); }
    };
    sb.addEventListener('updateend', () => { feed(); if (this.video.paused && !ctrl.signal.aborted) this.video.play().catch(() => {}); });
    try {
      const r = y.body.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done || ctrl.signal.aborted) break;
        this.measurement.byte += value.length; this.lastZ = performance.now();
        time.add(value); queue.push(value); queueByte += value.length;
        if (queueByte > 8e6) return this.#drop(ctrl, 'Oynatıcı yetişemiyor');
        feed();
      }
    } catch { if (!ctrl.signal.aborted) this.#drop(ctrl, 'Bağlantı koptu'); return; }
    if (!ctrl.signal.aborted) this.#drop(ctrl, 'Akış bitti');
  }
  rate() {
    const o = this.measurement, now = performance.now(), sec = (now - (o?.z ?? now)) / 1000;
    if (!o || !this.running) return null;
    if (sec >= 1) { const k = this.#frameCount(); this.rateLast = { bps: (o.byte * 8) / sec, fps: Math.max(0, k - o.frame) / sec }; this.measurement = { byte: 0, frame: k, z: now }; }
    return this.rateLast;
  }
  /** desteksiz() true: baska yola (sunucuda cevirme) gecildi, bastan acilir. false: gececek yol yok; vazgecilmez, yeniden denenir. */
  #unsupported(ctrl) {
    if (ctrl !== this.ctrl || !this.running) return;
    if (this.unsupported?.()) { this.stop(); this.start(); } else this.#drop(ctrl, 'Görüntü açılamadı');
  }
  #drop(ctrl, reason) {
    if (ctrl !== this.ctrl || !this.running) return;
    clearInterval(this.watcher); ctrl.abort();
    this.attempts++;
    this.status?.(`${reason}, yeniden deneniyor (${this.attempts})…`);
    this.retry = setTimeout(() => { if (this.running) this.start(true); }, Math.min(10_000, 1000 * 2 ** Math.min(this.attempts, 4)));
  }
  /** sessiz=true: son kare ekranda kalir (duraklatma). */
  stop(muted = false) {
    clearInterval(this.watcher); clearTimeout(this.retry);
    this.ctrl?.abort(); this.ctrl = null; this.running = false;
    if (muted) { this.video.pause(); return; }
    this.video.removeAttribute('src'); this.video.load();
    if (this.msUrl) { URL.revokeObjectURL(this.msUrl); this.msUrl = null; }
  }
}
/**
 * Canli kamera (MP4): once kameranin kendi videosu (yeniden kodlamasiz). Tarayici kodegi oynatamazsa (Chrome'da H.265) sunucu
 * kaynak kalitede H.264'e cevirir (h264=1). Cevrilen cihaz+akis turu bu sayfada hatirlanir; bir daha kopya denenmez.
 * MJPEG yedegi yok: canli goruntu her tarayicida MP4.
 */
const converted = new Set();
export class LiveMp4Player {
  constructor(video, { url, key, status, first }) {
    this.key = key;
    // Cevrilmis akista da hata olursa gecici sayilir (cevirici yeni basliyor, ag, cozucu hatasi): "oynatamiyor" deyip
    // durmak yerine yeniden denenir.
    this.m = new Mp4Player(video, { url: () => url(this.convert), status, first, unsupported: () => {
      if (this.convert) return false;
      converted.add(this.key()); return true;
    } });
  }
  /** Bu kamera sunucuda H.264'e cevrilerek mi geliyor. */
  get convert() { return converted.has(this.key()); }
  get running() { return this.m.running; }
  get frameVar() { return this.m.frameVar; }
  start(retry = false) { this.m.start(retry); }
  stop(muted = false) { this.m.stop(muted); }
  rate() { const h = this.m.rate(); return h && { ...h, convert: this.convert }; }
}
