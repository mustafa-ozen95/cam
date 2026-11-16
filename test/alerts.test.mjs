/** Yapay zeka (goruntu analizi) varsayilan KAPALI: sir yoksa uclar yok, algilama ve Telegram kapali, kapaliyken olay yazilmaz. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp } from './helpers.mjs';

const SECRET = 'ai-test-sirri-0123456789abcdef';

test('sir tanimsiz (varsayilan): /api/ai/* uclari yok (404)', async () => {
  const t = await openApp();
  try {
    for (const [method, path] of [['POST', '/api/ai/heartbeat'], ['POST', '/api/ai/report'], ['GET', '/api/ai/stream?channel=0'], ['GET', '/api/ai/snapshot?channel=0']]) {
      const r = await t.req(path, { method, body: method === 'POST' ? {} : undefined, bearer: 'herhangi' });
      assert.equal(r.status, 404, `${method} ${path}: ${r.status}`);
    }
  } finally { await t.close(); }
});

test('sir dosyasi (docker-compose): sir yoksa uretilir, cam-ai ile paylasilir, yeniden acilista ayni kalir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cam-ai-link-')), secretFile = join(dir, 'secret');
  try {
    const t = await openApp({ ai: { secretFile } });
    let s;
    try {
      s = readFileSync(secretFile, 'utf8').trim();
      assert.match(s, /^[0-9a-f]{64}$/);
      const hb = await t.req('/api/ai/heartbeat', { method: 'POST', body: {}, bearer: s });
      assert.equal(hb.status, 200, hb.text);
      assert.equal(hb.json.enabled, false);   // kurulu ama algilama varsayilan kapali
    } finally { await t.close(); }
    const t2 = await openApp({ ai: { secretFile } });
    try {
      assert.equal(readFileSync(secretFile, 'utf8').trim(), s);
      assert.equal((await t2.req('/api/ai/heartbeat', { method: 'POST', body: {}, bearer: s })).status, 200);
    } finally { await t2.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('varsayilan ayar: algilama ve Telegram kapali; nabiz kanal vermez; olay yazilmaz', async () => {
  const t = await openApp({ ai: { secret: SECRET } });
  try {
    await t.login('admin', 'adminparola1');
    const s = (await t.req('/api/alerts')).json;
    assert.equal(s.detection.enabled, false);
    assert.equal(s.telegram.enabled, false);
    // yanlis sir reddedilir
    assert.equal((await t.req('/api/ai/heartbeat', { method: 'POST', body: {}, bearer: 'yanlis' })).status, 401);
    const hb = await t.req('/api/ai/heartbeat', { method: 'POST', body: {}, bearer: SECRET });
    assert.equal(hb.status, 200, hb.text);
    assert.equal(hb.json.enabled, false);
    assert.deepEqual(hb.json.channels, []);   // cam-ai hicbir kamerayi izlemez
    const r = await t.req('/api/ai/report', { method: 'POST', body: { channel: 0, type: 'person', score: 0.9 }, bearer: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.notified, 'disabled');
    const [row] = await t.services.db.query('SELECT COUNT(*) AS n FROM events');
    assert.equal(Number(row.n), 0);
    // acilinca nabiz kanallari verir, olay yazilir
    assert.equal((await t.req('/api/alerts', { method: 'PUT', body: { detection: { enabled: true } } })).status, 200);
    const on = await t.req('/api/ai/heartbeat', { method: 'POST', body: {}, bearer: SECRET });
    assert.equal(on.json.enabled, true);
    const r2 = await t.req('/api/ai/report', { method: 'POST', body: { channel: 0, type: 'person', score: 0.9 }, bearer: SECRET });
    assert.ok(r2.json.id, r2.text);
    const [row2] = await t.services.db.query('SELECT COUNT(*) AS n FROM events');
    assert.equal(Number(row2.n), 1);
  } finally { await t.close(); }
});
