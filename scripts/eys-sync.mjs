#!/usr/bin/env node
/**
 * EYS tasarim dosyalarini BIREBIR kopyalar: kamera paneli EYS tasarimini degistirmeden kullanir.
 *
 *   node scripts/eys-sync.mjs [EYS_KOKU]           kopyalar, OZET.json yazar (varsayilan ../eys)
 *   node scripts/eys-sync.mjs [EYS_KOKU] --kontrol  yalniz bakar: EYS'de degisen dosya var mi
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

const KOK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(KOK, 'resources', 'views', 'web');
const arg = process.argv.slice(2);
const kontrol = arg.includes('--kontrol');
const EYS = resolve(arg.find((a) => !a.startsWith('--')) ?? join(KOK, '..', 'eys'));
/** EYS'den alinan betikler: yalniz lib/dom.js'e dayananlar (confirm/navigation Laravel formlarina bagli, alinmaz). */
export const JS_LISTESI = ['lib/dom.js', 'components/theme.js', 'components/kullanici-menu.js', 'components/dialog.js', 'components/toast.js', 'components/columns.js'];

const ozetle = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const dosyalar = (kok) => readdirSync(kok, { recursive: true }).map(String).filter((d) => statSync(join(kok, d)).isFile()).sort();

const kaynakCss = join(EYS, 'resources', 'css');
if (!existsSync(kaynakCss)) { console.error(`EYS bulunamadi: ${kaynakCss}`); process.exit(2); }
const kaynaklar = [
  ...dosyalar(kaynakCss).map((d) => ({ kaynak: join(kaynakCss, d), hedef: join('css', 'eys', d) })),
  ...JS_LISTESI.map((d) => ({ kaynak: join(EYS, 'resources', 'js', d), hedef: join('js', 'eys', d) })),
];

if (kontrol) {
  const ozet = JSON.parse(readFileSync(join(WEB, 'css', 'eys', 'OZET.json'), 'utf8'));
  const farkli = kaynaklar.filter((k) => ozet.dosyalar[k.hedef] !== ozetle(k.kaynak)).map((k) => k.hedef);
  const fazla = Object.keys(ozet.dosyalar).filter((h) => !kaynaklar.some((k) => k.hedef === h));
  if (!farkli.length && !fazla.length) { console.log('EYS ile ayni.'); process.exit(0); }
  for (const f of farkli) console.log(`degisti: ${f}`);
  for (const f of fazla) console.log(`EYS'de artik yok: ${f}`);
  console.log('Esitlemek icin: node scripts/eys-sync.mjs'); process.exit(1);
}

for (const kok of ['css/eys', 'js/eys']) rmSync(join(WEB, kok), { recursive: true, force: true });
const ozet = { kaynak: 'eys', commit: null, zaman: new Date().toISOString(), dosyalar: {} };
try { ozet.commit = execFileSync('git', ['-C', EYS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
for (const k of kaynaklar) {
  const hedef = join(WEB, k.hedef);
  mkdirSync(dirname(hedef), { recursive: true });
  cpSync(k.kaynak, hedef);
  ozet.dosyalar[k.hedef] = ozetle(hedef);
}
writeFileSync(join(WEB, 'css', 'eys', 'OZET.json'), JSON.stringify(ozet, null, 2) + '\n');
console.log(`${Object.keys(ozet.dosyalar).length} dosya kopyalandi (EYS ${ozet.commit ?? '?'}).`);
console.log(relative(KOK, join(WEB, 'css', 'eys', 'OZET.json')));
