#!/usr/bin/env node
/**
 * EYS tasarim dosyalarini BIREBIR kopyalar: kamera paneli EYS tasarimini degistirmeden kullanir.
 *
 *   node scripts/eys-sync.mjs [EYS_KOKU]           kopyalar, OZET.json yazar (varsayilan ../eys)
 *   node scripts/eys-sync.mjs [EYS_KOKU] --check  yalniz bakar: EYS'de degisen dosya var mi
 *
 * Kopyalananlar: resources/css/** -> web/css/eys/, resources/js/{lib/dom.js, components/<LISTE>} -> web/js/eys/.
 * web/css/eys ve web/js/eys ELLE DEGISTIRILMEZ; test/eys-design.test.mjs OZET.json'a karsi denetler.
 * Kameraya ozgu kurallar web/css/camera.css'te: yeni secici ekler, EYS secicisini yeniden tanimlamaz.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'resources', 'views', 'web');
const arg = process.argv.slice(2);
const check = arg.includes('--check');
const EYS = resolve(arg.find((a) => !a.startsWith('--')) ?? join(ROOT, '..', 'eys'));
/** EYS'den alinan betikler: yalniz lib/dom.js'e dayananlar (confirm/navigation Laravel formlarina bagli, alinmaz). */
export const JS_LIST = ['lib/dom.js', 'components/theme.js', 'components/kullanici-menu.js', 'components/dialog.js', 'components/toast.js', 'components/columns.js'];

const summarize = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const files = (root) => readdirSync(root, { recursive: true }).map(String).filter((d) => statSync(join(root, d)).isFile()).sort();

const sourceCss = join(EYS, 'resources', 'css');
if (!existsSync(sourceCss)) { console.error(`EYS bulunamadi: ${sourceCss}`); process.exit(2); }
const sources = [
  ...files(sourceCss).map((d) => ({ source: join(sourceCss, d), target: join('css', 'eys', d) })),
  ...JS_LIST.map((d) => ({ source: join(EYS, 'resources', 'js', d), target: join('js', 'eys', d) })),
];

if (check) {
  const summary = JSON.parse(readFileSync(join(WEB, 'css', 'eys', 'OZET.json'), 'utf8'));
  const different = sources.filter((k) => summary.files[k.target] !== summarize(k.source)).map((k) => k.target);
  const extra = Object.keys(summary.files).filter((h) => !sources.some((k) => k.target === h));
  if (!different.length && !extra.length) { console.log('EYS ile ayni.'); process.exit(0); }
  for (const f of different) console.log(`degisti: ${f}`);
  for (const f of extra) console.log(`EYS'de artik yok: ${f}`);
  console.log('Esitlemek icin: node scripts/eys-sync.mjs'); process.exit(1);
}

for (const root of ['css/eys', 'js/eys']) rmSync(join(WEB, root), { recursive: true, force: true });
const summary = { source: 'eys', commit: null, time: new Date().toISOString(), files: {} };
try { summary.commit = execFileSync('git', ['-C', EYS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
for (const k of sources) {
  const target = join(WEB, k.target);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(k.source, target);
  summary.files[k.target] = summarize(target);
}
writeFileSync(join(WEB, 'css', 'eys', 'OZET.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`${Object.keys(summary.files).length} dosya kopyalandi (EYS ${summary.commit ?? '?'}).`);
console.log(relative(ROOT, join(WEB, 'css', 'eys', 'OZET.json')));
