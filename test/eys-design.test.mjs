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

// ---- EYS adlari Ingilizce: kamera HTML/JS/CSS'i EYS'nin yeni sinif ve data-* adlariyla uyumlu
const PAGES = ['web/index.html', 'web/login.html', 'live/index.html'];
const CAMERA_FILES = [...PAGES, 'web/css/camera.css', 'live/live.css', 'live/live.js', 'web/js/lang.js', 'web/js/split.js'];
const VIEWS = join(WEB, '..');
const read = (p) => readFileSync(join(VIEWS, p), 'utf8');
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const ALL_CSS = [...cssFiles(join(WEB, 'css')).map((d) => noComments(readFileSync(join(WEB, 'css', d), 'utf8'))), noComments(read('live/live.css'))].join('\n');
const classesIn = (css) => new Set([...selectors(css).join(' ').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

test('Turkce donem sinif / data-* adlari kameranin sayfalarinda ve EYS kopyalarinda yok', () => {
  const OLD = ['kullanici-menu', 'data-modal-acik', 'data-menu-ac', 'data-menu-liste', 'data-sira', 'data-baslangic', 'data-acilis', 'data-kopyala', 'data-sir', 'data-toplu', 'data-ilerleme',
    'form-dar', 'is-bos', 'tutamak', 'toplu', 'toplu-araclar', 'katlanir', 'ipucu', 'ilerleme', 'kayit-formu', 'tema-alan', 'credential-bolum', 'alert--aralikli', 'gate__katlanir', 'log-ozet', 'panel-izgara', 'sahte-tam', 'oynatici'];
  const token = (a) => new RegExp(`(?<![\\w-])${a.replace(/[-]/g, '\\-')}(?![\\w-])|(?<![\\w-])${a}__`);
  const texts = [...CAMERA_FILES.map((p) => [p, noComments(read(p)).replace(/<!--[\s\S]*?-->/g, '')]),
    ...readdirSync(join(WEB, 'css', 'eys'), { recursive: true }).map(String).filter((d) => d.endsWith('.css')).map((d) => [`css/eys/${d}`, noComments(readFileSync(join(WEB, 'css', 'eys', d), 'utf8'))]),
    ...readdirSync(join(WEB, 'js', 'eys'), { recursive: true }).map(String).filter((d) => d.endsWith('.js')).map((d) => [`js/eys/${d}`, readFileSync(join(WEB, 'js', 'eys', d), 'utf8')])];
  for (const [path, text] of texts) {
    // yalniz sinif/ozellik baglaminda ara: class="...", class: '...', .secici, [data-..], dataset
    const hooks = [...text.matchAll(/class(?:Name)?(?:=|: )["']([^"']+)["']|\[(data-[\w-]+)|(data-[\w-]+)=|\.([a-zA-Z][\w-]*)/g)].flatMap((m) => (m[1] ? m[1].split(/\s+/) : [m[2] ?? m[3] ?? m[4]]));
    for (const name of OLD) if (hooks.some((h) => token(name).test(h))) assert.fail(`${path}: Turkce donem adi duruyor: ${name}`);
  }
});

test('HTML/JS sinif adlari CSS ile, camera.css/live.css secicileri HTML/JS ile uyumlu', () => {
  const css = classesIn(ALL_CSS);
  const textOf = (paths) => paths.map(read).join('\n');
  const used = new Set();
  for (const p of [...PAGES, 'live/live.js']) {
    const s = read(p);
    for (const m of s.matchAll(/class="([^"<>]+)"/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
    for (const m of s.matchAll(/class: '([^']+)'/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
  }
  // bilerek stilsiz isaret sinifi / bicim degistirici olan adlar
  const HOOKS = new Set(['btn--secondary', 'devCamRow', 'devChannelRow', 'devHttpRow', 'devPortRow', 'devRtspRow', 'empty__icon', 'member-tabs', 'scope-device']);
  const undefinedClass = [...used].filter((c) => c && !c.includes('<') && !css.has(c) && !HOOKS.has(c));
  assert.deepEqual(undefinedClass, [], `CSS'te karsiligi olmayan sinif (HTML'de eski ad kalmis olabilir): ${undefinedClass.join(', ')}`);
  const pages = textOf([...PAGES, 'live/live.js', 'web/js/lang.js', 'web/js/split.js']);
  for (const file of ['web/css/camera.css', 'live/live.css']) {
    const unused = [...classesIn(noComments(read(file)))].filter((c) => !pages.includes(c) && !['A', 'M'].includes(c) && c !== 'error-text');
    assert.deepEqual(unused, [], `${file}: HTML/JS'te kullanilmayan secici sinifi (CSS'te eski ad kalmis olabilir): ${unused.join(', ')}`);
  }
});

test('EYS betiklerinin okudugu data-* adlari kamera sayfalarinda yazilanlarla ayni', () => {
  const js = readdirSync(join(WEB, 'js', 'eys'), { recursive: true }).map(String).filter((d) => d.endsWith('.js')).map((d) => readFileSync(join(WEB, 'js', 'eys', d), 'utf8')).join('\n');
  const html = PAGES.map(read).join('\n');
  const wanted = [...new Set([...js.matchAll(/data-[a-z-]+/g)].map((m) => m[0]))];
  assert.ok(wanted.includes('data-menu-open') && wanted.includes('data-menu-list') && wanted.includes('data-modal-active'));
  // kameranin menu / pencere isaretleri EYS'nin yeni adlariyla yazilmis
  for (const a of ['data-menu', 'data-menu-open', 'data-menu-list', 'data-modal']) assert.ok(html.includes(a), `kamera HTML'inde ${a} yok`);
  assert.ok(html.includes('class="user-menu"') && existsSync(join(WEB, 'css', 'eys', 'components', 'user-menu.css')), 'user-menu');
  assert.ok(!html.includes('kullanici-menu') && !existsSync(join(WEB, 'js', 'eys', 'components', 'kullanici-menu.js')));
});

test('web/css/eys ve web/js/eys altinda Turkce adli dosya yok', () => {
  for (const root of ['css/eys', 'js/eys']) for (const d of readdirSync(join(WEB, root), { recursive: true }).map(String)) assert.ok(!/kullanici|toplu|ilerleme|katlanir|ipucu|kayit-formu|dondurme/.test(d), `Turkce dosya adi: ${root}/${d}`);
});
