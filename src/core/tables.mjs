/**
 * Tablo yardimcilari: bellekteki nesne listesi <-> gercek tablo.
 *  - Kilit: ayni deponun yazmalari sirayla calisir (bellek degisikligi + veritabani yazimi tek parca).
 *  - Koleksiyon: tanima gore satir/nesne cevirir; yazarken yalniz DEGISEN satirlari yazar, silinenleri siler (tek islemde);
 *    yazim basarisizsa son basarili hali rollback() ile verir. Tanimda olmayan alanlar "ek" sutununda JSON olarak saklanir (alan kaybolmaz).
 *  - Ayarlar: tek parca belgeler (ad -> JSON) icin ayarlar tablosu.
 *
 * Sutun tanimi: { s: sutun adi, a: nesnedeki alan, t: 's' metin | 'i' tam sayi | 'j' JSON | 'b' mantiksal, bos: sutun NULL ise verilecek deger }.
 * `bos` verilmezse (undefined) NULL alan nesneye hic konmaz (eski JSON'da yoktu).
 */
import { DatabaseError } from './errors.mjs';

export class Lock {
  #last = Promise.resolve();
  run(fn) { const p = this.#last.then(fn); this.#last = p.catch(() => {}); return p; }
}

const writeValue = (t, v) => {
  if (v === undefined || v === null) return null;
  if (t === 'i') return Number(v);
  if (t === 'b') return v ? 1 : 0;
  if (t === 'j') return JSON.stringify(v);
  return String(v);
};
const readValue = (t, v) => {
  if (v === null || v === undefined) return undefined;
  if (t === 'i') return Number(v);
  if (t === 'b') return !!v;
  if (t === 'j') return JSON.parse(v);
  return String(v);
};

export class Collection {
  /** tanim: { tablo, anahtar (nesne alani), sutunlar:[...] } */
  constructor(db, definition) {
    this.db = db; this.t = definition; this.last = new Map();
    this.fields = new Set(definition.columns.map((s) => s.a));
    this.keyColumn = definition.columns.find((s) => s.a === definition.key).s;
  }

  #row(n) {
    const v = this.t.columns.map((s) => writeValue(s.t, n[s.a]));
    const extra = Object.fromEntries(Object.entries(n).filter(([k, x]) => !this.fields.has(k) && x !== undefined));
    v.push(Object.keys(extra).length ? JSON.stringify(extra) : null);
    return v;
  }
  #object(v) {
    const n = {};
    this.t.columns.forEach((s, i) => {
      const x = readValue(s.t, v[i]);
      if (x !== undefined) n[s.a] = x; else if (s.empty !== undefined) n[s.a] = s.empty;
    });
    if (v.at(-1)) Object.assign(n, JSON.parse(v.at(-1)));
    return n;
  }

  /** Veritabanindaki hali (ekleme sirasiyla); "son basarili hal" olarak da hatirlanir. */
  async load(conn = null) {
    const columns = [...this.t.columns.map((s) => s.s), 'extra'];
    const [rows] = await (conn ?? this.db.pool).query(`SELECT ${columns.join(', ')} FROM ${this.t.table} ORDER BY seq`);
    this.last = new Map();
    const list = [];
    for (const r of rows) {
      const v = columns.map((s) => (r[s] === undefined ? null : r[s]));
      const n = this.#object(v);
      this.last.set(String(n[this.t.key]), JSON.stringify(this.#row(n)));
      list.push(n);
    }
    return list;
  }

  async count(conn = null) { const [[r]] = await (conn ?? this.db.pool).query(`SELECT COUNT(*) AS n FROM ${this.t.table}`); return Number(r.n); }

  /** Bellekteki guncel liste ile son yazilan hal arasindaki fark. */
  plan(list) {
    const fresh = new Map(list.map((n) => [String(n[this.t.key]), this.#row(n)]));
    return {
      fresh, toWrite: [...fresh].filter(([k, v]) => this.last.get(k) !== JSON.stringify(v)),
      toRemove: [...this.last.keys()].filter((k) => !fresh.has(k)),
    };
  }
  emptyPlan(p) { return !p.toWrite.length && !p.toRemove.length; }
  /** Plani verilen islem baglantisinda uygular (commit cagirana kalir; basarili olunca onayla(plan) cagrilir). */
  async apply(c, p) {
    const columns = [...this.t.columns.map((s) => s.s), 'extra'];
    const update = columns.filter((s) => s !== this.keyColumn).map((s) => `${s} = VALUES(${s})`).join(', ');
    if (p.toRemove.length) await c.query(`DELETE FROM ${this.t.table} WHERE ${this.keyColumn} IN (?)`, [p.toRemove]);
    for (const [, v] of p.toWrite) await c.query(`INSERT INTO ${this.t.table} (${columns.join(', ')}) VALUES (?) ON DUPLICATE KEY UPDATE ${update}`, [v]);
  }
  confirm(p) { this.last = new Map([...p.fresh].map(([k, v]) => [k, JSON.stringify(v)])); }

  /** liste: bellekteki guncel nesneler; yalniz degisenler yazilir. extraWork(conn): ayni islemde ek yazim (ayarlar gibi). */
  async save(list, extraWork = null) {
    const p = this.plan(list);
    if (this.emptyPlan(p) && !extraWork) return;
    await this.db.transaction(async (c) => { await this.apply(c, p); if (extraWork) await extraWork(c); });
    this.confirm(p);
  }

  /** Son basarili hal (yazim basarisiz olunca bellegi buna dondurmek icin). */
  rollback() { return [...this.last.values()].map((j) => this.#object(JSON.parse(j))); }

  /** Toplu ekleme (aktarim): verilen islemin icinde, bos tabloya. */
  async addBulk(c, list) {
    const columns = [...this.t.columns.map((s) => s.s), 'extra'];
    for (const n of list) await c.query(`INSERT INTO ${this.t.table} (${columns.join(', ')}) VALUES (?)`, [this.#row(n)]);
  }
}

/** Bellekte degisir, basarisizsa geri alinan islem: fn() esinkron degisikligi yapar, sonra yaz() veritabanina isler. */
export async function writeOrRollback(write, rollback, name) {
  try { await write(); } catch (e) {
    rollback();
    console.error(`veritabani yazimi basarisiz (${name}):`, e?.code ?? '', e?.message ?? e);
    throw new DatabaseError(e);
  }
}

/** Tek parca belgeler: ayarlar(ad, deger JSON, guncellendi). */
export class Settings {
  constructor(db) { this.db = db; }
  async read(name, conn = null) {
    const [r] = await (conn ?? this.db.pool).query('SELECT value FROM settings WHERE name = ?', [name]);
    return r.length ? JSON.parse(r[0].value) : undefined;
  }
  async write(name, value, conn = null) {
    await (conn ?? this.db.pool).query('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP', [name, JSON.stringify(value)]);
  }
  async count(conn = null) { const [[r]] = await (conn ?? this.db.pool).query('SELECT COUNT(*) AS n FROM settings'); return Number(r.n); }
}

/** Birden cok koleksiyonu TEK islemde yazar: ciftler = [[koleksiyon, liste], ...]. Biri basarisizsa hicbiri yazilmaz. */
export async function saveTogether(db, pairs, extraWork = null) {
  const plans = pairs.map(([k, l]) => k.plan(l));
  if (plans.every((p, i) => pairs[i][0].emptyPlan(p)) && !extraWork) return;
  await db.transaction(async (c) => { for (let i = 0; i < pairs.length; i++) await pairs[i][0].apply(c, plans[i]); if (extraWork) await extraWork(c); });
  plans.forEach((p, i) => pairs[i][0].confirm(p));
}
