/** Canli akis gunlugu: kimlik bilgisi maskeleme, satir siniri, kopma nedeni (ffmpeg kapandi / veri kesildi). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedLog, redact } from '../src/drivers/feed-log.mjs';
import { Mp4Feed } from '../src/drivers/mp4-stream.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gunlukte parola yok: rtsp://kullanici:parola@ ve Xiongmai user=/password=', () => {
  assert.equal(redact('rtsp://admin:Gizli%40123@10.0.0.5:554/unicast/c1/s1/live: Connection refused'), 'rtsp://***@10.0.0.5:554/unicast/c1/s1/live: Connection refused');
  assert.equal(redact('rtsp://10.0.0.6:554/user=admin&password=Gizli&channel=1&stream=1.sdp'), 'rtsp://10.0.0.6:554/user=***&password=***&channel=1&stream=1.sdp');
});

test('ffmpeg satirlari: parcali gelis birlesir, 60 sn icinde en cok 5 satir, kapanista son satirlar ve atlanan sayisi', () => {
  const out = [], g = new FeedLog('NVR · D1 · kanal 1 · Extra1', (s) => out.push(s));
  g.stderr('[rtsp @ 0x1] satir 1\nsat'); g.stderr('ir 2\n');
  for (let i = 3; i <= 9; i++) g.stderr(`satir ${i}\n`);
  assert.equal(out.length, 5);
  assert.match(out[1], /^akis \[NVR · D1 · kanal 1 · Extra1\] ffmpeg: satir 2$/);
  g.end('ffmpeg kapandı (kod 1)');
  assert.match(out[5], /4 satır daha yazılmadı/);
  assert.match(out[6], /kapandı: ffmpeg kapandı \(kod 1\) \| son ffmpeg satırları: satir 5 ‖ satir 6 ‖ satir 7 ‖ satir 8 ‖ satir 9$/);
});

test('ffmpeg hatayla kapanirsa neden ve ffmpeg satiri gunlukte (cihaz baglantiyi kesti)', async () => {
  const out = [];
  const y = new Mp4Feed({ ffmpeg: process.execPath, args: [], label: 'deneme', log: (s) => out.push(s) });
  // ffmpeg yerine node: -hide_banner bilinmeyen secenek, stderr'e yazip kod 9 ile cikar
  y.start(); await y.ready;
  assert.ok(y.stopped);
  const end = out.find((s) => s.includes('kapandı:'));
  assert.match(end, /ffmpeg kapandı \(kod \d+\) — cihaz bağlantıyı kesti/);
  assert.match(end, /son ffmpeg satırları: .*hide_banner/);
  assert.match(out[0], /^akis \[deneme\] başladı$/);
});

test('ffmpeg calisirken veri kesilirse "cihaz veri gondermeyi birakti" yazilir', async () => {
  // sahte ffmpeg: calisir ama hic veri vermez (cihaz baglantiyi tutup gondermeyi birakmis gibi)
  const dir = mkdtempSync(join(tmpdir(), 'cam-feed-')), fake = join(dir, 'ffmpeg');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const out = [];
  try {
    const y = new Mp4Feed({ ffmpeg: fake, args: [], label: 'deneme', log: (s) => out.push(s), stopDuration: 100 }).start();
    y.init = Buffer.alloc(1); y.lastZ = Date.now();   // ilk goruntu gelmis gibi
    await y.ready;
    assert.ok(y.stopped);
    assert.match(out.at(-1), /kapandı: cihaz veri göndermeyi bıraktı: \d+\.\d sn veri yok, bağlantı açık/);
    assert.ok(!out.some((s) => s.includes('ffmpeg kapandı')), 'panelin kapattigi ffmpeg ikinci neden yazdirmaz');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
