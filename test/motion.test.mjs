/**
 * Kayittan oynatma cizelgesindeki hareket isaretleri: cihaz yanitindan araliklar (cihaza baglanmadan).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { univiewMotion } from '../src/drivers/uniview.mjs';
import { hikMotionMatch } from '../src/drivers/hikvision.mjs';

test('Uniview: yalniz hareket biti (4) olan parcalar; epoch cihaz saat dilimiyle yerel saate', () => {
  const p = [
    { RecordType: 128, Begin: 1792397035, End: 1792397195 },   // surekli
    { RecordType: 132, Begin: 1792397195, End: 1792397279 },   // surekli + hareket
    { RecordType: 132, Begin: 1792397300, End: 1792397300 },   // bos parca
  ];
  assert.deepEqual(univiewMotion(p, 10800), [{ from: '2026-10-19 11:06:35', to: '2026-10-19 11:07:59' }]);
  assert.deepEqual(univiewMotion(undefined, 0), []);
});

test('Uniview: son kayit (60 sn) dusulur; 64 sn parca 4 sn hareket', () => {
  const p = [{ RecordType: 132, Begin: 1000, End: 1064 }, { RecordType: 132, Begin: 2000, End: 2300 }];
  assert.deepEqual(univiewMotion(p, 0, 60), [
    { from: '1970-01-01 00:16:40', to: '1970-01-01 00:16:44' },
    { from: '1970-01-01 00:33:20', to: '1970-01-01 00:37:20' },
  ]);
});

test('Uniview: pencere sinirlari — basta kesilip hareketi once biten atilir, sonda kesilen kirpilmaz, cok kisa 1 sn kalir', () => {
  const timeRange = [1000, 5000];
  const p = [
    { RecordType: 132, Begin: 1000, End: 1040 },   // pencereden once baslamis, hareket 980'de bitmis: atilir
    { RecordType: 132, Begin: 1000, End: 1100 },   // pencereden once baslamis, hareket 1040'a kadar: kalir
    { RecordType: 132, Begin: 3000, End: 3030 },   // kisa (kanal ayari farkli olabilir): 1 sn isaret
    { RecordType: 132, Begin: 4900, End: 5000 },   // pencere sonunda kesik: hareket suruyor olabilir, dusulmez
  ];
  assert.deepEqual(univiewMotion(p, 0, 60, timeRange).map((x) => [x.from.slice(11), x.to.slice(11)]), [
    ['00:16:40', '00:17:20'], ['00:50:00', '00:50:01'], ['01:21:40', '01:23:20'],
  ]);
});

test('Hikvision: kanal basina baslangic/bitis eslesir; sirasiz gelse de', () => {
  const m = hikMotionMatch([
    { channel: 7, begin: false, t: '2026-10-19 10:00:20' },
    { channel: 7, begin: true, t: '2026-10-19 10:00:05' },
    { channel: 2, begin: true, t: '2026-10-19 11:00:00' },
    { channel: 2, begin: false, t: '2026-10-19 11:00:09' },
  ], '2026-10-19 00:00:00', '2026-10-19 23:59:59');
  assert.deepEqual(m.get(7), [{ from: '2026-10-19 10:00:05', to: '2026-10-19 10:00:20' }]);
  assert.deepEqual(m.get(2), [{ from: '2026-10-19 11:00:00', to: '2026-10-19 11:00:09' }]);
});

test('Hikvision: bitisi gelmeyen baslangic aralik sonuna, baslangici disarida kalan bitis aralik basindan', () => {
  const m = hikMotionMatch([
    { channel: 1, begin: false, t: '2026-10-19 00:00:04' },
    { channel: 1, begin: true, t: '2026-10-19 23:59:50' },
    { channel: 1, begin: true, t: '2026-10-19 23:59:55' },   // ikinci baslangic: acik araligi bozmaz
  ], '2026-10-19 00:00:00', '2026-10-19 23:59:59');
  assert.deepEqual(m.get(1), [{ from: '2026-10-19 00:00:00', to: '2026-10-19 00:00:04' }, { from: '2026-10-19 23:59:50', to: '2026-10-19 23:59:59' }]);
});
