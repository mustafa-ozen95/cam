import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from './helpers.mjs';
import {
  Principal, ErrorLimit, RateLimit, PERMISSIONS, PermissionStore, PermissionError, BUILTIN_ROLES, normalizeExpiresAt, normalizeIps, ipMatches, ipRuleValid,
  isPermissionSubset, permissionValid, expandPermission, permissionIntersection, hasPermission, scopeWithin, scopeChannelAllowed, scopeIntersection, scopeSet, normalizeScope,
} from '../src/models/permission.mjs';

// kanallar: cihaz A = 0..3, cihaz B = 4..7
const deviceIdOf = (k) => (k < 4 ? 'aaaa1111' : k < 8 ? 'bbbb2222' : null);
const CHANNEL_TOTAL = 8;
const newRepo = async (option = {}) => {
  const v = await openDb(), secret = randomBytes(32);
  return { db: v.db, secret, repo: await new PermissionStore(v.db, secret, option).load(), clear: () => v.remove() };
};
/** Sinamalarin kullandigi izin kumeleri (eski yerlesik roller) ozel rol olarak kurulur. */
const customRoles = async (repo) => { await repo.addRole({ id: 'user', name: 'Kullanıcı', permissions: ['live.view', 'recording.list', 'recording.play', 'recording.download'] }, 'admin'); await repo.addRole({ id: 'viewer', name: 'İzleyici', permissions: ['live.view'] }, 'admin'); };
const errorCode = async (fn) => { try { await fn(); } catch (e) { assert.ok(e instanceof PermissionError, `YetkiHatasi bekleniyordu: ${e}`); return e.code; } assert.fail('hata bekleniyordu'); };

test('izinVar: tam, grup joker ve * kuralları', async () => {
  assert.ok(hasPermission(['*'], 'recording.download'));
  assert.ok(hasPermission(['recording.*'], 'recording.play'));
  assert.ok(!hasPermission(['recording.*'], 'live.view'));
  assert.ok(hasPermission(['live.view'], 'live.view'));
  assert.ok(!hasPermission(['live.view'], 'unknown'));
  assert.ok(!hasPermission([], 'live.view'));
  assert.ok(!hasPermission(['recording.play'], 'recording.download'));
});

test('izin kataloğu: geçerlilik, genişletme, alt küme, kesişim', async () => {
  assert.ok(permissionValid('*') && permissionValid('recording.*') && permissionValid('device.manage'));
  assert.ok(!permissionValid('foo.bar') && !permissionValid('foo.*') && !permissionValid(5) && !permissionValid(''));
  assert.deepEqual(expandPermission(['*']).sort(), Object.keys(PERMISSIONS).sort());
  assert.deepEqual(expandPermission(['recording.*']).sort(), ['recording.download', 'recording.list', 'recording.play']);
  assert.ok(isPermissionSubset(['live.view'], ['live.view', 'recording.play']));
  assert.ok(!isPermissionSubset(['recording.download'], ['live.view']));
  assert.ok(isPermissionSubset(['recording.play'], ['recording.*']));
  assert.ok(!isPermissionSubset(['*'], ['recording.*']));
  assert.ok(isPermissionSubset(['*'], ['*']));
  assert.deepEqual(permissionIntersection(['live.view', 'recording.play'], ['recording.*']), ['recording.play']);
});

test('yerleşik roller DC panelleriyle aynı: admin her şey, network/teknik/muhasebe izinsiz doğar, kamera izlemeyle', async () => {
  assert.deepEqual(Object.keys(BUILTIN_ROLES), ['admin', 'network', 'technical', 'accounting', 'camera']);
  assert.deepEqual(BUILTIN_ROLES.camera.permissions, ['live.view', 'recording.list', 'recording.play', 'recording.download']);
  assert.ok(BUILTIN_ROLES.camera.permissionEditable && !hasPermission(BUILTIN_ROLES.camera.permissions, 'member.manage') && !hasPermission(BUILTIN_ROLES.camera.permissions, 'device.manage'));
  assert.ok(hasPermission(BUILTIN_ROLES.admin.permissions, 'permission.manage'));
  for (const id of ['network', 'technical', 'accounting']) { assert.deepEqual(BUILTIN_ROLES[id].permissions, []); assert.ok(BUILTIN_ROLES[id].permissionEditable); }
  assert.ok(!BUILTIN_ROLES.admin.permissionEditable);
});

test('IP ve CIDR eşleşmesi', async () => {
  assert.ok(ipMatches('10.0.0.5', []) && ipMatches('1.2.3.4', undefined));
  assert.ok(ipMatches('10.0.0.5', ['10.0.0.0/24']));
  assert.ok(!ipMatches('10.0.1.5', ['10.0.0.0/24']));
  assert.ok(ipMatches('::ffff:10.0.0.9', ['10.0.0.0/24']));
  assert.ok(ipMatches('192.168.1.1', ['10.0.0.0/8', '192.168.1.1']));
  assert.ok(ipMatches('8.8.8.8', ['0.0.0.0/0']));
  assert.ok(!ipMatches('8.8.8.8', ['8.8.8.9/32']));
  assert.ok(ipMatches('::1', ['::1']));
  assert.ok(ipRuleValid('10.0.0.0/24') && ipRuleValid('1.2.3.4') && ipRuleValid('::1'));
  assert.ok(!ipRuleValid('10.0.0.0/33') && !ipRuleValid('999.1.1.1') && !ipRuleValid('abc') && !ipRuleValid(5));
  assert.equal(await errorCode(() => normalizeIps(['abc'])), 'INVALID_REQUEST');
  assert.deepEqual(normalizeIps(['1.2.3.4', '1.2.3.4', ' 10.0.0.0/8 ']), ['1.2.3.4', '10.0.0.0/8']);
});

test('bitiş tarihi normalleştirme', async () => {
  assert.equal(normalizeExpiresAt(null), null);
  assert.equal(normalizeExpiresAt(''), null);
  assert.equal(normalizeExpiresAt('2030-01-02'), '2030-01-02T23:59:59.000Z');
  assert.equal(normalizeExpiresAt('2030-01-02T10:00:00Z'), '2030-01-02T10:00:00.000Z');
  assert.equal(await errorCode(() => normalizeExpiresAt('yarın')), 'INVALID_REQUEST');
});

test('kapsam: cihaz, kanal, kapsam içinde, kesişim', async () => {
  assert.equal(normalizeScope(null), null);
  assert.deepEqual(normalizeScope({ devices: ['aaaa1111', 'aaaa1111'], channels: [5, 2, 5] }), { devices: ['aaaa1111'], channels: [2, 5] });
  assert.equal(await errorCode(() => normalizeScope([1])), 'INVALID_REQUEST');
  assert.equal(await errorCode(() => normalizeScope({ channels: [-1] })), 'INVALID_REQUEST');
  assert.equal(await errorCode(() => normalizeScope({ devices: ['x y'] })), 'INVALID_REQUEST');
  const a = { devices: ['aaaa1111'], channels: [5] };
  assert.ok(scopeChannelAllowed(null, 99, deviceIdOf));
  assert.ok(scopeChannelAllowed(a, 1, deviceIdOf) && scopeChannelAllowed(a, 5, deviceIdOf));
  assert.ok(!scopeChannelAllowed(a, 6, deviceIdOf) && !scopeChannelAllowed(a, 8, deviceIdOf));
  assert.ok(!scopeChannelAllowed({ devices: [], channels: [] }, 0, deviceIdOf));
  assert.deepEqual([...scopeSet(a, CHANNEL_TOTAL, deviceIdOf)], [0, 1, 2, 3, 5]);
  assert.ok(scopeWithin({ channels: [1, 2] }, a, CHANNEL_TOTAL, deviceIdOf));
  assert.ok(!scopeWithin({ channels: [1, 6] }, a, CHANNEL_TOTAL, deviceIdOf));
  assert.ok(scopeWithin(a, null, CHANNEL_TOTAL, deviceIdOf));
  assert.ok(!scopeWithin(null, a, CHANNEL_TOTAL, deviceIdOf));
  assert.deepEqual(scopeIntersection(a, { channels: [1, 5, 6] }, CHANNEL_TOTAL, deviceIdOf).channels, [1, 5]);
  assert.equal(scopeIntersection(null, null, CHANNEL_TOTAL, deviceIdOf), null);
  assert.deepEqual(scopeIntersection(null, { channels: [2] }, CHANNEL_TOTAL, deviceIdOf).channels, [2]);
});

test('hız sınırı: kayan pencere', async () => {
  const h = new RateLimit();
  for (let i = 0; i < 3; i++) assert.ok(h.attempt('a', 3, 60_000, 1000 + i).ok);
  const r = h.attempt('a', 3, 60_000, 1010);
  assert.equal(r.ok, false);
  assert.ok(r.resetSec >= 1 && r.resetSec <= 60);
  assert.ok(h.attempt('b', 3, 60_000, 1010).ok);               // başka anahtar etkilenmez
  assert.ok(h.attempt('a', 3, 60_000, 1000 + 60_001).ok);       // pencere kaydı
});

test('hata kısıtı: eşikte IP kilitlenir, başarıda sıfırlanır', async () => {
  const k = new ErrorLimit({ maxErrors: 3, windowMs: 1000, lockMs: 5000 });
  assert.equal(k.isLocked('1.1.1.1', 0), 0);
  k.error('1.1.1.1', 0); k.error('1.1.1.1', 1); assert.equal(k.isLocked('1.1.1.1', 2), 0);
  k.error('1.1.1.1', 3);
  assert.ok(k.isLocked('1.1.1.1', 4) > 0);
  assert.equal(k.isLocked('1.1.1.1', 6000), 0);
  k.error('2.2.2.2', 0); k.success('2.2.2.2'); k.error('2.2.2.2', 1); k.error('2.2.2.2', 2);
  assert.equal(k.isLocked('2.2.2.2', 3), 0);
});

test('roller: yerleşik değişmez, özel rol CRUD, * yasak, kullanımdaki silinemez, yükseltme engeli', async () => {
  const { repo, clear } = await newRepo({ roleInUse: (id) => id === 'kullanimda' });
  try {
    assert.ok(repo.roleVar('admin') && repo.roleVar('technical') && repo.roleVar('network') && repo.roleVar('accounting') && !repo.roleVar('user') && !repo.roleVar('ozel1'));
    // DC rolleri: izinleri bos dogar, yalniz izin listesi degisir, silinmez; * verilemez
    assert.deepEqual(repo.rolePermissions('technical'), []);
    assert.deepEqual((await repo.updateRole('technical', { permissions: ['live.view'] })).permissions, ['live.view']);
    assert.equal(await errorCode(() => repo.updateRole('technical', { permissions: ['*'] })), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.updateRole('technical', { permissions: ['member.manage'] }, ['live.view'])), 'PRIVILEGE_ESCALATION');
    assert.equal(await errorCode(() => repo.removeRole('technical')), 'BUILTIN_IMMUTABLE');
    assert.equal(await errorCode(() => repo.updateRole('admin', { permissions: ['live.view'] })), 'BUILTIN_IMMUTABLE');
    assert.equal(await errorCode(() => repo.removeRole('admin')), 'BUILTIN_IMMUTABLE');
    assert.equal(await errorCode(() => repo.addRole({ id: 'Kötü Ad', name: 'x', permissions: ['live.view'] }, 'admin')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.addRole({ id: 'ozel1', name: 'Özel', permissions: ['*'] }, 'admin')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.addRole({ id: 'ozel1', name: 'Özel', permissions: ['yok.izin'] }, 'admin')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.addRole({ id: 'ozel1', name: 'Özel', permissions: [] }, 'admin')), 'INVALID_REQUEST');
    const r = await repo.addRole({ id: 'ozel1', name: 'Özel', description: 'deneme', permissions: ['live.view', 'recording.*'] }, 'admin');
    assert.deepEqual(r.permissions, ['live.view', 'recording.*']);
    assert.equal(r.name.tr, 'Özel');
    assert.ok(hasPermission(repo.rolePermissions('ozel1'), 'recording.download'));
    assert.equal(await errorCode(() => repo.addRole({ id: 'ozel1', name: 'x', permissions: ['live.view'] }, 'admin')), 'CONFLICT');
    assert.deepEqual((await repo.updateRole('ozel1', { permissions: ['live.view'] })).permissions, ['live.view']);
    // yükseltme: sahibi yalnız live.view olan biri recording.* içeren rol veremez
    assert.equal(await errorCode(() => repo.addRole({ id: 'ozel2', name: 'x', permissions: ['recording.play'] }, 'k', ['live.view'])), 'PRIVILEGE_ESCALATION');
    await repo.addRole({ id: 'kullanimda', name: 'k', permissions: ['live.view'] }, 'admin');
    assert.equal(await errorCode(() => repo.removeRole('kullanimda')), 'CONFLICT');
    await repo.removeRole('ozel1');
    assert.ok(!repo.roleVar('ozel1'));
  } finally { await clear(); }
});

test('API anahtarı: oluşturma, biçim, özet saklama, doğrulama, kalıcılık', async () => {
  const { repo, db, secret, clear } = await newRepo();
  await customRoles(repo);
  try {
    const { record, key } = await repo.createKey({ name: 'mobil', role: 'user', scope: { devices: ['aaaa1111'] }, ips: ['10.0.0.0/24'], rateLimit: 30, concurrentStreams: 2 }, 'admin');
    assert.match(key, /^kp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(record.hash, undefined);
    assert.ok(record.permissionsEffective.includes('recording.download') && !record.permissionsEffective.includes('device.manage'));
    const fileText = JSON.stringify(await db.query('SELECT * FROM api_keys'));
    assert.ok(!fileText.includes(key.slice('kp_12345678_'.length)), 'gizli düz metin saklanmamalı');
    assert.ok(fileText.includes('"hash"'));
    const a = repo.verifyKey(key, '10.0.0.9');
    assert.equal(a.id, record.id);
    assert.equal(repo.findKey(record.id).counter, 0);
    repo.saveUsage(record.id, '10.0.0.9');
    assert.equal(repo.findKey(record.id).counter, 1);
    assert.equal(repo.findKey(record.id).lastUsed.ip, '10.0.0.9');
    // IP kısıtı
    assert.equal(await errorCode(() => repo.verifyKey(key, '8.8.8.8')), 'IP_BLOCKED');
    // yanlış gizli / biçim
    assert.equal(await errorCode(() => repo.verifyKey(`kp_${record.id}_${'A'.repeat(43)}`, '10.0.0.9')), 'INVALID_KEY');
    assert.equal(await errorCode(() => repo.verifyKey('abc', '10.0.0.9')), 'INVALID_KEY');
    assert.equal(await errorCode(() => repo.verifyKey(undefined, '10.0.0.9')), 'INVALID_KEY');
    // kapat → yeniden yükle: anahtar hâlâ doğrulanır
    await repo.close();
    const repo2 = await new PermissionStore(db, secret).load();
    assert.equal(repo2.verifyKey(key, '10.0.0.9').id, record.id);
    // başka gizli anahtarla (başka sunucu) doğrulanmaz
    const repo3 = await new PermissionStore(db, randomBytes(32)).load();
    assert.equal(await errorCode(() => repo3.verifyKey(key, '10.0.0.9')), 'INVALID_KEY');
  } finally { await clear(); }
});

test('API anahtarı: alanlar doğrulanır, yükseltme ve kapsam taşması engellenir', async () => {
  const { repo, clear } = await newRepo();
  await customRoles(repo);
  try {
    assert.equal(await errorCode(() => repo.createKey({ name: '', role: 'user' }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x' }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', role: 'yok' }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', permissions: ['yok.izin'] }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', role: 'user', expiresAt: '2001-01-01' }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', role: 'user', rateLimit: 0 }, 'a')), 'INVALID_REQUEST');
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', role: 'user', concurrentStreams: 99 }, 'a')), 'INVALID_REQUEST');
    // yükseltme: sahibin izni yalnız live.view
    const parent = { parentPermissions: ['live.view'], channelTotal: CHANNEL_TOTAL, deviceIdOf };
    assert.equal(await errorCode(() => repo.createKey({ name: 'x', role: 'user' }, 'u', parent)), 'PRIVILEGE_ESCALATION');
    assert.ok((await repo.createKey({ name: 'x', permissions: ['live.view'] }, 'u', parent)).key);
    // kapsam: sahip yalnız cihaz A
    const restricted = { parentPermissions: ['*'], parentScope: { devices: ['aaaa1111'] }, channelTotal: CHANNEL_TOTAL, deviceIdOf };
    assert.equal(await errorCode(() => repo.createKey({ name: 'y', role: 'user' }, 'u', restricted)), 'PRIVILEGE_ESCALATION');                    // kapsamsız
    assert.equal(await errorCode(() => repo.createKey({ name: 'y', role: 'user', scope: { devices: ['bbbb2222'] } }, 'u', restricted)), 'PRIVILEGE_ESCALATION');
    assert.ok((await repo.createKey({ name: 'y', role: 'user', scope: { channels: [1, 2] } }, 'u', restricted)).key);
  } finally { await clear(); }
});

test('API anahtarı: süre, iptal, yenileme, silme, hata kısıtı', async () => {
  const { repo, clear } = await newRepo();
  await customRoles(repo);
  try {
    const { record, key } = await repo.createKey({ name: 'a', role: 'viewer' }, 'admin');
    // süre dolumu (dosyaya bitiş yazıp yeniden hesapla)
    const a = repo.data.keys[0];
    a.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(await errorCode(() => repo.verifyKey(key, '1.1.1.1')), 'EXPIRED');
    a.expiresAt = null;
    assert.equal(repo.verifyKey(key, '1.1.1.1').id, record.id);
    // yenileme: eski gizli geçersiz, yeni geçerli, kimlik aynı
    const fresh = await repo.rotateKey(record.id);
    assert.equal(fresh.record.id, record.id);
    assert.equal(await errorCode(() => repo.verifyKey(key, '1.1.1.1')), 'INVALID_KEY');
    assert.equal(repo.verifyKey(fresh.key, '1.1.1.1').id, record.id);
    // güncelleme
    assert.equal((await repo.updateKey(record.id, { name: 'b', rateLimit: 10 })).name, 'b');
    assert.equal(await errorCode(() => repo.updateKey(record.id, { role: 'yok' })), 'INVALID_REQUEST');
    // iptal: doğrulama KEY_REVOKED; güncelleme/yenileme reddedilir
    await repo.revokeKey(record.id, 'admin');
    assert.equal(await errorCode(() => repo.verifyKey(fresh.key, '1.1.1.1')), 'KEY_REVOKED');
    assert.equal(await errorCode(() => repo.rotateKey(record.id)), 'CONFLICT');
    assert.equal(await errorCode(() => repo.updateKey(record.id, { name: 'c' })), 'CONFLICT');
    assert.equal(repo.findKey(record.id).active, false);
    await repo.removeKey(record.id);
    assert.equal(repo.findKey(record.id), null);
    assert.equal(await errorCode(() => repo.removeKey(record.id)), 'NOT_FOUND');
    // kaba kuvvet: 10 hatadan sonra kilit (doğru anahtar bile reddedilir)
    const { key: good } = await repo.createKey({ name: 'k', role: 'viewer' }, 'admin');
    for (let i = 0; i < 10; i++) errorCode(() => repo.verifyKey('kp_00000000_' + 'A'.repeat(43), '9.9.9.9'));
    assert.equal(await errorCode(() => repo.verifyKey(good, '9.9.9.9')), 'TOO_MANY_ATTEMPTS');
    assert.equal(repo.verifyKey(good, '9.9.9.10') ? 'tamam' : '', 'tamam');       // başka IP etkilenmez
  } finally { await clear(); }
});

test('Asal: izin, kapsam, günlük adı', async () => {
  const ctx = { deviceIdOf, channelTotal: () => CHANNEL_TOTAL };
  const member = new Principal({ type: 'member', name: 'ali', identity: 'member:ali', role: 'user', permissions: ['live.view', 'recording.list', 'recording.play', 'recording.download'] }, ctx);
  assert.ok(member.hasPermission('live.view') && !member.hasPermission('device.manage'));
  assert.ok(member.channelAllowed(7) && member.isUnscoped());
  assert.equal(member.auditActor, 'ali');
  const key = new Principal({ type: 'key', name: 'mobil', identity: 'key:ab12', keyId: 'ab12', permissions: ['live.view'], scope: { devices: ['bbbb2222'] }, method: 'key' }, ctx);
  assert.ok(key.channelAllowed(5) && !key.channelAllowed(1));
  assert.equal(key.auditActor, 'key:ab12');
  assert.ok(key.anyPermission(['recording.play', 'live.view']) && !key.anyPermission(['recording.play']));
  assert.deepEqual(key.toPublic().permissions, ['live.view']);
});

test('hız sınırı ve eşzamanlı akış: asal başına', async () => {
  const { repo, clear } = await newRepo();
  await customRoles(repo);
  try {
    const principal = new Principal({ type: 'key', identity: 'key:z', rateLimit: 2, concurrentStreams: 1, permissions: ['live.view'] }, {});
    repo.attemptRate(principal, 1000); repo.attemptRate(principal, 1001);
    const e = (() => { try { repo.attemptRate(principal, 1002); } catch (x) { return x; } })();
    assert.equal(e.code, 'RATE_LIMIT'); assert.equal(e.status, 429); assert.ok(e.extra.retryAfterSec >= 1);
    const release = repo.openStream(principal);
    assert.equal(await errorCode(() => repo.openStream(principal)), 'STREAM_LIMIT');
    release(); release();                                  // ikinci çağrı zararsız
    const release2 = repo.openStream(principal); release2();
    const unlimited = new Principal({ type: 'member', identity: 'member:s', concurrentStreams: 3, permissions: [] }, {});
    const b = [repo.openStream(unlimited), repo.openStream(unlimited), repo.openStream(unlimited)];
    assert.equal(await errorCode(() => repo.openStream(unlimited)), 'STREAM_LIMIT');
    b.forEach((f) => f());
    // ayni ortak akis (ikinci sekme) hak harcamaz; farkli akis harcar; son izleyici birakinca hak geri gelir
    const s1 = new Principal({ type: 'member', identity: 'member:o', concurrentStreams: 2, permissions: [] }, {});
    const o = [repo.openStream(s1, 'live:1'), repo.openStream(s1, 'live:1'), repo.openStream(s1, 'live:1'), repo.openStream(s1, 'live:2')];
    assert.equal(await errorCode(() => repo.openStream(s1, 'live:3')), 'STREAM_LIMIT');
    assert.equal(await errorCode(() => repo.openStream(s1)), 'STREAM_LIMIT');
    const o2 = repo.openStream(s1, 'live:2'); o2();
    o[0](); o[1]();
    assert.equal(await errorCode(() => repo.openStream(s1, 'live:3')), 'STREAM_LIMIT');   // live:1'in bir izleyicisi hala var
    o[2](); const o3 = repo.openStream(s1, 'live:3');
    o3(); o[3]();
    assert.equal(repo.streams.has('member:o'), false);
  } finally { await clear(); }
});
