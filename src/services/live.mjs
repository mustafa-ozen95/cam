/**
 * Canli izleme sayfasi (/live) hizmeti: uyeliksiz izleme. Goruntu PANELIN KENDI canli MP4 akisidir (ayni surucu, ayni
 * ffmpeg, ayni paylasilan baglanti; bkz. streams.liveMp4); ayri bir goruntu sunucusu yok. Bu hizmet:
 *  - /live'da gosterilebilecek kameralari listeler (yol, ad, cihaz adi; adres/parola yok);
 *  - herkesin gordugu ORTAK duzeni tutar (ayarlar tablosu, "live-layout"; veritabani yedegine girer).
 * Kamera listesi dakikada bir tazelenir. CAM_LIVE=0 ise kapali.
 */

/** Kayitli duzen ve CAM_LIVE_DEFAULT yokken gosterilecek kamera sayisi (ilk N kamera). */
export const LIVE_FIRST_COUNT = 12;
export const LIVE_COLUMNS = [1, 2, 3, 4, 5, 6];

export class LiveService {
  /** ayarlar: Ayarlar (veritabani); kayitli duzeni yukle() getirir. */
  constructor({ config, devices, settings }) {
    this.y = config.live; this.devices = devices; this.settings = settings; this.savedLayout = null;
    this.cameras = []; this.last = null;
  }
  async load() { const d = await this.settings.read('live-layout'); this.savedLayout = d && Array.isArray(d.paths) ? d : null; return this; }
  get open() { return !!this.y.enabled; }

  /** ilk: ilk esitlemenin sozu (testler bekler). */
  start() { if (this.open && !this.first) this.first = this.#loop(); }
  close() { clearTimeout(this.time); this.time = null; this.closed = true; }
  async #loop() {
    try { const r = await this.sync(); if (JSON.stringify(r) !== JSON.stringify(this.last)) console.log(`live: ${r.camera} kamera`); this.last = r; }
    catch (e) { console.error('live kamera listesi:', e.message); }
    if (!this.closed) { this.time = setTimeout(() => this.#loop(), 60_000); this.time.unref?.(); }
  }

  async sync() {
    const b = await this.devices.info();
    const list = [];
    for (const c of this.devices.group.devices) {
      if (typeof c.feedMp4 !== 'function') continue;   // canli MP4 vermeyen surucu (Xiongmai DVR) panelde de goruntu vermez
      for (let i = 0; i < c.channelCount; i++) {
        const k = c.startIndex + i;
        if (b.channelEmpty?.[k]) continue;
        list.push({ path: `k${k}`, name: b.channelNames?.[k] ?? `Kamera ${k + 1}`, device: c.setting.name ?? '' });
      }
    }
    this.cameras = list;
    return { camera: list.length };
  }

  /** /live yolu (k<kanal>) -> kanal no; listede olmayan yol null (yalniz listelenen kameralar izlenir). */
  channel(path) { return this.cameras.some((k) => k.path === path) ? Number(path.slice(1)) : null; }

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
