/**
 * EYS tasarimi BIREBIR: web/css/eys ve web/js/eys EYS'den kopyadir (scripts/eys-sync.mjs), elle degistirilmez.
 *  - OZET.json'daki her dosyanin sha256'si yeniden hesaplanir; elle yapilan degisiklik burada yakalanir.
 *  - camera.css yalniz EKLER: EYS'nin tanimladigi bir seciciyi yeniden tanimlayamaz (ayni secici metni yasak;
 *    .detail--genis gibi yeni degistiriciler serbest).
 * Bagimlilik yok: secici ayristirma bilerek basit (yorumlar atilir, "{" oncesindeki baslangiclar virgulle bolunur).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'views', 'web');
const SUMMARY = JSON.parse(readFileSync(join(WEB, 'css', 'eys', 'OZET.json'), 'utf8'));

/** CSS metnindeki secici listesi (at-kurallari ve keyframe adimlari haric), bosluklari tekle indirilmis. */
export function selectors(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const result = [];
  for (const m of clean.matchAll(/([^{};]+)\{/g)) {
    const from = m[1].trim();
    if (!from || from.startsWith('@')) continue;
    for (const s of from.split(',')) {
      const t = s.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ');
      if (!t || /^(from|to|\d+(\.\d+)?%)$/.test(t)) continue;
      result.push(t);
    }
  }
  return result;
}

const cssFiles = (root) => readdirSync(root, { recursive: true }).map(String).filter((d) => d.endsWith('.css') && statSync(join(root, d)).isFile());

test('EYS kopyalari OZET.json ile ayni (elle degistirilmemis)', () => {
  const list = Object.entries(SUMMARY.files);
  assert.ok(list.length > 20, 'OZET.json bos gorunuyor');
  for (const [path, summary] of list) {
    const p = join(WEB, path);
    assert.ok(existsSync(p), `eksik: ${path}`);
    assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'), summary, `${path} elle degismis; scripts/eys-sync.mjs ile yeniden kopyalayin`);
  }
});

test('css/eys ve js/eys altinda OZET.json disinda dosya yok', () => {
  for (const root of ['css/eys', 'js/eys']) {
    for (const d of readdirSync(join(WEB, root), { recursive: true }).map(String)) {
      const path = `${root}/${d.split('\\').join('/')}`;
      if (statSync(join(WEB, path)).isDirectory() || path === 'css/eys/OZET.json') continue;
      assert.ok(path in SUMMARY.files, `OZET.json'da olmayan dosya: ${path}`);
    }
  }
});

test('app.css EYS agacini aynen ice aktarir; eski ayrismis dosyalar yok', () => {
  const app = readFileSync(join(WEB, 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const ice = [...app.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(ice, ['./fonts.css', './eys/app.css', './camera.css']);
  for (const old of ['base.css', 'layout.css', 'tokens.css', 'utilities.css', 'themes', 'components']) assert.ok(!existsSync(join(WEB, 'css', old)), `eski dosya duruyor: css/${old}`);
});

test('camera.css EYS seciciyi yeniden tanimlamaz', () => {
  const eys = new Set(cssFiles(join(WEB, 'css', 'eys')).flatMap((d) => selectors(readFileSync(join(WEB, 'css', 'eys', d), 'utf8'))));
  assert.ok(eys.has('.row-item') && eys.has('.modal__box'), 'EYS secicileri okunamadi');
  const camera = selectors(readFileSync(join(WEB, 'css', 'camera.css'), 'utf8'));
  assert.ok(camera.length > 0);
  const conflicting = [...new Set(camera.filter((s) => eys.has(s)))];
  assert.deepEqual(conflicting, [], `camera.css EYS secicilerini yeniden tanimliyor: ${conflicting.join(' | ')}`);
});
