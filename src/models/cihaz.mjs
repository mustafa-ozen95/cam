/**
 * Cihaz deposu (veri/cihazlar.json): panele eklenen NVR'lar. Parolalar AES-256-GCM ile sifreli saklanir (anahtar: panelin gizli anahtarindan
 * turetilir; dosya tek basina parola vermez). Her cihaza KALICI bir kanal blogu (baslangic) verilir: cihaz silinse de digerlerinin kanal
 * numaralari (ad/gizleme ayarlari) kaymaz. Dosya yoksa KAMERA_CIHAZLAR ortam degiskeni (JSON) ile tohumlanir.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const TURLER = {
  uniview: { ad: 'Uniview NVR', kanal: 32, etiket: 'D' },
  hikvision: { ad: 'Hikvision NVR', kanal: 16, etiket: 'H', kameraEkle: true },
  xiongmai: { ad: 'Xiongmai DVR', kanal: 4, etiket: 'C' },
  kamera: { ad: 'IP Kamera (tek kamera)', kanal: 1, etiket: 'K' },
};
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export class CihazDeposu {
  constructor(dosya, gizli, tohum = []) {
    this.dosya = dosya;
    // Etiket eski adla SABIT (depo cam oldu): degisirse kayitli cihaz parolalari cozulemez.
    this.anahtar = createHash('sha256').update(`kamera2-cihaz-parola|${gizli.toString('hex')}`).digest();
    this.liste_ = []; this.ustSinir = 0;
    if (existsSync(dosya)) { const d = JSON.parse(readFileSync(dosya, 'utf8')); this.liste_ = d.cihazlar ?? []; this.ustSinir = Number(d.ustSinir) || 0; }
    else if (tohum.length) { for (const t of tohum) this.liste_.push(this.#kur(t, null, true)); this.#yaz(); }
    // Eski dosyada ust sinir yok: mevcut bloklarin sonundan baslar (ilk yazimda dosyaya girer; silme de yazimdir, yani silmeden once kayda gecer).
    this.ustSinir = Math.max(this.ustSinir, this.#blokSonu());
  }

  #blokSonu() { return this.liste_.reduce((m, c) => Math.max(m, c.baslangic + c.kanalSayisi), 0); }
  /** Kanal numaralari KALICIDIR: silinen/kuculen cihazin blogu hic yeniden verilmez (kapsamlardaki kanal numaralari yeni cihaza kaymasin). */
  #yaz() {
    this.ustSinir = Math.max(this.ustSinir ?? 0, this.#blokSonu());
    const g = `${this.dosya}.tmp`; writeFileSync(g, JSON.stringify({ surum: 1, ustSinir: this.ustSinir, cihazlar: this.liste_ }, null, 2), { mode: 0o600 }); renameSync(g, this.dosya);
  }

  sifrele(metin) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.anahtar, iv);
    const veri = Buffer.concat([c.update(String(metin), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), etiket: c.getAuthTag().toString('base64'), veri: veri.toString('base64') };
  }
  coz(o) {
    const d = createDecipheriv('aes-256-gcm', this.anahtar, Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.etiket, 'base64'));
    return Buffer.concat([d.update(Buffer.from(o.veri, 'base64')), d.final()]).toString('utf8');
  }

  /** Giris dogrulama + kayit nesnesi (kaydetmez). mevcut varsa guncelleme: bos alanlar eskisini korur. */
  #kur(g, mevcut, tohum = false) {
    const tur = g.tur ?? mevcut?.tur;
    if (!TURLER[tur]) throw new Error('Cihaz türü geçersiz');
    const ana = String(g.ana ?? mevcut?.ana ?? '').trim();
    if (!HOST.test(ana)) throw new Error('Adres geçersiz (IP ya da alan adı)');
    const kullanici = String(g.kullanici ?? mevcut?.kullanici ?? '').trim();
    if (!kullanici || kullanici.length > 64) throw new Error('Kullanıcı adı gerekli');
    const parolaVerildi = g.parola !== undefined && g.parola !== '';
    // Kayitli parola yalniz girildigi HEDEFE gider: adres ya da port degisiyorsa parola yeniden girilmeli. Aksi halde cihaz.yonet sahibi
    // adresi kendi dinleyicisine cevirip kayitli parolayi (baglanti denemesiyle) ele gecirebilirdi. Hicbir yere baglanmadan reddedilir.
    const portDeger = (ad) => { const v = g[ad] ?? mevcut?.[ad]; return v === undefined || v === '' || v === null ? undefined : Number(v); };
    if (mevcut && !parolaVerildi && (ana !== mevcut.ana || ['httpPort', 'rtspPort', 'port'].some((ad) => portDeger(ad) !== mevcut[ad])))
      throw new Error('Adres ya da port değiştiğinde cihaz parolası yeniden girilmeli');
    const parola = parolaVerildi ? String(g.parola) : (mevcut ? this.coz(mevcut.parola) : '');
    if (!parola || parola.length > 128) throw new Error('Parola gerekli');
    const etiket = String(g.etiket ?? mevcut?.etiket ?? TURLER[tur].etiket).trim();
    if (!/^[A-Za-z]{1,3}$/.test(etiket)) throw new Error('Kanal öneki 1-3 harf olmalı (ör. D, H)');
    const kanalSayisi = tur === 'kamera' ? 1 : Number(g.kanalSayisi ?? mevcut?.kanalSayisi ?? TURLER[tur].kanal);
    if (!Number.isInteger(kanalSayisi) || kanalSayisi < 1 || kanalSayisi > 128) throw new Error('Kanal sayısı 1-128 olmalı');
    const port = (ad) => { const v = g[ad] ?? mevcut?.[ad]; if (v === undefined || v === '' || v === null) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${ad} geçersiz`); return n; };
    const ad = String(g.ad ?? mevcut?.ad ?? '').trim().slice(0, 40);
    const sablon = tur === 'kamera' ? String(g.sablon ?? mevcut?.sablon ?? 'hikvision') : undefined;
    if (tur === 'kamera' && !['hikvision', 'dahua', 'uniview', 'ozel'].includes(sablon)) throw new Error('Kamera markası geçersiz');
    const yol = tur === 'kamera' ? String(g.yol ?? mevcut?.yol ?? '').trim().slice(0, 200) : undefined;
    if (tur === 'kamera' && sablon === 'ozel' && !yol) throw new Error('Özel seçildiğinde RTSP yolu gerekli');
    return {
      id: mevcut?.id ?? randomUUID().slice(0, 8), ad, tur, ana, kullanici, parola: parolaVerildi || !mevcut ? this.sifrele(parola) : mevcut.parola,
      etiket, kanalSayisi, httpPort: port('httpPort'), rtspPort: port('rtspPort'), port: port('port'), sablon, yol,
      baslangic: mevcut?.baslangic ?? this.#bosBaslangic(), olusturma: mevcut?.olusturma ?? new Date().toISOString(),
    };
  }
  #bosBaslangic() { return Math.max(this.ustSinir ?? 0, this.#blokSonu()); }

  /** Arayuze giden liste (parola YOK). */
  liste() { return this.liste_.map(({ parola, ...c }) => c); }
  /** Surucu olusturmak icin ayarlar (parola cozulmus). */
  ayarlar() { return this.liste_.map((c) => ({ ...c, parola: this.coz(c.parola) })); }
  ayar(id) { const c = this.liste_.find((x) => x.id === id); return c ? { ...c, parola: this.coz(c.parola) } : null; }

  /** Yeni cihaz kaydi hazirlar (henuz kaydetmez: once baglanti denenir). */
  hazirla(g) {
    const k = this.#kur(g, null);
    if (this.liste_.some((c) => c.ana === k.ana && c.tur === k.tur)) throw new Error('Bu cihaz zaten ekli');
    return { ...k, parola: this.coz(k.parola) };
  }
  ekle(kayit) {
    const { parola, ...gerisi } = kayit;
    this.liste_.push({ ...gerisi, parola: this.sifrele(parola) }); this.#yaz();
    return this.ayar(kayit.id);
  }
  /** Guncelleme kaydi hazirlar; kanal blogu komsu cihazla cakisiyorsa hata. */
  guncellemeHazirla(id, g) {
    const mevcut = this.liste_.find((c) => c.id === id);
    if (!mevcut) throw new Error('Cihaz yok');
    const k = this.#kur({ ...g, tur: mevcut.tur }, mevcut);
    const sonraki = this.liste_.filter((c) => c.id !== id && c.baslangic >= k.baslangic).sort((a, b) => a.baslangic - b.baslangic)[0];
    if (sonraki && k.baslangic + k.kanalSayisi > sonraki.baslangic) throw new Error(`Kanal sayısı en çok ${sonraki.baslangic - k.baslangic} olabilir (sonraki cihazın kanalları başlıyor)`);
    return { ...k, parola: this.coz(k.parola) };
  }
  guncelle(kayit) {
    const i = this.liste_.findIndex((c) => c.id === kayit.id);
    const { parola, ...gerisi } = kayit;
    this.liste_[i] = { ...gerisi, parola: this.sifrele(parola) }; this.#yaz();
    return this.ayar(kayit.id);
  }
  sil(id) {
    if (this.liste_.length < 2) throw new Error('Son cihaz silinemez');
    if (!this.liste_.some((c) => c.id === id)) throw new Error('Cihaz yok');
    this.liste_ = this.liste_.filter((c) => c.id !== id); this.#yaz();
  }
}
