/**
 * Xiongmai (XM / NetSurveillance / Sofia) "DVR-IP" protokolu, 34567 portu. Bagimliliksiz.
 * Paket: 20 bayt baslik (0xFF, surum, 2 yedek, oturum u32, sira u32, toplam, gecerli, mesajNo u16, uzunluk u32) + govde.
 */
import net from 'node:net';
import { createHash } from 'node:crypto';

const ALFA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function sofiaHash(password) {
  const md5 = createHash('md5').update(password, 'latin1').digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFA[(md5[2 * i] + md5[2 * i + 1]) % 62];
  return s;
}

export const MSG = {
  LOGIN: 1000, SYSTEM: 1020, GET_SETTING: 1042, DISK: 1020, START_WATCH: 1410, WATCH_DATA: 1412, WATCH_OWN: 1413,
  PLAY: 1420, PLAY_OWN: 1424, PLAY_DATA: 1426, FILE_QUERY: 1440, ADMIN: 1450, KEEPALIVE: 1006, GENERAL: 1450,
};

export class Connection {
  constructor(host, port = 34567) { this.host = host; this.port = port; this.buffer = Buffer.alloc(0); this.order = 0; this.session = 0; this.pending = new Map(); this.dataListener = null; }

  connect(timeOverflow = 5000) {
    return new Promise((resolve, red) => {
      const s = (this.socket = net.createConnection({ host: this.host, port: this.port }));
      s.setNoDelay(true);
      const t = setTimeout(() => { s.destroy(); red(new Error('Bağlantı zaman aşımı')); }, timeOverflow);
      s.once('connect', () => { clearTimeout(t); resolve(this); });
      s.once('error', (e) => { clearTimeout(t); red(e); });
      s.on('data', (b) => this.#get(b));
      s.on('close', () => { this.closed = true; for (const [, b] of this.pending) b.red(new Error('Bağlantı kapandı')); this.pending.clear(); this.shutdownListener?.(); });
      s.on('error', () => {});
    });
  }

  #get(b) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, b]) : b;
    while (this.buffer.length >= 20) {
      const uz = this.buffer.readUInt32LE(16);
      if (this.buffer.length < 20 + uz) break;
      const msg = this.buffer.readUInt16LE(14);
      const body = this.buffer.subarray(20, 20 + uz);
      this.buffer = this.buffer.subarray(20 + uz);
      if (this.dataListener?.(msg, body)) continue;
      const wait = this.pending.get(msg - 1) ?? this.pending.get(msg);
      if (wait) {
        this.pending.delete(msg - 1); this.pending.delete(msg); clearTimeout(wait.t);
        wait.resolve({ msg, body });
      }
    }
  }

  send(msg, object, bodyRaw) {
    const g = bodyRaw ?? Buffer.from(JSON.stringify(object) + '\n\0', 'utf8');
    const h = Buffer.alloc(20);
    h[0] = 0xff; h.writeUInt32LE(this.session, 4); h.writeUInt32LE(this.order++, 8); h.writeUInt16LE(msg, 14); h.writeUInt32LE(g.length, 16);
    this.socket.write(Buffer.concat([h, g]));
  }

  /** Istek gonder, ayni numarali (+1) yaniti bekle. JSON dondurur. */
  req(msg, object, timeOverflow = 8000) {
    return new Promise((resolve, red) => {
      const t = setTimeout(() => { this.pending.delete(msg); red(new Error(`Yanıt gelmedi (${msg})`)); }, timeOverflow);
      this.pending.set(msg, { t, red, resolve: ({ body }) => { try { resolve(JSON.parse(body.toString('utf8').replace(/\0+$/, '').replace(/[\x00-\x09\x0b-\x1f]/g, ''))); } catch (e) { red(e); } } });
      this.send(msg, object);
    });
  }

  async login(username, password) {
    const y = await this.req(MSG.LOGIN, { EncryptType: 'MD5', LoginType: 'DVRIP-Web', PassWord: sofiaHash(password), UserName: username });
    if (y.Ret !== 100 && y.Ret !== 515) throw new Error(`Giriş reddedildi (Ret ${y.Ret})`);
    this.session = parseInt(y.SessionID, 16);
    this.sessionIdentity = y.SessionID;
    this.info = y;
    return y;
  }

  close() { try { this.socket?.destroy(); } catch {} }
}

/**
 * XM akisindan ham H.264 (Annex B) ayiklar: I (FC, 16 bayt baslik), P (FD, 8), ses (FA, 8), bilgi (F9, 8) cerceveleri.
 * Paket sinirlari cerceveyle ortusmez; tampon biriktirilir. Videoyu `video(buf)`, sesi `ses(buf)` ile verir.
 */
export class FrameSplitter {
  constructor(video, audio) { this.video = video; this.audio = audio; this.t = Buffer.alloc(0); this.info = { fps: 25, width: 0, height: 0 }; }
  add(b) {
    this.t = this.t.length ? Buffer.concat([this.t, b]) : b;
    let i = 0;
    const t = this.t;
    for (;;) {
      if (t.length - i < 8) break;
      if (t[i] !== 0 || t[i + 1] !== 0 || t[i + 2] !== 1) { // eşleşme kaybi: sonraki baslangic kodunu ara
        const j = t.indexOf(Buffer.from([0, 0, 1]), i + 1);
        if (j < 0) { i = t.length - 2; break; }
        i = j; continue;
      }
      const type = t[i + 3];
      let header, uz;
      if (type === 0xfc) { if (t.length - i < 16) break; header = 16; uz = t.readUInt32LE(i + 12); const fps = t[i + 5] & 0x1f; if (fps) this.info.fps = fps; this.info.width = t[i + 6] * 8; this.info.height = t[i + 7] * 8; }
      else if (type === 0xfd) { header = 8; uz = t.readUInt32LE(i + 4); }
      else if (type === 0xfa || type === 0xf9) { header = 8; uz = t.readUInt16LE(i + 6); }
      else { const j = t.indexOf(Buffer.from([0, 0, 1]), i + 1); if (j < 0) { i = t.length - 2; break; } i = j; continue; }
      if (uz > 4_000_000) { i += 4; continue; }
      if (t.length - i < header + uz) break;
      const payload = t.subarray(i + header, i + header + uz);
      if (type === 0xfc || type === 0xfd) this.video(payload); else if (type === 0xfa) this.audio?.(payload);
      i += header + uz;
    }
    this.t = this.t.subarray(Math.max(0, i));
  }
}
