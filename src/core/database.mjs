/**
 * Veritabani baglantisi (MariaDB/MySQL, mysql2/promise): havuz, islem (transaction), bekle-dene ile acilis, kendi goclerini kosturma.
 * Baglanti ortamdan gelir (config/app.mjs: DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD). Karakter kumesi utf8mb4.
 */
import mysql from 'mysql2/promise';
export { VeritabaniHatasi } from './errors.mjs';
import { MIGRATIONS } from '../database/migrations.mjs';

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

export class Veritabani {
  constructor(ayar) { this.ayar = ayar; this.havuz = null; }

  #havuzKur() {
    const a = this.ayar;
    return mysql.createPool({
      host: a.host, port: a.port, database: a.database, user: a.username, password: a.password, charset: 'utf8mb4',
      connectionLimit: a.havuz ?? 8, waitForConnections: true, dateStrings: true, multipleStatements: false, timezone: 'Z',
    });
  }

  /** Veritabani gelene kadar dener (compose'ta db servisi sonra kalkabilir); sure dolarsa son hatayla firlatir. */
  async baglan({ beklemeSn = 60, aralikMs = 2000 } = {}) {
    const bitis = Date.now() + beklemeSn * 1000;
    let son;
    for (let n = 1; ; n++) {
      const havuz = this.#havuzKur();
      try { await havuz.query('SELECT 1'); this.havuz = havuz; return this; }
      catch (e) {
        son = e; await havuz.end().catch(() => {});
        if (['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(e.code)) break;   // yanlis kimlik/veritabani adi bekleyince duzelmez
        if (Date.now() + aralikMs > bitis) break;
        if (n === 1 || n % 5 === 0) console.log(`veritabani bekleniyor (${this.ayar.host}:${this.ayar.port}/${this.ayar.database}): ${e.code ?? e.message}`);
        await bekle(aralikMs);
      }
    }
    throw new Error(`Veritabanına bağlanılamadı (${this.ayar.host}:${this.ayar.port}/${this.ayar.database}): ${son?.code ?? son?.message}`);
  }

  async sorgu(sql, parametre = []) { const [satirlar] = await this.havuz.query(sql, parametre); return satirlar; }

  /** fn(conn) tek islemde kosar; hata olursa geri alinir. */
  async islem(fn) {
    const c = await this.havuz.getConnection();
    try {
      await c.beginTransaction();
      const sonuc = await fn(c);
      await c.commit();
      return sonuc;
    } catch (e) { try { await c.rollback(); } catch { /* baglanti kopmus olabilir */ } throw e; }
    finally { c.release(); }
  }

  async saglikli() { try { await this.havuz.query('SELECT 1'); return true; } catch { return false; } }

  /**
   * Gocler: surum tablosu (migrations), sirali, uygulananlar tekrar kosmaz. Es zamanli iki acilis (iki kopya) ayni goce girmesin diye
   * veritabani kilidi (GET_LOCK) altinda calisir. Dondurur: bu acilista uygulananlarin surumleri.
   */
  async gocYap() {
    const c = await this.havuz.getConnection();
    const uygulanan = [];
    try {
      const [[k]] = await c.query("SELECT GET_LOCK('cam-migrate', 60) AS k");
      if (k.k !== 1) throw new Error('Göç kilidi alınamadı (başka bir kopya göç yapıyor)');
      await c.query('CREATE TABLE IF NOT EXISTS migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const [yapilan] = await c.query('SELECT version FROM migrations');
      const yapildi = new Set(yapilan.map((x) => x.version));
      for (const g of MIGRATIONS) {
        if (yapildi.has(g.version)) continue;
        for (const sql of g.sql) await c.query(sql);
        await c.query('INSERT INTO migrations (version, name) VALUES (?, ?)', [g.version, g.name]);
        uygulanan.push(g.version);
      }
      await c.query("SELECT RELEASE_LOCK('cam-migrate')");
    } finally { c.release(); }
    return uygulanan;
  }

  async kapat() { if (this.havuz) { const h = this.havuz; this.havuz = null; await h.end().catch(() => {}); } }
}
