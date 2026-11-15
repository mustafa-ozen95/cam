/**
 * Algilama ve bildirim (Ayarlar -> Bildirim): ayar okuma/yazma ve Telegram denemesi alert.manage ister; olay listesi event.read.
 * /api/ai/*: cam-ai konteyneri (uye degil). Kimlik: Authorization: Bearer <CAM_AI_SECRET>; sir tanimsizsa uc noktalar yok (404).
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, json, readBody } from '../core/http.mjs';

export function alertsController({ alerts, devices, auditLog, config }) {
  const secret = config.ai.secret ? createHash('sha256').update(config.ai.secret).digest() : null;
  const worker = (ctx) => {
    if (!secret) throw new HttpError(404, 'Bulunamadı', 'NOT_FOUND');
    const m = /^Bearer\s+(.+)$/i.exec(String(ctx.req.headers.authorization ?? ''));
    if (!m || !timingSafeEqual(createHash('sha256').update(m[1].trim()).digest(), secret)) throw new HttpError(401, 'Kimlik doğrulanamadı', 'UNAUTHORIZED');
  };
  const readBinary = (req, limit) => new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (b) => { size += b.length; if (size > limit) { req.destroy(); reject(new HttpError(413, 'Gövde çok büyük', 'BODY_TOO_LARGE')); } else parts.push(b); });
    req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject);
  });
  const channelOf = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    async settings(ctx) { return json(ctx.res, 200, alerts.view()); },
    async save(ctx) {
      const g = await readBody(ctx.req, 20_000);
      const r = await alerts.save(g);
      // jeton degeri gunluge yazilmaz; yalniz degistigi
      auditLog.write('alert-settings', ctx.principal.auditActor, ctx.req, { telegram: g.telegram ? Object.keys(g.telegram) : [], detection: g.detection ? Object.keys(g.detection) : [] });
      return json(ctx.res, 200, r);
    },
    async test(ctx) {
      const g = await readBody(ctx.req, 20_000);
      const channel = channelOf(g.channel);
      if (channel !== undefined) ctx.needChannel(channel);
      return json(ctx.res, 200, await alerts.test({ ...g, channel }));
    },
    async chats(ctx) {
      const g = await readBody(ctx.req, 20_000);
      return json(ctx.res, 200, { chats: await alerts.chats(g.token) });
    },
    async events(ctx) {
      const channel = channelOf(ctx.q.get('channel'));
      return json(ctx.res, 200, await alerts.list({
        channel: Number.isInteger(channel) ? channel : undefined, type: ctx.q.get('type') || undefined, before: ctx.q.get('before') || undefined,
        limit: Number(ctx.q.get('limit')) || 100, allowed: (k) => ctx.principal.channelAllowed(k),
      }));
    },

    /** Canli algilama: cam-ai'nin isaretli kareleri (kutu, iskelet, durum) MJPEG; kare diske inmez. */
    async preview(ctx) {
      const k = Number(ctx.q.get('channel'));
      if (!Number.isInteger(k) || k < 0) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
      ctx.needChannel(k);
      ctx.res.raw = true;
      ctx.res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' });
      alerts.watch(k, ctx.res);
    },

    /** Canli goruntu ustu algilama katmani (SSE): ?channels=1,2 (yalniz yetkili kanallar). */
    async overlay(ctx) {
      const ks = String(ctx.q.get('channels') ?? '').split(',').map(Number).filter((k) => Number.isInteger(k) && k >= 0 && ctx.principal.channelAllowed(k)).slice(0, 64);
      ctx.res.raw = true;
      ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      alerts.overlayWatch(ctx.res, ks);
    },

    // ---------- cam-ai ----------
    async overlayPush(ctx) {
      worker(ctx);
      const g = await readBody(ctx.req, 200_000), k = Number(g.channel);
      if (!Number.isInteger(k) || k < 0 || k >= (devices.group.channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
      return json(ctx.res, 200, alerts.overlay(k, { t: Date.now(), age: Math.min(5, Math.max(0, Number(g.age) || 0)), items: Array.isArray(g.items) ? g.items.slice(0, 64) : [] }));
    },
    async framePush(ctx) {
      worker(ctx);
      const k = Number(ctx.q.get('channel'));
      if (!Number.isInteger(k) || k < 0 || k >= (devices.group.channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
      const jpeg = await readBinary(ctx.req, 1_000_000);
      return json(ctx.res, 200, alerts.preview(k, jpeg));
    },
    async heartbeat(ctx) { worker(ctx); const g = await readBody(ctx.req, 50_000); return json(ctx.res, 200, alerts.heartbeat(g.stats)); },
    async report(ctx) { worker(ctx); const g = await readBody(ctx.req, 1_500_000); return json(ctx.res, 200, await alerts.report(g)); },
    /** Kanalin alt akisi ham JPEG dizisi olarak (paylasilan akis: izleyicilerle ayni cihaz baglantisi). */
    async stream(ctx) {
      worker(ctx);
      const k = Number(ctx.q.get('channel'));
      if (!Number.isInteger(k) || k < 0 || k >= (devices.group.channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
      const y = devices.group.feed(k, 'Extra1', 480);
      ctx.res.raw = true;
      ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', Connection: 'close' });
      y.subscriber(ctx.res);
      y.ready.then(() => { if (y.error) ctx.res.end(); });
    },
    /** Ana akistan tek tam cozunurluklu kare (plaka okuma): yalniz tetiklenince istenir, diske inmez. */
    async snapshot(ctx) {
      worker(ctx);
      const k = Number(ctx.q.get('channel'));
      if (!Number.isInteger(k) || k < 0 || k >= (devices.group.channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
      const y = devices.group.feed(k, 'Main', 0);
      clearTimeout(y.idleTimer);
      await y.firstFrame();
      for (let t = 0; (y.frameCounter ?? 0) < 6 && t < 50 && !y.stopped; t++) await new Promise((r) => setTimeout(r, 100));
      const frame = y.last;
      if (!y.subscribers.size) y.idleTimer = setTimeout(() => y.stop(), 15000);   // art arda isteklerde akis acik kalir
      if (!frame) throw new HttpError(503, y.error ?? 'Kameradan görüntü alınamadı', 'UNAVAILABLE');
      ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); ctx.res.end(frame);
    },
  };
}
