/**
 * Canli izleme sayfasi (/live) hizmeti: uyeliksiz, gecikmesiz izleme.
 * Goruntuyu mediamtx verir (ayri konteyner, WebRTC/WHEP); bu hizmet onu yonetir:
 *  - her kanalin alt akis kodegini bir kez olcer (ffprobe);
 *  - mediamtx'e API ile yol yazar: H.264 kanal dogrudan kaynak, digerleri (H.265) izlenirken KAYNAK KALITEDE H.264'e cevrilir
 *    (Chrome WebRTC'de H.265 oynatmiyor). Cihaz parolasi dosyaya yazilmaz, yalniz bellekte ve mediamtx'in belleginde durur;
 *  - herkesin gordugu ORTAK duzeni tutar (veri/live-duzen.json; panel yedegine girer).
 * mediamtx yeniden baslarsa yollar bir sonraki esitlemede (en gec 1 dk) geri yazilir. KAMERA_RTC_API bossa kapali.
 */
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cevirme kaynak kalitede: cozunurluk ve kare hizi oldugu gibi (goruntu kalitesinden odun verilmez).
 * Olcum: alt akis 704x576 25 kare/sn -> %18 cekirdek, 1,04 Mbps. -g 25: yeni izleyici en gec 1 sn'de anahtar kare alir; -bf 0: WebRTC.
 */
export const LIVE_CEVIR = '-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 1000k -maxrate 1000k -bufsize 2000k -g 25 -bf 0';

/** Kayitli duzen ve KAMERA_LIVE_VARSAYILAN yokken gosterilecek kamera sayisi (ilk N kamera). */
export const LIVE_ILK = 12;
export const LIVE_SUTUN = [1, 2, 3, 4, 5, 6];

/** Kanal listesi + kodekler -> mediamtx yollari (test/live.test.mjs). */
export function liveYollari(liste, kodek) {
  const y = {};
  for (const x of liste) {
    const kd = kodek.get(x.k);
    if (!kd) continue;
    const kaynak = { source: x.url, rtspTransport: 'tcp', sourceOnDemand: true };
    if (kd === 'h264') y[`k${x.k}`] = kaynak;
    else {
      y[`k${x.k}_kaynak`] = kaynak;
      y[`k${x.k}`] = { source: 'publisher', runOnDemand: `ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i rtsp://127.0.0.1:8554/k${x.k}_kaynak -an ${LIVE_CEVIR} -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/k${x.k}`, runOnDemandRestart: true };
    }
  }
  return y;
}

function kodekOlc(ffprobe, url) {
  return new Promise((coz) => {
    const p = spawn(ffprobe, ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', url], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let c = ''; const z = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (b) => { c += b; });
    p.on('error', () => { clearTimeout(z); coz(null); });   // dinleyicisiz 'error' paneli dusurur
    p.on('close', () => { clearTimeout(z); coz(c.trim().split('\n')[0] || null); });
  });
}

export class LiveHizmeti {
  constructor({ yapilandirma, cihazlar }) {
    this.y = yapilandirma.live; this.cihazlar = cihazlar;
    this.DOSYA = join(yapilandirma.veriKlasoru, 'live-duzen.json');
    this.kodek = new Map(); this.yazilan = new Map(); this.kameralar = []; this.son = null;
    this.ffprobe = (cihazlar.ffmpeg ?? 'ffmpeg').replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  }
  get acik() { return !!this.y.rtcApi; }

  /** ilk: ilk esitlemenin sozu (testler bekler). */
  baslat() { if (this.acik && !this.ilk) this.ilk = this.#dongu(); }
  kapat() { clearTimeout(this.zaman); this.zaman = null; this.kapali = true; }
  async #dongu() {
    try { const r = await this.esitle(); if (JSON.stringify(r) !== JSON.stringify(this.son)) console.log(`live: ${r.hazir}/${r.kanal} kanal mediamtx'te`); this.son = r; }
    catch (e) { console.error('live esitleme:', e.message); }
    if (!this.kapali) { this.zaman = setTimeout(() => this.#dongu(), 60_000); this.zaman.unref?.(); }
  }

  async #api(yontem, yol, govde) {
    const r = await fetch(this.y.rtcApi + yol, { method: yontem, headers: govde ? { 'Content-Type': 'application/json' } : {}, body: govde ? JSON.stringify(govde) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`mediamtx ${yontem} ${yol.split('/').slice(0, 5).join('/')}: HTTP ${r.status}`);
    return r.headers.get('content-type')?.includes('json') ? r.json() : null;
  }

  async esitle() {
    const b = await this.cihazlar.bilgi();
    const liste = [];
    for (const c of this.cihazlar.grup.cihazlar) {
      if (typeof c.canliYol !== 'function' || typeof c.rtspUrl !== 'function') continue;   // RTSP'siz surucu (Xiongmai, sahte) yok sayilir
      for (let i = 0; i < c.kanalSayisi; i++) {
        const k = c.baslangic + i;
        if (b.kanalBos?.[k]) continue;
        liste.push({ k, ad: b.kanalAdlari?.[k] ?? `Kamera ${k + 1}`, cihaz: c.ayar.ad ?? '', url: c.rtspUrl(c.canliYol(i, 'Extra1')) });
      }
    }
    const olculecek = liste.filter((x) => !this.kodek.has(x.k));
    await Promise.all(Array.from({ length: 4 }, async () => { while (olculecek.length) { const x = olculecek.shift(); const kd = await kodekOlc(this.ffprobe, x.url); if (kd) this.kodek.set(x.k, kd); } }));
    const hazir = liste.filter((x) => this.kodek.has(x.k));
    const istenen = liveYollari(hazir, this.kodek);
    const mevcut = new Set(((await this.#api('GET', '/v3/config/paths/list?itemsPerPage=10000'))?.items ?? []).map((p) => p.name));
    for (const [ad, ayar] of Object.entries(istenen)) {
      const j = JSON.stringify(ayar);
      if (mevcut.has(ad) && this.yazilan.get(ad) === j) continue;   // degismeyen yol yeniden yazilmaz: acik izleyici dusmesin
      await this.#api('POST', `/v3/config/paths/${mevcut.has(ad) ? 'replace' : 'add'}/${ad}`, ayar);
      this.yazilan.set(ad, j);
    }
    for (const ad of mevcut) if (!(ad in istenen)) { await this.#api('DELETE', `/v3/config/paths/delete/${ad}`); this.yazilan.delete(ad); }
    this.kameralar = hazir.map((x) => ({ yol: `k${x.k}`, ad: x.ad, cihaz: x.cihaz, cevrilir: this.kodek.get(x.k) !== 'h264' }));
    return { kanal: liste.length, hazir: hazir.length };
  }

  /**
   * Izleme (WHEP): tarayicinin SDP teklifini mediamtx'e iletir, cevabi dondurur. Yalniz panelin listeledigi yollar
   * (cihaz yolu ya da cevirici kaynagi degil); mediamtx'in geri kalani disariya acilmaz. { durum, sdp } doner.
   */
  async whep(yol, teklif) {
    if (!this.kameralar.some((k) => k.yol === yol)) return { durum: 404, sdp: '' };
    const r = await fetch(`${this.y.rtcWhep}/${encodeURIComponent(yol)}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: teklif, signal: AbortSignal.timeout(10_000) });
    return { durum: r.status, sdp: await r.text() };
  }

  // ---- ortak duzen
  duzen() {
    try { const d = JSON.parse(readFileSync(this.DOSYA, 'utf8')); if (Array.isArray(d.yollar)) return d; } catch {}
    // Kayitli duzen yoksa: KAMERA_LIVE_VARSAYILAN sirasi (listede olmayan atlanir), o da bossa ilk LIVE_ILK kamera.
    const sira = this.y.varsayilan ?? [];
    const yollar = sira.length ? sira.filter((y) => !this.kameralar.length || this.kameralar.some((k) => k.yol === y)) : this.kameralar.slice(0, LIVE_ILK).map((k) => k.yol);
    return { sutun: 4, yollar, varsayilan: true };
  }
  /** g: { sutun, yollar }. Gecersizse hata. */
  duzenYaz(g, kaydeden) {
    const yollar = Array.isArray(g?.yollar) ? [...new Set(g.yollar)] : null;
    if (!yollar || yollar.length > 64 || !yollar.every((y) => this.kameralar.some((k) => k.yol === y)) || !LIVE_SUTUN.includes(g.sutun)) throw new Error('Geçersiz düzen');
    const d = { sutun: g.sutun, yollar, kaydeden, zaman: new Date().toISOString() };
    const gecici = `${this.DOSYA}.yeni`; writeFileSync(gecici, JSON.stringify(d, null, 1)); renameSync(gecici, this.DOSYA);
    return d;
  }
}
