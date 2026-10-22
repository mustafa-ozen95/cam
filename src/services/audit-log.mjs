/**
 * Denetim gunlugu hizmeti (audit_log tablosu): giris, indirme, oynatma, cihaz/uye/yetki degisiklikleri; istemci IP/port/UA ile.
 * Zincirleme imza: her kayit onceki kaydin imzasini ve kendi icerigini gizli anahtarla (HMAC) imzalar; araya kayit sokmak/silmek/degistirmek
 * zinciri bozar; dogrula() bunu denetler. Parola/anahtar gizlisi ASLA yazilmaz.
 *
 * Her kayit satir olarak yazilir: imzalanan JSON metni `record` sutununda birebir durur (dogrulama bunu okur); event, username, ip, ts, local_time
 * suzme icin ayri sutunlardadir. Ekleme sirasi TEK SIRALI kuyrukla korunur (imza zinciri): kuyrukta her kayit, oncekinin yazilmasini bekler.
 */
import { clientIp, cleanIp } from '../core/http.mjs';
import { auditChainStep, auditEventNames, auditRecordView } from '../database/legacy-names.mjs';

const BATCH_ROWS = 500;   // dogrulama ve aktarimda bir seferde okunan satir

const likeEscape = (m) => String(m).replace(/[\\%_]/g, (x) => `\\${x}`);

export class AuditLog {
  constructor(db, sign, trustedIpHeader = '') {
    this.db = db; this.sign = sign; this.trustedIpHeader = trustedIpHeader;
    this.lastSignature = '';
    this.queue = Promise.resolve();
  }

  /** Acilista zincirin son imzasi. */
  async load() {
    const [r] = await this.db.pool.query('SELECT signature FROM audit_log ORDER BY id DESC LIMIT 1');
    this.lastSignature = r.length ? r[0].signature : '';
    return this;
  }

  /** Kuyrukta bekleyen tum yazimlar bitene kadar bekler (okuma/kapanis oncesi). */
  async wait() { await this.queue; }

  /**
   * olay, kullanici (gunluk adi: "ali" | "anahtar:ab12" | "sistem"), istek (null olabilir), ayrinti.
   * Dondurur: yazim sozu (true: yazildi). Veritabanina yazilamazsa sunucu gunlugune (stderr) bildirir ve false doner; cagiran beklemek zorunda degil.
   */
  write(event, username, req, detail = {}) {
    let body;
    try {
      const now = new Date(), forward = {};
      for (const b of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ray', 'cf-ipcountry']) if (req?.headers[b]) forward[b] = String(req.headers[b]).slice(0, 120);
      body = {
        time: now.toISOString(), localTime: `${now.toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' })} Europe/Istanbul`,
        event, username,
        ip: req ? clientIp(req, this.trustedIpHeader) : null, port: req?.socket.remotePort ?? null,
        localIp: req ? cleanIp(req.socket.localAddress) : null, localPort: req?.socket.localPort ?? null, tls: !!req?.socket.encrypted,
        request: req ? `${req.method} ${String(req.url).split('?')[0]}`.slice(0, 200) : null,
        ...(Object.keys(forward).length ? { forwarded: forward } : {}),
        ua: String(req?.headers['user-agent'] ?? '').slice(0, 160),
        ...detail,
      };
    } catch (e) { console.error('gunluk kaydi hazirlanamadi', e.message); return Promise.resolve(false); }
    const order = this.queue.then(async () => {
      const record = { ...body, previous: this.lastSignature };
      record.signature = this.sign(this.lastSignature + JSON.stringify(record));
      await this.db.pool.query(
        'INSERT INTO audit_log (ts, local_time, event, username, ip, forwarded, previous_signature, signature, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [record.time, record.localTime ?? null, String(record.event).slice(0, 100), record.username == null ? null : String(record.username).slice(0, 512), record.ip == null ? null : String(record.ip).slice(0, 100),
          record.forwarded ? JSON.stringify(record.forwarded) : null, record.previous, record.signature, JSON.stringify(record)]);
      this.lastSignature = record.signature;   // zincir yalniz yazim basarili olunca ilerler
      return true;
    }).catch((e) => { console.error('gunluk yazilamadi', e?.code ?? '', e?.message ?? e); return false; });
    this.queue = order;
    return order;
  }

  /** Suzgec + sayfalama; en yeni ustte. */
  async list({ event = '', username = '', ip = '', day = '', page = 1, size = 50 }) {
    await this.wait();
    const condition = [], p = [];
    if (event) { condition.push('event IN (?)'); p.push(auditEventNames(event)); }   // eski (Turkce) ve yeni ad ayni olaydir
    if (username) { condition.push('username LIKE ?'); p.push(`%${likeEscape(username)}%`); }
    if (ip) { condition.push('(ip LIKE ? OR forwarded LIKE ?)'); p.push(`%${likeEscape(ip)}%`, `%${likeEscape(ip)}%`); }
    if (day) { condition.push('COALESCE(local_time, ts) LIKE ?'); p.push(`${likeEscape(day)}%`); }
    const where = condition.length ? `WHERE ${condition.join(' AND ')}` : '';
    const [[t]] = await this.db.pool.query(`SELECT COUNT(*) AS n FROM audit_log ${where}`, p);
    const [rows] = await this.db.pool.query(`SELECT record FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...p, size, (page - 1) * size]);
    return { total: Number(t.n), page, size, records: rows.map((s) => auditRecordView(JSON.parse(s.record))) };
  }

  /** Zinciri veritabanindaki kayitlardan dogrular (artan sirayla, parca parca okur). */
  async verify() {
    await this.wait();
    let previous = '', n = 0, last = 0;
    for (;;) {
      const [rows] = await this.db.pool.query('SELECT id, record FROM audit_log WHERE id > ? ORDER BY id LIMIT ?', [last, BATCH_ROWS]);
      if (!rows.length) break;
      for (const s of rows) {
        n++; last = s.id;
        let k; try { k = JSON.parse(s.record); } catch { return { ok: false, record: n, error: `${n}. satır okunamıyor` }; }
        const signature = auditChainStep(k, previous, this.sign);   // eski (Turkce alan adli) ve yeni kayitlar ayni zincirde
        if (signature === null) return { ok: false, record: n, error: `${n}. kayıtta zincir bozuk (${k.time ?? k.z})` };
        previous = signature;
      }
    }
    return { ok: true, record: n };
  }
}
