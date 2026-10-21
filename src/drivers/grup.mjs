/**
 * Cihaz grubu: birden cok NVR'i (Uniview, Hikvision) tek panelde birlestirir. Her cihazin KALICI bir kanal blogu vardir
 * (cihaz.baslangic .. baslangic+kanalSayisi-1); cihaz eklenip silinse de baska cihazlarin kanal numaralari kaymaz.
 * sunucu.mjs grubu tek bir cihazmis gibi kullanir. Bir cihaza ulasilamazsa son bilinen kanal listesi korunur
 * (arayuz yeniden dizilmez), baska cihazlar etkilenmez. Cihazlar calisirken eklenip cikarilabilir.
 */
import { CihazTaban } from './taban.mjs';

export class CihazGrubu extends CihazTaban {
  constructor({ cihazlar = [], ...o }) {
    super(o);
    this.cihazlar = [];
    this.sonBilgi = new Map();     // cihaz id -> son basarili bilgi()
    this.hatalar = new Map();      // cihaz id -> son hata metni
    for (const c of cihazlar) this.ekle(c);
  }

  get kanalToplam() { return this.cihazlar.reduce((m, c) => Math.max(m, c.baslangic + c.kanalSayisi), 0); }

  ekle(c) { this.cihazlar.push(c); this.cihazlar.sort((a, b) => a.baslangic - b.baslangic); }
  /** Ayni id'li cihazi yenisiyle degistirir (eskisinin akislari kapanir). */
  degistir(id, yeni) {
    const i = this.cihazlar.findIndex((c) => c.id === id);
    if (i >= 0) { try { this.cihazlar[i].kapat(); } catch {} this.cihazlar.splice(i, 1); }
    this.sonBilgi.delete(id); this.hatalar.delete(id);
    this.ekle(yeni);
  }
  cikar(id) {
    const i = this.cihazlar.findIndex((c) => c.id === id);
    if (i >= 0) { try { this.cihazlar[i].kapat(); } catch {} this.cihazlar.splice(i, 1); }
    this.sonBilgi.delete(id); this.hatalar.delete(id);
  }

  /** Global kanal numarasinin ait oldugu cihazin kimligi (yoksa null). */
  cihazIdOf(kanal) {
    for (const c of this.cihazlar) if (kanal >= c.baslangic && kanal < c.baslangic + c.kanalSayisi) return c.id;
    return null;
  }

  #bul(kanal) {
    for (const c of this.cihazlar) if (kanal >= c.baslangic && kanal < c.baslangic + c.kanalSayisi) return { c, yerel: kanal - c.baslangic };
    throw new Error('kanal geçersiz');
  }

  // ---------- bilgi ----------
  async bilgi() {
    if (!this.cihazlar.length) throw new Error('Henüz cihaz eklenmedi (Cihaz sekmesinden ekleyin)');
    const sonuc = await Promise.all(this.cihazlar.map((c) => c.bilgi().then(
      (b) => { this.sonBilgi.set(c.id, b); this.hatalar.delete(c.id); return { c, b }; },
      (e) => { this.hatalar.set(c.id, e.message); return { c, b: this.sonBilgi.get(c.id), hata: e.message }; })));
    if (sonuc.every((s) => !s.b)) throw new Error(sonuc.find((s) => s.hata)?.hata ?? 'Cihaza ulaşılamadı');
    const T = this.kanalToplam;
    const adlar = Array.from({ length: T }, (_, k) => `Kanal ${k + 1}`), kodlar = Array.from({ length: T }, (_, k) => `K${k + 1}`);
    const bos = new Array(T).fill(true), kamera = new Array(T).fill(''), cihazAdi = new Array(T).fill('');
    for (const { c, b } of sonuc) {
      if (!b) continue;
      for (let i = 0; i < c.kanalSayisi; i++) {
        const k = c.baslangic + i;
        adlar[k] = b.kanalAdlari?.[i] ?? adlar[k]; kodlar[k] = b.kanalKodlar?.[i] ?? kodlar[k];
        bos[k] = b.kanalBos?.[i] ?? true; kamera[k] = b.kanalKamera?.[i] ?? ''; cihazAdi[k] = b.model ?? '';
      }
    }
    this.kanalAdlari = adlar;
    const ilk = (sonuc.find((s) => s.b?.saat) ?? sonuc.find((s) => s.b)).b;
    const alan = (f) => sonuc.map((s) => s.b?.[f] ?? '—').join(' / ');
    return {
      kanalBos: bos,
      sunucuSaat: ilk.sunucuSaat,
      ana: sonuc.map((s) => s.b?.ana ?? s.c.ayar.ana).join(' + '),
      model: sonuc.map((s) => s.b?.model ?? '?').join(' + '),
      surum: alan('surum'), seriNo: alan('seriNo'), derleme: alan('derleme'),
      calismaSn: ilk.calismaSn, saat: ilk.saat, kanal: T,
      kanalAdlari: adlar, kanalKodlar: kodlar, kanalKamera: kamera, kanalCihaz: cihazAdi,
      diskMB: { toplam: sonuc.reduce((a, s) => a + (s.b?.diskMB.toplam ?? 0), 0), bos: sonuc.reduce((a, s) => a + (s.b?.diskMB.bos ?? 0), 0) },
      diskler: sonuc.flatMap((s) => (s.b?.diskler ?? []).map((d) => ({ ...d, ad: `${s.b.model} · ${d.ad}`, cihaz: s.c.id }))),
      kayitGunTahmini: sonuc.map((s) => s.b?.kayitGunTahmini).find((x) => x) ?? null,
      cihazlar: sonuc.map(({ c, b, hata }) => ({
        id: c.id, ad: c.ayar.ad ?? '', model: b?.model ?? '?', ana: b?.ana ?? c.ayar.ana, surum: b?.surum ?? '—', seriNo: b?.seriNo ?? '—', derleme: b?.derleme ?? '—',
        saat: b?.saat ?? null, calismaSn: b?.calismaSn ?? 0, kanal: c.kanalSayisi, baslangic: c.baslangic, hata: hata ?? null,
      })),
    };
  }

  // ---------- kanal bazli islemler: ilgili cihaza yonlendirilir ----------
  yayin(kanal, tur, genislik, fps) { const { c, yerel } = this.#bul(kanal); return c.yayin(yerel, tur === 'Mini' && !c.miniDestek ? 'Extra1' : tur, genislik, fps); }
  /** Canli MP4; surucusu desteklemeyen cihazda (Xiongmai DVR) null (501). */
  yayinMp4(kanal, tur, cevir) { const { c, yerel } = this.#bul(kanal); return c.yayinMp4 ? c.yayinMp4(yerel, tur, cevir) : null; }
  kayitlar(kanal, bas, bit) { const { c, yerel } = this.#bul(kanal); return c.kayitlar(yerel, bas, bit); }
  /** Hareketli araliklar [{bas, bit}]; desteklemeyen surucude bos. */
  async hareketler(kanal, bas, bit) { const { c, yerel } = this.#bul(kanal); return c.hareketler ? c.hareketler(yerel, bas, bit) : []; }
  oynatMjpeg(res, kanal, bas, bit, genislik) { const { c, yerel } = this.#bul(kanal); return c.oynatMjpeg(res, yerel, bas, bit, genislik); }
  indirAkit(res, kanal, kayit, ad, bitince) { const { c, yerel } = this.#bul(kanal); return c.indirAkit(res, yerel, kayit, ad, bitince); }

  /** Cihaz id'si ile tek bir cihazin saatini esitler (arayuz: cihaz satirindaki Esitle). */
  async saatiSenkronla(id) {
    const c = this.cihazlar.find((x) => x.id === id);
    if (!c) throw new Error('Cihaz belirtilmedi');
    return { ...(await c.saatiSenkronla()), cihaz: c.ayar.ana };
  }

  /**
   * Oynatma yeri: kanal verilirse YALNIZ o kanalin cihazina bakilir. Butun cihazlara bakilsaydi bir
   * NVR dolunca obur NVR'dan da kayit acilamazdi.
   */
  oynatabilir(kanal) { return kanal === undefined ? this.cihazlar.every((c) => c.oynatabilir()) : this.#bul(kanal).c.oynatabilir(); }
  indirabilir() { return this.cihazlar.every((c) => c.indirabilir()); }
  kapat() { for (const c of this.cihazlar) c.kapat(); }
}
