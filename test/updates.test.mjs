/**
 * Guncelleme kontrolu: GitHub'a cikmadan, sahte fetch ile. DC panellerindeki GuncellemeDenetimiTest'in karsiligi.
 * Asil kurallar: karsilastirma son BASARILI derlemeyle yapilir, yon olculur (ileride olan "guncelleme" sayilmaz), jeton
 * sonucta ve iletilerde gecmez, jeton yoksa acik depoya jetonsuz sorulur; uclar yalniz update.check iznine acik.
 * Calisan surum, derlemeye commit vermeyen platformlarda baglamdaki .git'ten okunur (docker/read-version.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateService } from '../src/services/updates.mjs';
import { PERMISSIONS } from '../src/models/permission.mjs';
import { openApp, openDb } from './helpers.mjs';
import { Settings } from '../src/core/tables.mjs';

const TOKEN = 'github_pat_SINAMA_JETONU_123';
const RUNNING = 'a'.repeat(40), LAST = 'b'.repeat(40);
const SETTING = { repo: 'mustafa-ozen95/kamera-ornek', is: 'image.yml', branch: 'main', token: TOKEN, version: RUNNING, clock: '06:50', api: 'https://api.github.com' };

/** Sahte GitHub: derleme listesi ve compare yaniti; gelen istekler `istekler`de. */
function mockGithub({ last = LAST, diff = { status: 'identical' }, code = 200, broken = false, body = { message: 'Bad credentials' } } = {}) {
  const requests = [];
  const fetch = async (url, option) => {
    requests.push({ url: String(url), option });
    if (broken) throw new TypeError('fetch failed');
    const response = (k, j) => new Response(JSON.stringify(j), { status: k, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('/actions/workflows/image.yml/runs')) return code === 200 ? response(200, { workflow_runs: [{ head_sha: last, updated_at: '2026-10-20T10:00:00Z' }] }) : response(code, body);
    if (String(url).includes('/compare/')) return response(200, diff);
    return response(404, { message: 'Not Found' });
  };
  return { fetch, requests };
}

async function service(setting = {}, gh = mockGithub()) {
  const v = await openDb(), settings = new Settings(v.db);
  const h = await new UpdateService({ settings, setting: { ...SETTING, ...setting }, fetch: gh.fetch }).load();
  return { h, gh, db: v.db, settings, clear: () => v.remove() };
}

const commit = (sha, message, date) => ({ sha, commit: { message: message, committer: { date: date } } });

test('jeton yoksa açık depoya jetonsuz sorulur', async () => {
  const { h, gh, clear } = await service({ token: '' }, mockGithub({ last: RUNNING }));
  assert.equal((await h.check('sınama')).status, 'current');
  assert.equal(gh.requests.length, 1); assert.equal(gh.requests[0].option.headers.Authorization, undefined);
  await clear();
});

test('jetonsuz sorulan özel ya da olmayan depo anlaşılır hata verir', async () => {
  const { h, clear } = await service({ token: '' }, mockGithub({ code: 404, body: { message: 'Not Found' } }));
  const s = await h.check('sınama');
  assert.equal(s.status, 'error'); assert.match(s.description, /404/); assert.match(s.description, /UPDATE_TOKEN/);
  await clear();
});

test('çalışan sürüm derleme bağlamındaki .git\'ten okunur (ayrı ref, packed-refs, .git yok)', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'read-version.sh');
  const root = mkdtempSync(join(tmpdir(), 'cam-srm-'));
  const read = () => execFileSync('sh', [script, root], { encoding: 'utf8' }).trim();
  try {
    assert.equal(read(), '');
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${LAST} refs/heads/main\n`);
    assert.equal(read(), LAST);
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${RUNNING}\n`);
    assert.equal(read(), RUNNING);
    writeFileSync(join(root, '.git', 'HEAD'), 'bozuk\n');
    assert.equal(read(), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('son başarılı derlemeyle aynıysa güncel; istek jetonla ve main/success süzgeciyle', async () => {
  const { h, gh, clear } = await service({}, mockGithub({ last: RUNNING }));
  assert.equal((await h.check('sınama')).status, 'current');
  assert.equal(gh.requests.length, 1);
  const u = new URL(gh.requests[0].url);
  assert.equal(u.searchParams.get('branch'), 'main'); assert.equal(u.searchParams.get('status'), 'success');
  assert.equal(gh.requests[0].option.headers.Authorization, `Bearer ${TOKEN}`);
  await clear();
});

test('geride ise yeni sürüm; commitler yeniden eskiye; güncellenince uyarı susar', async () => {
  const diff = { status: 'ahead', ahead_by: 2, behind_by: 0, commits: [commit('c'.repeat(40), 'Eski düzeltme\n\nayrıntı', '2026-10-19T08:00:00Z'), commit(LAST, 'Yeni özellik', '2026-10-20T09:00:00Z')] };
  const { h, gh, clear } = await service({}, mockGithub({ diff }));
  const s = await h.check('sınama');
  assert.equal(s.status, 'new'); assert.equal(s.behind, 2);
  assert.deepEqual(s.commitList.map((c) => c.header), ['Yeni özellik', 'Eski düzeltme']);
  assert.ok(gh.requests[1].url.endsWith(`/compare/${RUNNING}...${LAST}`));
  assert.equal(h.hasNew(), true);
  h.setting = { ...h.setting, version: LAST };
  assert.equal(h.hasNew(), false);
  await clear();
});

test('ileride ise güncelleme denmez', async () => {
  const { h, clear } = await service({}, mockGithub({ diff: { status: 'behind', ahead_by: 0, behind_by: 3, commits: [] } }));
  const s = await h.check('sınama');
  assert.equal(s.status, 'ahead'); assert.match(s.description, /geri almak/); assert.equal(h.hasNew(), false);
  await clear();
});

test('ayrışık dal', async () => {
  const { h, clear } = await service({}, mockGithub({ diff: { status: 'diverged', ahead_by: 1, behind_by: 2, commits: [] } }));
  assert.equal((await h.check('sınama')).status, 'diverged');
  await clear();
});

test('çalışan sürüm bilinmiyorsa karşılaştırılmaz', async () => {
  const { h, gh, clear } = await service({ version: '' });
  const s = await h.check('sınama');
  assert.equal(s.status, 'unknown'); assert.equal(s.last, LAST); assert.equal(gh.requests.length, 1);
  await clear();
});

test('reddedilen jeton hata olur ve jeton veritabanına yazılmaz', async () => {
  const { h, db, clear } = await service({}, mockGithub({ code: 401 }));
  const s = await h.check('sınama');
  assert.equal(s.status, 'error'); assert.match(s.description, /401/);
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM settings')).includes(TOKEN));
  await clear();
});

test('erişim yoksa hata; son sonuç okunur', async () => {
  const { h, clear } = await service({}, mockGithub({ broken: true }));
  await h.check('sınama');
  const s = h.last();
  assert.equal(s.status, 'error'); assert.match(s.description, /erişilemedi/); assert.equal(s.trigger, 'sınama'); assert.equal(s.running, RUNNING);
  await clear();
});

test('bozuk sonuç kaydı yok sayılır', async () => {
  const { h, settings, clear } = await service();
  await settings.write('update-status', { status: 'bilmem' }); await h.load();
  assert.equal(h.last(), null); assert.equal(h.hasNew(), false);
  await clear();
});

test('uçlar: admin kontrol eder; izni olmayan 403 ve gerekenIzin döner; jeton yanıtta yok', async () => {
  assert.ok(PERMISSIONS['update.check']);
  const { req, login, services, close } = await openApp();
  try {
    await login('admin', 'adminparola1');
    const diff = { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [commit(LAST, 'Yeni özellik: güncelleme sekmesi', '2026-10-20T09:00:00Z')] };
    services.updates.setting = { ...services.updates.setting, ...SETTING };
    services.updates.fetch = mockGithub({ diff }).fetch;

    const before = await req('/api/update');
    assert.equal(before.status, 200, before.text); assert.equal(before.json.last, null); assert.equal(before.json.running, RUNNING);

    const r = await req('/api/update/check', { method: 'POST', body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.last.status, 'new'); assert.equal(r.json.last.behind, 3); assert.equal(r.json.last.trigger, 'admin'); assert.equal(r.json.hasNew, true);
    assert.ok(!r.text.includes(TOKEN));

    const u = await req('/api/members', { method: 'POST', body: { name: 'ali', password: 'aliparola1', role: 'camera' } });
    assert.equal(u.status, 200, u.text);
    await login('ali', 'aliparola1');
    for (const [path, method] of [['/api/update', 'GET'], ['/api/update/check', 'POST']]) {
      const y = await req(path, { who: 'ali', method, body: method === 'GET' ? undefined : {} });
      assert.equal(y.status, 403, `${method} ${path}: ${y.text}`); assert.equal(y.json.requiredPermission, 'update.check');
    }
  } finally { await close(); }
});

const HOOK = 'http://10.0.0.9:3000/v1/deploy-hooks/GIZLI_HOOK_JETONU';

/** Sahte GitHub + sahte platform: hook istegi `hookIstekleri`ne duser. */
function mockPlatform({ diff, hookCode = 202, hookBody = { deploymentId: 77 } } = {}) {
  const gh = mockGithub({ diff }), hookRequests = [];
  const fetch = async (url, option) => {
    if (String(url).startsWith('http://10.0.0.9:3000/')) {
      hookRequests.push({ url: String(url), option });
      return new Response(JSON.stringify(hookBody), { status: hookCode, headers: { 'Content-Type': 'application/json' } });
    }
    return gh.fetch(url, option);
  };
  return { fetch, hookRequests };
}
const NEW_DIFF = { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [commit(LAST, 'Yeni özellik', '2026-10-20T09:00:00Z')] };

test('güncelle: yalnız hook ve yeni sürüm varken mümkün; güncellenince kaybolur', async () => {
  const p = mockPlatform({ diff: NEW_DIFF });
  const { h, clear } = await service({ hook: '' }, p);
  assert.equal(h.canApply(), false);
  await h.check('sınama');
  assert.equal(h.hasNew(), true); assert.equal(h.hookReady(), false); assert.equal(h.canApply(), false);
  await assert.rejects(h.apply(), /UPDATE_HOOK_URL/);
  h.setting = { ...h.setting, hook: HOOK };
  assert.equal(h.canApply(), true);
  h.setting = { ...h.setting, version: LAST };   // panel guncellendi: eski "yeni surum" sonucu susar
  assert.equal(h.canApply(), false);
  assert.equal(p.hookRequests.length, 0);
  await clear();
});

test('güncelle: hook POST edilir; yeni sürüm yoksa çağrılmaz; ret iletisinde hook geçmez', async () => {
  const p = mockPlatform({ diff: NEW_DIFF });
  const { h, clear } = await service({ hook: HOOK }, p);
  await assert.rejects(h.apply(), /yeni sürüm yok/);
  assert.equal(p.hookRequests.length, 0);
  await h.check('sınama');
  assert.equal(await h.apply(), 'deploy #77');
  assert.equal(p.hookRequests.length, 1); assert.equal(p.hookRequests[0].url, HOOK); assert.equal(p.hookRequests[0].option.method, 'POST');
  await clear();

  const q = mockPlatform({ diff: NEW_DIFF, hookCode: 404, hookBody: { message: 'not found' } });
  const s = await service({ hook: HOOK }, q);
  await s.h.check('sınama');
  await assert.rejects(s.h.apply(), (e) => /404/.test(e.message) && !e.message.includes('GIZLI_HOOK_JETONU'));
  await s.clear();
});

test('güncelle ucu: update.apply ister; yanıtta hook yok; denetim kaydına düşer', async () => {
  const { req, login, services, close } = await openApp();
  try {
    await login('admin', 'adminparola1');
    const p = mockPlatform({ diff: NEW_DIFF });
    services.updates.setting = { ...services.updates.setting, ...SETTING, hook: HOOK };
    services.updates.fetch = p.fetch;

    const none = await req('/api/update/apply', { method: 'POST', body: {} });
    assert.equal(none.status, 409, none.text); assert.equal(p.hookRequests.length, 0);

    const c = await req('/api/update/check', { method: 'POST', body: {} });
    assert.equal(c.json.canApply, true); assert.equal(c.json.hookReady, true); assert.ok(!c.text.includes('GIZLI_HOOK_JETONU'));

    const r = await req('/api/update/apply', { method: 'POST', body: {} });
    assert.equal(r.status, 202, r.text); assert.match(r.json.message, /deploy #77/); assert.ok(!r.text.includes('GIZLI_HOOK_JETONU'));
    assert.equal(p.hookRequests.length, 1);
    await services.auditLog.wait();
    const log = await req('/api/audit-log');
    assert.ok(log.text.includes('update-start'), log.text.slice(0, 300)); assert.ok(!log.text.includes('GIZLI_HOOK_JETONU'));

    // update.check izni olan ama update.apply olmayan kurduramaz.
    const role = await req('/api/access/roles', { method: 'POST', body: { id: 'kontrolcu', name: 'Kontrolcü', permissions: ['update.check'] } });
    assert.ok(role.status === 200 || role.status === 201, role.text);
    const u = await req('/api/members', { method: 'POST', body: { name: 'veli', password: 'veliparola1', role: 'kontrolcu' } });
    assert.equal(u.status, 200, u.text);
    await login('veli', 'veliparola1');
    const y = await req('/api/update/apply', { who: 'veli', method: 'POST', body: {} });
    assert.equal(y.status, 403, y.text); assert.equal(y.json.requiredPermission, 'update.apply');
    assert.equal(p.hookRequests.length, 1);
  } finally { await close(); }
});
