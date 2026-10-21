/**
 * Tablo yardimcilari: bellekteki nesne listesi <-> gercek tablo.
 *  - Kilit: ayni deponun yazmalari sirayla calisir (bellek degisikligi + veritabani yazimi tek parca).
 *  - Koleksiyon: tanima gore satir/nesne cevirir; yazarken yalniz DEGISEN satirlari yazar, silinenleri siler (tek islemde);
 *    yazim basarisizsa son basarili hali geriAl() ile verir. Tanimda olmayan alanlar "ek" sutununda JSON olarak saklanir (alan kaybolmaz).
 *  - Ayarlar: tek parca belgeler (ad -> JSON) icin ayarlar tablosu.
 *
 * Sutun tanimi: { s: sutun adi, a: nesnedeki alan, t: 's' metin | 'i' tam sayi | 'j' JSON | 'b' mantiksal, bos: sutun NULL ise verilecek deger }.
 * `bos` verilmezse (undefined) NULL alan nesneye hic konmaz (eski JSON'da yoktu).
 */
import { VeritabaniHatasi } from './errors.mjs';

export class Kilit {
  #son = Promise.resolve();
  calistir(fn) { const p = this.#son.then(fn); this.#son = p.catch(() => {}); return p; }
}

const degerYaz = (t, v) => {
  if (v === undefined || v === null) return null;
  if (t === 'i') return Number(v);
  if (t === 'b') return v ? 1 : 0;
  if (t === 'j') return JSON.stringify(v);
  return String(v);
};
const degerOku = (t, v) => {
  if (v === null || v === undefined) return undefined;
  if (t === 'i') return Number(v);
  if (t === 'b') return !!v;
  if (t === 'j') return JSON.parse(v);
  return String(v);
};

export class Koleksiyon {
  /** tanim: { tablo, anahtar (nesne alani), sutunlar:[...] } */
  constructor(vt, tanim) {
    this.vt = vt; this.t = tanim; this.son = new Map();
    this.alanlar = new Set(tanim.sutunlar.map((s) => s.a));
    this.anahtarSutun = tanim.sutunlar.find((s) => s.a === tanim.anahtar).s;
  }

  #satir(n) {
    const v = this.t.sutunlar.map((s) => degerYaz(s.t, n[s.a]));
    const ek = Object.fromEntries(Object.entries(n).filter(([k, x]) => !this.alanlar.has(k) && x !== undefined));
    v.push(Object.keys(ek).length ? JSON.stringify(ek) : null);
    return v;
  }
  #nesne(v) {
    const n = {};
    this.t.sutunlar.forEach((s, i) => {
      const x = degerOku(s.t, v[i]);
      if (x !== undefined) n[s.a] = x; else if (s.bos !== undefined) n[s.a] = s.bos;
    });
    if (v.at(-1)) Object.assign(n, JSON.parse(v.at(-1)));
    return n;
  }

  /** Veritabanindaki hali (ekleme sirasiyla); "son basarili hal" olarak da hatirlanir. */
  async yukle(conn = null) {
    const sutunlar = [...this.t.sutunlar.map((s) => s.s), 'extra'];
    const [satirlar] = await (conn ?? this.vt.havuz).query(`SELECT ${sutunlar.join(', ')} FROM ${this.t.tablo} ORDER BY seq`);
    this.son = new Map();
    const liste = [];
    for (const r of satirlar) {
      const v = sutunlar.map((s) => (r[s] === undefined ? null : r[s]));
      const n = this.#nesne(v);
      this.son.set(String(n[this.t.anahtar]), JSON.stringify(this.#satir(n)));
      liste.push(n);
    }
    return liste;
  }

  async sayi(conn = null) { const [[r]] = await (conn ?? this.vt.havuz).query(`SELECT COUNT(*) AS n FROM ${this.t.tablo}`); return Number(r.n); }

  /** Bellekteki guncel liste ile son yazilan hal arasindaki fark. */
  plan(liste) {
    const yeni = new Map(liste.map((n) => [String(n[this.t.anahtar]), this.#satir(n)]));
    return {
      yeni, yazilacak: [...yeni].filter(([k, v]) => this.son.get(k) !== JSON.stringify(v)),
      silinecek: [...this.son.keys()].filter((k) => !yeni.has(k)),
    };
  }
  bosPlan(p) { return !p.yazilacak.length && !p.silinecek.length; }
  /** Plani verilen islem baglantisinda uygular (commit cagirana kalir; basarili olunca onayla(plan) cagrilir). */
  async uygula(c, p) {
    const sutunlar = [...this.t.sutunlar.map((s) => s.s), 'extra'];
    const guncelle = sutunlar.filter((s) => s !== this.anahtarSutun).map((s) => `${s} = VALUES(${s})`).join(', ');
    if (p.silinecek.length) await c.query(`DELETE FROM ${this.t.tablo} WHERE ${this.anahtarSutun} IN (?)`, [p.silinecek]);
    for (const [, v] of p.yazilacak) await c.query(`INSERT INTO ${this.t.tablo} (${sutunlar.join(', ')}) VALUES (?) ON DUPLICATE KEY UPDATE ${guncelle}`, [v]);
  }
  onayla(p) { this.son = new Map([...p.yeni].map(([k, v]) => [k, JSON.stringify(v)])); }

  /** liste: bellekteki guncel nesneler; yalniz degisenler yazilir. ekIs(conn): ayni islemde ek yazim (ayarlar gibi). */
  async kaydet(liste, ekIs = null) {
    const p = this.plan(liste);
    if (this.bosPlan(p) && !ekIs) return;
    await this.vt.islem(async (c) => { await this.uygula(c, p); if (ekIs) await ekIs(c); });
    this.onayla(p);
  }

  /** Son basarili hal (yazim basarisiz olunca bellegi buna dondurmek icin). */
  geriAl() { return [...this.son.values()].map((j) => this.#nesne(JSON.parse(j))); }

  /** Toplu ekleme (aktarim): verilen islemin icinde, bos tabloya. */
  async topluEkle(c, liste) {
    const sutunlar = [...this.t.sutunlar.map((s) => s.s), 'extra'];
    for (const n of liste) await c.query(`INSERT INTO ${this.t.tablo} (${sutunlar.join(', ')}) VALUES (?)`, [this.#satir(n)]);
  }
}

/** Bellekte degisir, basarisizsa geri alinan islem: fn() esinkron degisikligi yapar, sonra yaz() veritabanina isler. */
export async function yazGeriAl(yaz, geriAl, ad) {
  try { await yaz(); } catch (e) {
    geriAl();
    console.error(`veritabani yazimi basarisiz (${ad}):`, e?.code ?? '', e?.message ?? e);
    throw new VeritabaniHatasi(e);
  }
}

/** Tek parca belgeler: ayarlar(ad, deger JSON, guncellendi). */
export class Ayarlar {
  constructor(vt) { this.vt = vt; }
  async oku(ad, conn = null) {
    const [r] = await (conn ?? this.vt.havuz).query('SELECT value FROM settings WHERE name = ?', [ad]);
    return r.length ? JSON.parse(r[0].value) : undefined;
  }
  async yaz(ad, deger, conn = null) {
    await (conn ?? this.vt.havuz).query('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP', [ad, JSON.stringify(deger)]);
  }
  async say(conn = null) { const [[r]] = await (conn ?? this.vt.havuz).query('SELECT COUNT(*) AS n FROM settings'); return Number(r.n); }
}

/** Birden cok koleksiyonu TEK islemde yazar: ciftler = [[koleksiyon, liste], ...]. Biri basarisizsa hicbiri yazilmaz. */
export async function birlikteKaydet(vt, ciftler, ekIs = null) {
  const planlar = ciftler.map(([k, l]) => k.plan(l));
  if (planlar.every((p, i) => ciftler[i][0].bosPlan(p)) && !ekIs) return;
  await vt.islem(async (c) => { for (let i = 0; i < ciftler.length; i++) await ciftler[i][0].uygula(c, planlar[i]); if (ekIs) await ekIs(c); });
  planlar.forEach((p, i) => ciftler[i][0].onayla(p));
}
