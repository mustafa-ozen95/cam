/**
 * Algilama olaylari ve bildirimler.
 *
 *  - Ayarlar tek belge (settings: 'alerts'): Telegram (bot jetonu gizli anahtarla sifreli), algilama turleri, kanallar,
 *    bekleme suresi, etkin saatler. Jeton yanitta hic gecmez; yalniz "tanimli mi".
 *  - Olaylar `events` tablosunda (goc 5). Goruntu SAKLANMAZ: kare yalniz Telegram'a gider (sunucu diskine kayit inmez).
 *  - cam-ai her 15 sn'de bir nabiz atar (heartbeat) ve yanitta guncel algilama ayarini alir; olaylari report ile yazar.
 *  - Bildirim karari burada: tur kapali / saat disi / ayni kanal+tur icin bekleme suresi dolmadi -> yazilir ama gonderilmez.
 */
import { randomBytes } from 'node:crypto';
import { alertSecretKey, seal, unseal } from '../core/crypto-labels.mjs';
import { HttpError } from '../core/http.mjs';

export const EVENT_TYPES = {
  person: { tr: 'İnsan algılandı', icon: '🧍' },
  fall: { tr: 'Düşme algılandı', icon: '⚠️' },
  collapse: { tr: 'Hareketsiz yatan kişi (bayılma olabilir)', icon: '🚨' },
  fight: { tr: 'Kavga / saldırgan hareket olabilir', icon: '🥊' },
  motion: { tr: 'Hareket algılandı', icon: '👣' },
  approach: { tr: 'Beyaz araca yaklaşan kişi', icon: '🚗' },
};
const DEFAULTS = {
  telegram: { enabled: false, token: null, chat: '', thread: '', photo: true },
  detection: {
    enabled: false, channels: [], types: { person: true, fall: true, collapse: true, fight: false, motion: false, approach: true },
    cooldownSec: 120, collapseSec: 20, minScore: 0.5, fps: 4, activeFrom: '', activeTo: '',
  },
};
const KEEP_DAYS = 90;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const clamp = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Number(v))) : d);
const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const CRLF = '\r\n';
const writePart = (r, jpeg) => { r.write(`--frame${CRLF}Content-Type: image/jpeg${CRLF}Content-Length: ${jpeg.length}${CRLF}${CRLF}`); r.write(jpeg); r.write(CRLF); };

export class AlertService {
  constructor({ db, settings, secret, devices, config }) {
    Object.assign(this, { db, settings, devices, setting: config.ai });
    this.key = alertSecretKey(secret);
    this.lastSent = new Map();     // `${kanal}|${tur}` -> ms
    this.worker = null;            // son nabiz { at, stats }
    this.previews = new Map();     // kanal -> { jpeg, at } (yalniz bellekte: isaretli son kare)
    this.viewers = new Map();      // kanal -> Set(res) canli algilama izleyicileri
  }

  async load() {
    const saved = (await this.settings.read('alerts')) ?? {};
    this.doc = { telegram: { ...DEFAULTS.telegram, ...saved.telegram }, detection: { ...DEFAULTS.detection, ...saved.detection, types: { ...DEFAULTS.detection.types, ...saved.detection?.types } } };
    this.pruneTimer = setInterval(() => this.prune().catch(() => {}), 6 * 3600_000); this.pruneTimer.unref?.();
    return this;
  }
  close() { clearInterval(this.pruneTimer); }

  token() { try { return this.doc.telegram.token ? unseal(this.key, this.doc.telegram.token) : ''; } catch { return ''; } }
  channelName(k) { const g = this.devices.group; return g.nameOverrides?.[k] || g.channelNames?.[k] || `Kanal ${k + 1}`; }

  /** Cihazlara ait, bos olmayan kanallar (son bilinen bilgiye gore). */
  channelList() {
    const g = this.devices.group, out = [];
    for (const c of g.devices ?? []) { const b = g.lastInfo?.get(c.id); for (let i = 0; i < c.channelCount; i++) if (!b?.channelEmpty?.[i]) out.push(c.startIndex + i); }
    return out;
  }

  /** Arayuze giden hal: jeton yok, yalniz tanimli olup olmadigi. */
  view() {
    const { token, ...telegram } = this.doc.telegram;
    return {
      telegram: { ...telegram, tokenSet: !!token }, detection: this.doc.detection, types: EVENT_TYPES,
      worker: this.worker ? { lastSeenSec: Math.round((Date.now() - this.worker.at) / 1000), stats: this.worker.stats } : null,
      aiReady: !!this.setting.secret,
      channels: this.channelList().map((k) => ({ channel: k, name: this.channelName(k) })),
    };
  }

  async save(g) {
    const t = this.doc.telegram, d = this.doc.detection;
    if (g.telegram) {
      const x = g.telegram;
      if (x.enabled !== undefined) t.enabled = !!x.enabled;
      if (x.photo !== undefined) t.photo = !!x.photo;
      if (x.chat !== undefined) t.chat = String(x.chat).trim().slice(0, 64);
      if (x.thread !== undefined) { const s = String(x.thread).trim(); if (s && !/^\d{1,12}$/.test(s)) throw new HttpError(400, 'Konu (thread) kimliği sayı olmalı', 'INVALID_REQUEST'); t.thread = s; }
      if (x.token !== undefined) {
        const s = String(x.token).trim();
        if (s && !/^\d{5,15}:[\w-]{30,60}$/.test(s)) throw new HttpError(400, 'Bot jetonu biçimi geçersiz (BotFather’ın verdiği 123456:ABC… değeri)', 'INVALID_REQUEST');
        t.token = s ? seal(this.key, s) : null;
      }
      if (t.enabled && (!t.token || !t.chat)) throw new HttpError(400, 'Telegram açmak için bot jetonu ve kanal/sohbet gerekli', 'INVALID_REQUEST');
    }
    if (g.detection) {
      const x = g.detection;
      if (x.enabled !== undefined) d.enabled = !!x.enabled;
      if (Array.isArray(x.channels)) d.channels = [...new Set(x.channels.map(Number).filter((k) => Number.isInteger(k) && k >= 0 && k < 256))].sort((a, b) => a - b);
      if (x.types) for (const k of Object.keys(EVENT_TYPES)) if (x.types[k] !== undefined) d.types[k] = !!x.types[k];
      if (x.cooldownSec !== undefined) d.cooldownSec = clamp(x.cooldownSec, 10, 86400, 120);
      if (x.collapseSec !== undefined) d.collapseSec = clamp(x.collapseSec, 5, 600, 20);
      if (x.minScore !== undefined) d.minScore = clamp(x.minScore, 0.2, 0.95, 0.5);
      if (x.fps !== undefined) d.fps = clamp(x.fps, 1, 10, 4);
      for (const f of ['activeFrom', 'activeTo']) if (x[f] !== undefined) { const s = String(x[f]).trim(); if (s && !TIME_RE.test(s)) throw new HttpError(400, 'Saat SS:DD biçiminde olmalı', 'INVALID_REQUEST'); d[f] = s; }
    }
    await this.settings.write('alerts', this.doc);
    return this.view();
  }

  // ---------------------------------------------------------------- cam-ai
  /** Nabiz: istatistigi saklar, analiz icin guncel ayari dondurur. */
  heartbeat(stats) {
    this.worker = { at: Date.now(), stats: stats && typeof stats === 'object' ? stats : null };
    const d = this.doc.detection, real = this.channelList();
    const channels = d.channels.length ? d.channels.filter((k) => real.includes(k)) : real;
    return { enabled: d.enabled, channels: d.enabled ? channels.map((k) => ({ channel: k, name: this.channelName(k) })) : [], types: d.types, collapseSec: d.collapseSec, minScore: d.minScore, fps: d.fps };
  }

  /** Olay: { channel, type, score, detail, image (base64 JPEG, istege bagli) }. Satir yazilir, bildirim arka planda. */
  async report(g) {
    const channel = Number(g.channel), type = String(g.type ?? '');
    if (!Number.isInteger(channel) || channel < 0 || channel >= (this.devices.group.channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
    if (!EVENT_TYPES[type]) throw new HttpError(400, 'olay türü geçersiz', 'INVALID_REQUEST');
    const score = clamp(g.score, 0, 1, null), detail = g.detail ? String(g.detail).slice(0, 500) : null;
    const image = typeof g.image === 'string' && g.image.length < 1_400_000 ? Buffer.from(g.image, 'base64') : null;
    const ev = { id: randomBytes(8).toString('hex'), ts: new Date().toISOString(), channel, type, score, detail };
    const why = this.#decision(ev);
    await this.db.pool.query('INSERT INTO events (id, ts, channel, type, score, detail, notified) VALUES (?, ?, ?, ?, ?, ?, ?)', [ev.id, ev.ts, channel, type, score, detail, why ?? 'sending']);
    if (!why) {
      this.lastSent.set(`${channel}|${type}`, Date.now());
      this.#send(ev, image).then(() => 'sent', (e) => { console.error(`Telegram: ${e.message}`); return 'error'; })
        .then((r) => this.db.pool.query('UPDATE events SET notified = ? WHERE id = ?', [r, ev.id])).catch(() => {});
    }
    return { id: ev.id, notified: why ?? 'sending' };
  }

  #decision(ev) {
    const t = this.doc.telegram, d = this.doc.detection;
    if (!t.enabled || !t.token || !t.chat) return 'off';
    if (!d.types[ev.type]) return 'off';
    if (ev.score !== null && ev.score < d.minScore) return 'low';
    if (!this.#activeNow()) return 'schedule';
    const last = this.lastSent.get(`${ev.channel}|${ev.type}`) ?? 0;
    if (Date.now() - last < d.cooldownSec * 1000) return 'cooldown';
    return null;
  }
  #activeNow() {
    const { activeFrom: a, activeTo: b } = this.doc.detection;
    if (!a || !b || a === b) return true;
    const n = new Date().toTimeString().slice(0, 5);   // konteyner saat dilimi (TZ)
    return a < b ? n >= a && n < b : n >= a || n < b;   // gece yarisini asan aralik (22:00-07:00)
  }

  /** cam-ai'nin isaretli karesi: bellekte tutulur, izleyicilere MJPEG olarak gider. Yanit: izleyen var mi (yoksa seyrek gonderir). */
  preview(k, jpeg) {
    this.previews.set(k, { jpeg, at: Date.now() });
    const set = this.viewers.get(k);
    for (const r of set ?? []) if (!r.writableNeedDrain) writePart(r, jpeg);
    return { watch: (set?.size ?? 0) > 0 };
  }
  watch(k, res) {
    if (!this.viewers.has(k)) this.viewers.set(k, new Set());
    const set = this.viewers.get(k); set.add(res);
    const p = this.previews.get(k);
    if (p && Date.now() - p.at < 10_000) writePart(res, p.jpeg);
    res.on('close', () => set.delete(res));
  }

  // ---------------------------------------------------------------- Telegram
  caption(ev) {
    const type = EVENT_TYPES[ev.type];
    const when = new Date(ev.ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' });
    return [`${type.icon} <b>${escape(type.tr)}</b>`, `Kamera: ${escape(this.channelName(ev.channel))} (K${ev.channel + 1})`, `Saat: ${escape(when)}`,
      ev.score !== null ? `Güven: %${Math.round(ev.score * 100)}` : null, ev.detail ? escape(ev.detail) : null].filter(Boolean).join('\n');
  }
  async #call(method, form, token = this.token()) {
    if (!token) throw new Error('bot jetonu yok');
    const r = await fetch(`${this.setting.telegramApi}/bot${token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
    const o = await r.json().catch(() => ({}));
    if (!o.ok) throw new Error(o.description ?? `HTTP ${r.status}`);   // aciklama jetonu icermez
    return o.result;
  }
  async #send(ev, image, target = this.doc.telegram) {
    const f = new FormData();
    f.set('chat_id', target.chat); f.set('parse_mode', 'HTML');
    if (target.thread) f.set('message_thread_id', target.thread);
    if (image && target.photo) { f.set('caption', this.caption(ev)); f.set('photo', new Blob([image], { type: 'image/jpeg' }), 'olay.jpg'); return this.#call('sendPhoto', f); }
    f.set('text', this.caption(ev)); return this.#call('sendMessage', f);
  }

  /** Deneme mesaji: kayitli ayarla (ya da formdaki henuz kaydedilmemis degerlerle); istenirse kanalin anlik karesiyle. */
  async test({ chat, thread, token, channel } = {}) {
    const t = this.doc.telegram;
    const target = { chat: String(chat ?? t.chat).trim(), thread: String(thread ?? t.thread ?? '').trim(), photo: true };
    const tk = token ? String(token).trim() : this.token();
    if (!tk || !target.chat) throw new HttpError(400, 'Bot jetonu ve kanal/sohbet gerekli', 'INVALID_REQUEST');
    let image = null;
    if (Number.isInteger(channel)) image = await this.snapshot(channel).catch(() => null);
    const ev = { ts: new Date().toISOString(), channel: Number.isInteger(channel) ? channel : 0, type: 'person', score: null, detail: 'Deneme bildirimi: kamera paneli Telegram ayarı çalışıyor.' };
    const f = new FormData();
    f.set('chat_id', target.chat); f.set('parse_mode', 'HTML');
    if (target.thread) f.set('message_thread_id', target.thread);
    const text = `✅ <b>Deneme bildirimi</b>\n${image ? `Kamera: ${escape(this.channelName(ev.channel))} (K${ev.channel + 1})\n` : ''}Kamera paneli Telegram ayarı çalışıyor.`;
    try {
      if (image) { f.set('caption', text); f.set('photo', new Blob([image], { type: 'image/jpeg' }), 'deneme.jpg'); await this.#call('sendPhoto', f, tk); }
      else { f.set('text', text); await this.#call('sendMessage', f, tk); }
    } catch (e) { throw new HttpError(502, `Telegram: ${e.message}`, 'TELEGRAM'); }
    return { result: 'sent', photo: !!image };
  }

  /** Botun gordugu sohbetler (getUpdates): kanal kimligini bulmak icin. Bot kanala yonetici eklenip bir ileti atilmis olmali. */
  async chats(token) {
    let list;
    try { list = await this.#call('getUpdates', (() => { const f = new FormData(); f.set('allowed_updates', '["message","channel_post","my_chat_member"]'); return f; })(), token ? String(token).trim() : this.token()); }
    catch (e) { throw new HttpError(502, `Telegram: ${e.message}`, 'TELEGRAM'); }
    const found = new Map();
    for (const u of list ?? []) {
      const c = (u.message ?? u.channel_post ?? u.my_chat_member ?? {}).chat;
      if (c) found.set(String(c.id), { id: String(c.id), title: c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ') ?? '', type: c.type, username: c.username ?? '' });
    }
    return [...found.values()];
  }

  /** Kanalin tek karesi (deneme bildirimi icin): paylasilan alt akistan; dinleyici yoksa akis birazdan kapanir. */
  async snapshot(channel) {
    const y = this.devices.group.feed(channel, 'Extra1', 480);
    await y.ready;
    for (let t = 0; (y.frameCounter ?? 0) < 4 && t < 50 && !y.stopped; t++) await new Promise((r) => setTimeout(r, 100));
    const frame = y.last;
    if (!y.subscribers.size) y.idleTimer = setTimeout(() => y.stop(), 4000);
    if (!frame) throw new Error('kare yok');
    return frame;
  }

  // ---------------------------------------------------------------- olay listesi
  async list({ channel, type, before, limit = 100, allowed = () => true }) {
    const where = [], v = [];
    if (Number.isInteger(channel)) { where.push('channel = ?'); v.push(channel); }
    if (type && EVENT_TYPES[type]) { where.push('type = ?'); v.push(type); }
    if (before) { where.push('ts < ?'); v.push(String(before)); }
    const [rows] = await this.db.pool.query(`SELECT id, ts, channel, type, score, detail, notified FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`, [...v, Math.min(500, Math.max(1, limit)) * 2]);
    return rows.filter((r) => allowed(r.channel)).slice(0, limit).map((r) => ({ ...r, score: r.score === null ? null : Number(r.score), name: this.channelName(r.channel) }));
  }
  async prune() { await this.db.pool.query('DELETE FROM events WHERE ts < ?', [new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()]); }
}
