/**
 * Guncelleme kontrolu: GitHub'a cikmadan, sahte fetch ile. DC panellerindeki GuncellemeDenetimiTest'in karsiligi.
 * Asil kurallar: karsilastirma son BASARILI derlemeyle yapilir, yon olculur (ileride olan "guncelleme" sayilmaz), jeton
 * sonucta ve iletilerde gecmez, jeton yoksa acik depoya jetonsuz sorulur; uclar yalniz guncelleme.denetle iznine acik.
 * Calisan surum, derlemeye commit vermeyen platformlarda baglamdaki .git'ten okunur (docker/surum-oku.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuncellemeHizmeti } from '../src/services/guncelleme.mjs';
import { IZINLER } from '../src/models/yetki.mjs';
import { uygulamaAc } from './helpers.mjs';

const JETON = 'github_pat_SINAMA_JETONU_123';
const CALISAN = 'a'.repeat(40), SON = 'b'.repeat(40);
const AYAR = { depo: 'mustafa-ozen95/kamera-ornek', is: 'imaj.yml', dal: 'main', jeton: JETON, surum: CALISAN, saat: '06:50', api: 'https://api.github.com' };

/** Sahte GitHub: derleme listesi ve compare yaniti; gelen istekler `istekler`de. */
function sahteGithub({ son = SON, fark = { status: 'identical' }, kod = 200, kopuk = false, govde = { message: 'Bad credentials' } } = {}) {
  const istekler = [];
  const fetch = async (url, secenek) => {
    istekler.push({ url: String(url), secenek });
    if (kopuk) throw new TypeError('fetch failed');
    const yanit = (k, j) => new Response(JSON.stringify(j), { status: k, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('/actions/workflows/imaj.yml/runs')) return kod === 200 ? yanit(200, { workflow_runs: [{ head_sha: son, updated_at: '2026-10-20T10:00:00Z' }] }) : yanit(kod, govde);
    if (String(url).includes('/compare/')) return yanit(200, fark);
    return yanit(404, { message: 'Not Found' });
  };
  return { fetch, istekler };
}

function hizmet(ayar = {}, gh = sahteGithub()) {
  const klasor = mkdtempSync(join(tmpdir(), 'cam-gnc-'));
  const h = new GuncellemeHizmeti({ dosya: join(klasor, 'guncelleme.json'), ayar: { ...AYAR, ...ayar }, fetch: gh.fetch });
  return { h, gh, klasor, temizle: () => rmSync(klasor, { recursive: true, force: true }) };
}

const commit = (sha, mesaj, tarih) => ({ sha, commit: { message: mesaj, committer: { date: tarih } } });

test('jeton yoksa açık depoya jetonsuz sorulur', async () => {
  const { h, gh, temizle } = hizmet({ jeton: '' }, sahteGithub({ son: CALISAN }));
  assert.equal((await h.denetle('sınama')).durum, 'guncel');
  assert.equal(gh.istekler.length, 1); assert.equal(gh.istekler[0].secenek.headers.Authorization, undefined);
  temizle();
});

test('jetonsuz sorulan özel ya da olmayan depo anlaşılır hata verir', async () => {
  const { h, temizle } = hizmet({ jeton: '' }, sahteGithub({ kod: 404, govde: { message: 'Not Found' } }));
  const s = await h.denetle('sınama');
  assert.equal(s.durum, 'hata'); assert.match(s.aciklama, /404/); assert.match(s.aciklama, /GUNCELLEME_JETONU/);
  temizle();
});

test('çalışan sürüm derleme bağlamındaki .git\'ten okunur (ayrı ref, packed-refs, .git yok)', () => {
  const betik = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'surum-oku.sh');
  const kok = mkdtempSync(join(tmpdir(), 'cam-srm-'));
  const oku = () => execFileSync('sh', [betik, kok], { encoding: 'utf8' }).trim();
  try {
    assert.equal(oku(), '');
    mkdirSync(join(kok, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(kok, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(kok, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${SON} refs/heads/main\n`);
    assert.equal(oku(), SON);
    writeFileSync(join(kok, '.git', 'refs', 'heads', 'main'), `${CALISAN}\n`);
    assert.equal(oku(), CALISAN);
    writeFileSync(join(kok, '.git', 'HEAD'), 'bozuk\n');
    assert.equal(oku(), '');
  } finally { rmSync(kok, { recursive: true, force: true }); }
});

test('son başarılı derlemeyle aynıysa güncel; istek jetonla ve main/success süzgeciyle', async () => {
  const { h, gh, temizle } = hizmet({}, sahteGithub({ son: CALISAN }));
  assert.equal((await h.denetle('sınama')).durum, 'guncel');
  assert.equal(gh.istekler.length, 1);
  const u = new URL(gh.istekler[0].url);
  assert.equal(u.searchParams.get('branch'), 'main'); assert.equal(u.searchParams.get('status'), 'success');
  assert.equal(gh.istekler[0].secenek.headers.Authorization, `Bearer ${JETON}`);
  temizle();
});

test('geride ise yeni sürüm; commitler yeniden eskiye; güncellenince uyarı susar', async () => {
  const fark = { status: 'ahead', ahead_by: 2, behind_by: 0, commits: [commit('c'.repeat(40), 'Eski düzeltme\n\nayrıntı', '2026-10-19T08:00:00Z'), commit(SON, 'Yeni özellik', '2026-10-20T09:00:00Z')] };
  const { h, gh, temizle } = hizmet({}, sahteGithub({ fark }));
  const s = await h.denetle('sınama');
  assert.equal(s.durum, 'yeni'); assert.equal(s.geride, 2);
  assert.deepEqual(s.commitler.map((c) => c.baslik), ['Yeni özellik', 'Eski düzeltme']);
  assert.ok(gh.istekler[1].url.endsWith(`/compare/${CALISAN}...${SON}`));
  assert.equal(h.yeniVar(), true);
  h.ayar = { ...h.ayar, surum: SON };
  assert.equal(h.yeniVar(), false);
  temizle();
});

test('ileride ise güncelleme denmez', async () => {
  const { h, temizle } = hizmet({}, sahteGithub({ fark: { status: 'behind', ahead_by: 0, behind_by: 3, commits: [] } }));
  const s = await h.denetle('sınama');
  assert.equal(s.durum, 'ileride'); assert.match(s.aciklama, /geri almak/); assert.equal(h.yeniVar(), false);
  temizle();
});

test('ayrışık dal', async () => {
  const { h, temizle } = hizmet({}, sahteGithub({ fark: { status: 'diverged', ahead_by: 1, behind_by: 2, commits: [] } }));
  assert.equal((await h.denetle('sınama')).durum, 'ayrisik');
  temizle();
});

test('çalışan sürüm bilinmiyorsa karşılaştırılmaz', async () => {
  const { h, gh, temizle } = hizmet({ surum: '' });
  const s = await h.denetle('sınama');
  assert.equal(s.durum, 'bilinmiyor'); assert.equal(s.son, SON); assert.equal(gh.istekler.length, 1);
  temizle();
});

test('reddedilen jeton hata olur ve jeton dosyaya yazılmaz', async () => {
  const { h, klasor, temizle } = hizmet({}, sahteGithub({ kod: 401 }));
  const s = await h.denetle('sınama');
  assert.equal(s.durum, 'hata'); assert.match(s.aciklama, /401/);
  assert.ok(!readFileSync(join(klasor, 'guncelleme.json'), 'utf8').includes(JETON));
  temizle();
});

test('erişim yoksa hata; son sonuç okunur', async () => {
  const { h, temizle } = hizmet({}, sahteGithub({ kopuk: true }));
  await h.denetle('sınama');
  const s = h.son();
  assert.equal(s.durum, 'hata'); assert.match(s.aciklama, /erişilemedi/); assert.equal(s.tetikleyen, 'sınama'); assert.equal(s.calisan, CALISAN);
  temizle();
});

test('bozuk sonuç dosyası yok sayılır', () => {
  const { h, klasor, temizle } = hizmet();
  writeFileSync(join(klasor, 'guncelleme.json'), '{"durum":"bilmem"}');
  assert.equal(h.son(), null); assert.equal(h.yeniVar(), false);
  temizle();
});

test('uçlar: admin kontrol eder; izni olmayan 403 ve gerekenIzin döner; jeton yanıtta yok', async () => {
  assert.ok(IZINLER['guncelleme.denetle']);
  const { istek, giris, hizmetler, kapat } = await uygulamaAc();
  try {
    await giris('admin', 'adminparola1');
    const fark = { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [commit(SON, 'Yeni özellik: güncelleme sekmesi', '2026-10-20T09:00:00Z')] };
    hizmetler.guncelleme.ayar = { ...hizmetler.guncelleme.ayar, ...AYAR };
    hizmetler.guncelleme.fetch = sahteGithub({ fark }).fetch;

    const once = await istek('/api/guncelleme');
    assert.equal(once.durum, 200, once.metin); assert.equal(once.json.son, null); assert.equal(once.json.calisan, CALISAN);

    const r = await istek('/api/guncelleme/denetle', { yontem: 'POST', govde: {} });
    assert.equal(r.durum, 200, r.metin);
    assert.equal(r.json.son.durum, 'yeni'); assert.equal(r.json.son.geride, 3); assert.equal(r.json.son.tetikleyen, 'admin'); assert.equal(r.json.yeniVar, true);
    assert.ok(!r.metin.includes(JETON));

    const u = await istek('/api/uyeler', { yontem: 'POST', govde: { ad: 'ali', parola: 'aliparola1', rol: 'kamera' } });
    assert.equal(u.durum, 200, u.metin);
    await giris('ali', 'aliparola1');
    for (const [yol, yontem] of [['/api/guncelleme', 'GET'], ['/api/guncelleme/denetle', 'POST']]) {
      const y = await istek(yol, { kim: 'ali', yontem, govde: yontem === 'GET' ? undefined : {} });
      assert.equal(y.durum, 403, `${yontem} ${yol}: ${y.metin}`); assert.equal(y.json.gerekenIzin, 'guncelleme.denetle');
    }
  } finally { await kapat(); }
});
