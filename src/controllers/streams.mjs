/** Canli akis, anlik goruntu, kayit listesi, kayittan oynatma, indirme (izin + kapsam + eszamanli akis siniri). */
import { DATE_RE, HttpError, DATETIME_RE, json } from '../core/http.mjs';

export function streamController({ devices, permissions, auditLog }) {
  const group = () => devices.group;
  /**
   * AYNI KISI + AYNI KANAL = TEK OYNATMA. Zaman cizelgesinde ileri atlayan oynatici ayni kanal icin yeni istek
   * acar; eskisinin baglantisi sunucuya kapandigi haber gelene kadar cihazdaki yuvayi tutuyordu ve 4 kamerada hizli
   * atlamada yeni istekler 503 aliyordu. Yeni istek gelince eskisi once kapatilir ve yuvasi bosalinca devam edilir.
   */
  const playbacks = new Map();   // `${asal.kimlik}|${kanal}` -> res
  const closePrevious = async (key) => {
    const old = playbacks.get(key);
    if (!old || old.destroyed || old.writableEnded) return;
    await new Promise((resolve) => { const z = setTimeout(resolve, 1000); old.once('close', () => { clearTimeout(z); setImmediate(resolve); }); old.destroy(); });
  };
  const getChannel = (ctx) => {
    const k = Number(ctx.q.get('channel') ?? ctx.param.channel ?? 0);
    if (!Number.isInteger(k) || k < 0 || k >= (group().channelTotal ?? 0)) throw new HttpError(400, 'kanal geçersiz', 'INVALID_REQUEST');
    return ctx.needChannel(k);
  };
  const mjpegHeader = (ctx) => { ctx.res.raw = ctx.q.has('raw'); ctx.res.writeHead(200, { 'Content-Type': ctx.res.raw ? 'application/octet-stream' : 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' }); };
  return {
    async live(ctx) {
      const channel = getChannel(ctx);
      const type = ['Extra1', 'Mini', 'Main'].includes(ctx.q.get('type')) ? ctx.q.get('type') : 'Main';
      // g=full: olceksiz ana akis (tam ekran); fps: izgara kare hizi (surucu izinli degerlerle sinirlar).
      const g = ctx.q.get('g') === 'full' && type === 'Main' ? 0 : Number(ctx.q.get('g')) || 640;
      // Ayni akisi izleyen ikinci sekme hak harcamaz: sunucudaki tek baglantiyi paylasir.
      const release = permissions.openStream(ctx.principal, `live:${channel}/${type}/${g}/${Number(ctx.q.get('fps')) || ''}`); ctx.res.on('close', release);
      const y = group().feed(channel, type, g, Number(ctx.q.get('fps')) || undefined);
      mjpegHeader(ctx); y.subscriber(ctx.res);
      y.ready.then(() => { if (y.error) ctx.res.end(); });
    },
    /**
     * Canli MP4. Baslik, baslangic gelince yazilir: X-Codec tarayicinin oynatip oynatamayacagini sorar; oynatamazsa
     * (Chrome'da H.265) arayuz h264=1 ile yeniden ister ve sunucu kaynak kalitede H.264'e cevirir. Alt akis tek (Extra1).
     * 501: surucu MP4 vermiyor (Xiongmai DVR).
     */
    async liveMp4(ctx) {
      const channel = getChannel(ctx);
      const type = ctx.q.get('type') === 'Main' ? 'Main' : 'Extra1';
      const convert = ctx.q.get('h264') === '1';
      const release = permissions.openStream(ctx.principal, `mp4:${channel}/${type}${convert ? '/h264' : ''}`); ctx.res.on('close', release);
      const y = group().feedMp4(channel, type, convert);
      if (!y) { release(); return json(ctx.res, 501, { error: 'Bu cihaz MP4 akışı vermiyor', code: 'NO_MP4' }); }
      await y.ready;
      if (ctx.res.destroyed) return;
      if (!y.init || y.stopped) return json(ctx.res, 502, { error: y.error ?? 'Kameradan görüntü gelmedi', code: 'NO_STREAM' });
      ctx.res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Codec': y.codec, 'Cache-Control': 'no-store', Connection: 'close' });
      y.subscriber(ctx.res);
    },
    async snapshot(ctx) {
      const y = group().feed(getChannel(ctx), 'Main', 0);   // goruntu al: kameranin tam cozunurlugu (olceksiz)
      await y.firstFrame();
      for (let t = 0; (y.frameCounter ?? 0) < 6 && t < 50 && !y.stopped; t++) await new Promise((r) => setTimeout(r, 100));   // ilk kareler bozuk olabilir
      const frame = y.last;
      if (!frame) throw new Error(y.error ?? 'Kameradan görüntü alınamadı (akış başlamadı)');
      ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); ctx.res.end(frame);
      if (!y.subscribers.size) y.idleTimer = setTimeout(() => y.stop(), 4000);
    },
    async records(ctx) {
      const day = ctx.q.get('day');
      if (!DATE_RE.test(day ?? '')) return json(ctx.res, 400, { error: 'gun geçersiz', code: 'INVALID_REQUEST' });
      const day2 = ctx.q.get('dayEnd') || day;
      if (!DATE_RE.test(day2) || day2 < day || (Date.parse(day2) - Date.parse(day)) / 864e5 > 30) return json(ctx.res, 400, { error: 'gün aralığı geçersiz (en çok 31 gün)', code: 'INVALID_REQUEST' });
      return json(ctx.res, 200, await group().records(getChannel(ctx), `${day} 00:00:00`, `${day2} 23:59:59`));
    },
    /** Bir gunun hareketli araliklari (oynatma cizelgesinde isaret): [{bas, bit}]. */
    async motions(ctx) {
      const day = ctx.q.get('day');
      if (!DATE_RE.test(day ?? '')) return json(ctx.res, 400, { error: 'gun geçersiz', code: 'INVALID_REQUEST' });
      return json(ctx.res, 200, await group().motions(getChannel(ctx), `${day} 00:00:00`, `${day} 23:59:59`));
    },
    async play(ctx) {
      const from = ctx.q.get('from'), to = ctx.q.get('to');
      if (!DATETIME_RE.test(from ?? '') || !DATETIME_RE.test(to ?? '')) return json(ctx.res, 400, { error: 'zaman geçersiz', code: 'INVALID_REQUEST' });
      const channel = getChannel(ctx);
      const key = `${ctx.principal.identity}|${channel}`;
      await closePrevious(key);
      if (!group().canPlay(channel)) { ctx.res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' }); return ctx.res.end(JSON.stringify({ error: 'Cihaz meşgul, birazdan tekrar deneyin', code: 'BUSY' })); }
      const release = permissions.openStream(ctx.principal); ctx.res.on('close', release);
      playbacks.set(key, ctx.res); ctx.res.on('close', () => { if (playbacks.get(key) === ctx.res) playbacks.delete(key); });
      auditLog.write('playback', ctx.principal.auditActor, ctx.req, { channel, from, to });
      mjpegHeader(ctx);
      group().playMjpeg(ctx.res, channel, from, to, Number(ctx.q.get('g')) || 960);
    },
    async download(ctx) {
      const channel = getChannel(ctx), file = ctx.q.get('file') ?? '', from = ctx.q.get('from'), to = ctx.q.get('to');
      if (!/^\/[\w\/.\-\[\]@]+\.h264$/.test(file) || file.includes('..') || !DATETIME_RE.test(from ?? '') || !DATETIME_RE.test(to ?? '')) return json(ctx.res, 400, { error: 'kayıt geçersiz', code: 'INVALID_REQUEST' });
      const name = group().downloadName(channel, { name: file, from, to });
      const release = permissions.openStream(ctx.principal); ctx.res.on('close', release);       // indirme de eszamanli akis hakkindan sayilir (canli/oynat gibi)
      auditLog.write('download-request', ctx.principal.auditActor, ctx.req, { channel, from, to, file: name });
      await group().pipeDownload(ctx.res, channel, { name: file, from, to }, name, (r) => auditLog.write(r.ok ? 'download-complete' : 'download-partial', ctx.principal.auditActor, ctx.req, { file: name, byte: r.byte }));
    },
  };
}
