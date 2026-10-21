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
const OZET = JSON.parse(readFileSync(join(WEB, 'css', 'eys', 'OZET.json'), 'utf8'));

/** CSS metnindeki secici listesi (at-kurallari ve keyframe adimlari haric), bosluklari tekle indirilmis. */
export function seciciler(css) {
  const temiz = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sonuc = [];
  for (const m of temiz.matchAll(/([^{};]+)\{/g)) {
    const bas = m[1].trim();
    if (!bas || bas.startsWith('@')) continue;
    for (const s of bas.split(',')) {
      const t = s.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, ' $1 ');
      if (!t || /^(from|to|\d+(\.\d+)?%)$/.test(t)) continue;
      sonuc.push(t);
    }
  }
  return sonuc;
}

const cssDosyalari = (kok) => readdirSync(kok, { recursive: true }).map(String).filter((d) => d.endsWith('.css') && statSync(join(kok, d)).isFile());

test('EYS kopyalari OZET.json ile ayni (elle degistirilmemis)', () => {
  const liste = Object.entries(OZET.dosyalar);
  assert.ok(liste.length > 20, 'OZET.json bos gorunuyor');
  for (const [yol, ozet] of liste) {
    const p = join(WEB, yol);
    assert.ok(existsSync(p), `eksik: ${yol}`);
    assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'), ozet, `${yol} elle degismis; scripts/eys-sync.mjs ile yeniden kopyalayin`);
  }
});

test('css/eys ve js/eys altinda OZET.json disinda dosya yok', () => {
  for (const kok of ['css/eys', 'js/eys']) {
    for (const d of readdirSync(join(WEB, kok), { recursive: true }).map(String)) {
      const yol = `${kok}/${d.split('\\').join('/')}`;
      if (statSync(join(WEB, yol)).isDirectory() || yol === 'css/eys/OZET.json') continue;
      assert.ok(yol in OZET.dosyalar, `OZET.json'da olmayan dosya: ${yol}`);
    }
  }
});

test('app.css EYS agacini aynen ice aktarir; eski ayrismis dosyalar yok', () => {
  const app = readFileSync(join(WEB, 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const ice = [...app.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(ice, ['./fonts.css', './eys/app.css', './camera.css']);
  for (const eski of ['base.css', 'layout.css', 'tokens.css', 'utilities.css', 'themes', 'components']) assert.ok(!existsSync(join(WEB, 'css', eski)), `eski dosya duruyor: css/${eski}`);
});

test('camera.css EYS seciciyi yeniden tanimlamaz', () => {
  const eys = new Set(cssDosyalari(join(WEB, 'css', 'eys')).flatMap((d) => seciciler(readFileSync(join(WEB, 'css', 'eys', d), 'utf8'))));
  assert.ok(eys.has('.row-item') && eys.has('.modal__box'), 'EYS secicileri okunamadi');
  const kamera = seciciler(readFileSync(join(WEB, 'css', 'camera.css'), 'utf8'));
  assert.ok(kamera.length > 0);
  const cakisan = [...new Set(kamera.filter((s) => eys.has(s)))];
  assert.deepEqual(cakisan, [], `camera.css EYS secicilerini yeniden tanimliyor: ${cakisan.join(' | ')}`);
});
