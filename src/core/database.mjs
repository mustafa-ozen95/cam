/**
 * Veritabani baglantisi (MariaDB/MySQL, mysql2/promise): havuz, islem (transaction), bekle-dene ile acilis, kendi goclerini kosturma.
 * Baglanti ortamdan gelir (config/app.mjs: DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD). Karakter kumesi utf8mb4.
 */
import mysql from 'mysql2/promise';
export { DatabaseError } from './errors.mjs';
import { MIGRATIONS } from '../database/migrations.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class Database {
  constructor(setting) { this.setting = setting; this.pool = null; }

  #setupPool() {
    const a = this.setting;
    return mysql.createPool({
      host: a.host, port: a.port, database: a.database, user: a.username, password: a.password, charset: 'utf8mb4',
      connectionLimit: a.pool ?? 8, waitForConnections: true, dateStrings: true, multipleStatements: false, timezone: 'Z',
    });
  }

  /** Veritabani gelene kadar dener (compose'ta db servisi sonra kalkabilir); sure dolarsa son hatayla firlatir. */
  async connect({ waitingSec = 60, rangeMs = 2000 } = {}) {
    const expiresAt = Date.now() + waitingSec * 1000;
    let last;
    for (let n = 1; ; n++) {
      const pool = this.#setupPool();
      try { await pool.query('SELECT 1'); this.pool = pool; return this; }
      catch (e) {
        last = e; await pool.end().catch(() => {});
        if (['ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(e.code)) break;   // yanlis kimlik/veritabani adi bekleyince duzelmez
        if (Date.now() + rangeMs > expiresAt) break;
        if (n === 1 || n % 5 === 0) console.log(`veritabani bekleniyor (${this.setting.host}:${this.setting.port}/${this.setting.database}): ${e.code ?? e.message}`);
        await wait(rangeMs);
      }
    }
    throw new Error(`Veritabanına bağlanılamadı (${this.setting.host}:${this.setting.port}/${this.setting.database}): ${last?.code ?? last?.message}`);
  }

  async query(sql, param = []) { const [rows] = await this.pool.query(sql, param); return rows; }

  /** fn(conn) tek islemde kosar; hata olursa geri alinir. */
  async transaction(fn) {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const result = await fn(c);
      await c.commit();
      return result;
    } catch (e) { try { await c.rollback(); } catch { /* baglanti kopmus olabilir */ } throw e; }
    finally { c.release(); }
  }

  async healthy() { try { await this.pool.query('SELECT 1'); return true; } catch { return false; } }

  /**
   * Gocler: surum tablosu (migrations), sirali, uygulananlar tekrar kosmaz. Es zamanli iki acilis (iki kopya) ayni goce girmesin diye
   * veritabani kilidi (GET_LOCK) altinda calisir. Dondurur: bu acilista uygulananlarin surumleri.
   * baglam: { secret (Buffer; gizli anahtara bagli veriyi tasiyan gocler ister), log (varsayilan console.log) } — veri gocleri run(conn, baglam) alir.
   */
  async runMigrations(context = {}) {
    const c = await this.pool.getConnection();
    const applied = [];
    try {
      const [[k]] = await c.query("SELECT GET_LOCK('cam-migrate', 60) AS k");
      if (k.k !== 1) throw new Error('Göç kilidi alınamadı (başka bir kopya göç yapıyor)');
      await c.query('CREATE TABLE IF NOT EXISTS migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const [made] = await c.query('SELECT version FROM migrations');
      const done = new Set(made.map((x) => x.version));
      for (const g of MIGRATIONS) {
        if (done.has(g.version)) continue;
        if (g.run) {       // veri goci: kendi satiri ile birlikte TEK islemde; hata olursa hicbir sey degismez
          await c.beginTransaction();
          try { await g.run(c, { log: console.log, ...context }); await c.query('INSERT INTO migrations (version, name) VALUES (?, ?)', [g.version, g.name]); await c.commit(); }
          catch (e) { await c.rollback(); throw e; }
        } else {
          for (const sql of g.sql) await c.query(sql);
          await c.query('INSERT INTO migrations (version, name) VALUES (?, ?)', [g.version, g.name]);
        }
        applied.push(g.version);
      }
    } finally { try { await c.query("SELECT RELEASE_LOCK('cam-migrate')"); } catch { /* baglanti kopmus olabilir */ } c.release(); }
    return applied;
  }

  async close() { if (this.pool) { const h = this.pool; this.pool = null; await h.end().catch(() => {}); } }
}
