/**
 * Arayuz-rota uyumu: arayuz dosyalarindaki (HTML + js) her /api/... ve /stream/... basvurusu rota tablosunda vardir.
 * Adlar toplu degistirildiginde arayuzun eski bir yola bakip sessizce kirilmasini yakalar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './helpers.mjs';

const ROOT = new URL('../resources/views/web/', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'fonts' ? [] : files(p)) : /\.(html|js)$/.test(n) ? [p] : []; });

/** Olu arayuz kodu: indirme sekmesi gizli, bu uc noktalar sunucuda yok (bilerek serbest). */
const DEAD = new Set(['/api/archive', '/api/archive/:p', '/api/jobs/wipe', '/api/jobs/:p/revoke']);

test('arayuzdeki her /api ve /stream basvurusu rota tablosunda var', async () => {
  const t = await openApp();
  try {
    const patterns = t.app.router.list().map((r) => r.pattern);
    const matcher = (p) => new RegExp(`^${p.replace(/:\w+/g, '[^/]+')}$`);
    const table = patterns.map(matcher);
    const refs = new Map();
    for (const f of files(ROOT)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`]((?:\/api|\/stream)\/[^'"`?\s]*)/g)) {
        const path = m[1].replace(/\$\{[^}]*(?:\([^)]*\))?[^}]*\}/g, ':p').replace(/\/$/, '');
        refs.set(path, f.slice(ROOT.length));
      }
    }
    assert.ok(refs.size > 20, `yeterli basvuru bulunamadi (${refs.size})`);
    const missing = [...refs].filter(([path]) => !DEAD.has(path) && !table.some((re) => re.test(path))).map(([path, f]) => `${path}  (${f})`);
    assert.deepEqual(missing, [], 'rota tablosunda olmayan arayuz basvurulari');
    for (const d of DEAD) assert.ok(!table.some((re) => re.test(d.replace(':p', 'x'))), `${d} artik var; serbest listeden cikarilmali`);
  } finally { await t.close(); }
});
