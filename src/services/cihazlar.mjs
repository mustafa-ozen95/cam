/**
 * Cihaz hizmeti: surucu kaydi, cihaz grubu (calisan nesneler), cihaz deposu (sifreli ayarlar) ve kanal ayarlari (veri/kanallar.json).
 * Denetleyiciler cihaza yalniz bu hizmet uzerinden dokunur.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Uniview } from '../drivers/uniview.mjs';
import { Hikvision } from '../drivers/hikvision.mjs';
import { Xiongmai } from '../drivers/xiongmai.mjs';
import { IpKamera } from '../drivers/ipkamera.mjs';
import { CihazGrubu } from '../drivers/grup.mjs';
import { CihazDeposu, TURLER } from '../models/cihaz.mjs';

function ffmpegBul(tercih) {
  for (const a of [tercih, 'ffmpeg'].filter(Boolean)) if (spawnSync(a, ['-version'], { stdio: 'ignore' }).status === 0) return a;
  return null;
}

export class CihazHizmeti {
  constructor({ yapilandirma, gizli }) {
    this.y = yapilandirma;
    mkdirSync(yapilandirma.veriKlasoru, { recursive: true });
    this.ffmpeg = ffmpegBul(yapilandirma.cihaz.ffmpeg);
    if (!this.ffmpeg) throw new Error('ffmpeg bulunamadı');
    this.suruculer = { uniview: Uniview, hikvision: Hikvision, xiongmai: Xiongmai, kamera: IpKamera };
    this.turler = { ...TURLER };
    this.grup = new CihazGrubu({ ayar: {}, ffmpeg: this.ffmpeg, veriKlasoru: yapilandirma.veriKlasoru });
    this.gizli = gizli;
    this.KANAL_DOSYA = join(yapilandirma.veriKlasoru, 'kanallar.json');
    this.kanalAyar = {};
    try { this.kanalAyar = JSON.parse(readFileSync(this.KANAL_DOSYA, 'utf8')); } catch {}
    this.#adlariUygula();
  }
  /** Testler icin sahte surucu kaydi (yalniz yapilandirma.cihaz.test). */
  async sahteyiKaydet() { if (!this.y.cihaz.test) return; const { Sahte } = await import('../drivers/sahte.mjs'); this.suruculer.sahte = Sahte; this.turler.sahte = TURLER.sahte = { ad: 'Sahte (test)', kanal: 4, etiket: 'T' }; }
  /** Depoyu acar (tohumlar) ve cihazlari baslatir. sahteyiKaydet()'ten SONRA cagrilir. */
  baslat() {
    let tohum = []; try { tohum = JSON.parse(this.y.cihaz.tohum); } catch (e) { throw new Error(`KAMERA_CIHAZLAR okunamadı: ${e.message}`); }
    this.depo = new CihazDeposu(join(this.y.veriKlasoru, 'cihazlar.json'), this.gizli, tohum);
    for (const a of this.depo.ayarlar()) this.grup.ekle(this.olustur(a));
  }

  olustur(a) {
    const S = this.suruculer[a.tur]; if (!S) throw new Error(`Bilinmeyen cihaz türü: ${a.tur}`);
    const c = new S({ ayar: a, ffmpeg: this.ffmpeg, veriKlasoru: this.y.veriKlasoru }); c.id = a.id; c.baslangic = a.baslangic; return c;
  }
  baglantiDene(c) {
    return Promise.race([c.bilgi(), new Promise((_, r) => setTimeout(() => r(new Error('cihaz yanıt vermedi (zaman aşımı)')), 25_000))])
      .catch((e) => { try { c.kapat(); } catch {} throw new Error(`Cihaza bağlanılamadı: ${e.message}`); });
  }

  // ---- cihaz CRUD (depo + grup birlikte)
  liste() { return this.depo.liste().map((c) => ({ ...c, hata: this.grup.hatalar.get(c.id) ?? null })); }
  async ekle(g) { const k = this.depo.hazirla(g); const inst = this.olustur(k); await this.baglantiDene(inst); this.depo.ekle(k); this.grup.ekle(inst); return k; }
  async guncelle(id, g) {
    const k = this.depo.guncellemeHazirla(id, g), eski = this.depo.ayar(id), inst = this.olustur(k);
    if (['ana', 'kullanici', 'parola', 'httpPort', 'rtspPort', 'port', 'sablon', 'yol'].some((a) => String(k[a] ?? '') !== String(eski[a] ?? ''))) await this.baglantiDene(inst);
    this.depo.guncelle(k); this.grup.degistir(id, inst); return k;
  }
  sil(id) { const eski = this.depo.ayar(id); this.depo.sil(id); this.grup.cikar(id); return eski; }
  bul(id) { return this.grup.cihazlar.find((x) => x.id === id) ?? null; }

  // ---- kanal ayarlari (ad, goster/gizle)
  #adlariUygula() { this.grup.adlarGecersiz = Object.fromEntries(Object.entries(this.kanalAyar).filter(([, v]) => v.ad).map(([k, v]) => [k, v.ad])); }
  /** Cihaz bilgisine kanal ayarlarini uygular: "D1 (Kanal adı)" bicimi, zorla goster/gizle. */
  kanalUygula(b) {
    const ka = this.kanalAyar;
    return {
      ...b,
      kanalAdlari: b.kanalAdlari.map((a, i) => (b.kanalKodlar ? `${b.kanalKodlar[i]} (${ka[i]?.ad || a})` : ka[i]?.ad || a)),
      kanalCihazAdi: b.kanalAdlari,
      kanalBos: b.kanalBos.map((x, i) => (ka[i]?.gorunum === 'gizle' ? true : ka[i]?.gorunum === 'goster' ? false : x)),
      kanalOtomatikBos: b.kanalBos, kanalAyar: ka,
    };
  }
  kanalAyarKaydet(ayar, aralik) {
    let yeni = {};
    for (const [k, v] of Object.entries(ayar ?? {})) {
      if (!/^\d{1,4}$/.test(k) || Number(k) >= 1024 || typeof v !== 'object' || !v) continue;
      const ad = String(v.ad ?? '').trim().slice(0, 40), gorunum = ['goster', 'gizle'].includes(v.gorunum) ? v.gorunum : 'otomatik';
      if (ad || gorunum !== 'otomatik') yeni[k] = { ...(ad ? { ad } : {}), gorunum };
    }
    if (aralik) {        // aralik verildiyse yalniz o cihazin kanallari degisir
      const dis = Object.fromEntries(Object.entries(this.kanalAyar).filter(([k]) => Number(k) < aralik.bas || Number(k) >= aralik.son));
      const ic = Object.fromEntries(Object.entries(yeni).filter(([k]) => Number(k) >= aralik.bas && Number(k) < aralik.son));
      yeni = { ...dis, ...ic };
    }
    const g = this.KANAL_DOSYA + '.tmp'; writeFileSync(g, JSON.stringify(yeni, null, 2)); renameSync(g, this.KANAL_DOSYA);
    this.kanalAyar = yeni; this.#adlariUygula();
    return Object.keys(yeni).length;
  }

  async bilgi() { return this.kanalUygula(await this.grup.bilgi()); }
  kapat() { this.grup.kapat(); }
}
