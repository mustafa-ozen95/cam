/**
 * Bir kerelik veri aktarimi: JSON donemindeki data/ dosyalari -> veritabani tablolari.
 *
 * Acilista tablolar BOS ve data/ klasorunde eski dosyalar varsa hepsi TEK islemde aktarilir:
 *   1) dosyalar okunur ve eski bicim dönüşümleri uygulanir (uye damgasi, merkez bagi damgasi, cihaz ust siniri, yetki varsayilanlari);
 *   2) tek islemde tablolara yazilir;
 *   3) ayni islemde sayilar kaynakla karsilastirilir, gunluk imza zinciri VERITABANINDAN dogrulanir, ayarlar geri okunup karsilastirilir;
 *   4) hepsi tutarsa islem onaylanir, ardindan dosyalar `<ad>.imported` adiyla yeniden adlandirilir (SILINMEZ).
 * Tutmayan bir sey olursa islem geri alinir, dosyalara dokunulmaz ve acilis durur (hata iletisi nedeni soyler).
 * Tablolar doluysa ve eski dosyalar duruyorsa: dokunulmaz, uyari yazilir.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Settings, Collection } from '../core/tables.mjs';
import * as legacy from './legacy-names.mjs';
import { API_KEYS, DEVICES, HUB_LINKS, ROLES, MEMBERS, BUILTIN_PERMISSIONS } from './schema.mjs';

export const LEGACY_FILES = ['kullanicilar.json', 'yetki.json', 'cihazlar.json', 'kanallar.json', 'gunluk.jsonl', 'merkez-baglari.json', 'guncelleme.json', 'live-duzen.json'];
const PART = 500;

const read = (path, name) => { try { return readFileSync(path, 'utf8'); } catch (e) { throw new Error(`${name} okunamadı: ${e.message}`); } };
const readJson = (path, name) => { const m = read(path, name); try { return JSON.parse(m); } catch (e) { throw new Error(`${name} geçerli JSON değil: ${e.message}`); } };

/** Eski dosyalardaki verinin bellege yuklenirken uygulanan donusumleri (JSON donemindeki kurucularin yaptiklari). */
export function convertLegacyData({ users, permissions, devices, hubLinks }) {
  const now = new Date().toISOString();
  const members = (users ?? []).map((u) => ({ ...u, createdAt: u.createdAt || now }));
  const links = {};
  for (const [sub, b] of Object.entries(hubLinks ?? {})) {
    if (b.userStamp) { links[sub] = b; continue; }
    const u = members.find((x) => x.name.toLowerCase() === String(b.name).toLowerCase());
    if (u) links[sub] = { ...b, userStamp: u.createdAt };   // uyesi olmayan eski bag atilir
  }
  const y = { version: 1, roles: {}, keys: [], builtinPermissions: {}, ...(permissions ?? {}) };
  const deviceList = devices?.devices ?? [];
  const blockLimit = Math.max(Number(devices?.blockLimit) || 0, deviceList.reduce((m, c) => Math.max(m, c.startIndex + c.channelCount), 0));
  return { members, links, permissions: y, deviceList, blockLimit };
}

/** Gunluk zincirini kayit metinlerinden dogrular (veritabani donemindeki Gunluk.dogrula ile ayni kural). */
function verifyChain(texts, sign) {
  let previous = '', n = 0;
  for (const m of texts) {
    n++;
    let k; try { k = JSON.parse(m); } catch { return `${n}. günlük satırı okunamıyor`; }
    const signature = legacy.auditChainStep(k, previous, sign);   // works on the record as stored (legacy or current names)
    if (!signature) return `${n}. günlük kaydında zincir bozuk (${k.time ?? k.z})`;
    previous = signature;
  }
  return null;
}

async function areTablesEmpty(db) {
  for (const t of ['users', 'devices', 'audit_log', 'roles', 'builtin_role_permissions', 'api_keys', 'hub_links']) {
    const [[r]] = await db.pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
    if (Number(r.n) > 0) return false;
  }
  const [[a]] = await db.pool.query("SELECT COUNT(*) AS n FROM settings WHERE name <> 'key-fingerprint'");
  return Number(a.n) === 0;
}

/** Dondurur: { status: 'none' | 'skipped' | 'imported', counts } */
export async function importLegacyData({ db, dataDir, secret, writeAuditLog = console.log }) {
  const var_ = LEGACY_FILES.filter((d) => existsSync(join(dataDir, d)));
  if (!var_.length) return { status: 'none' };
  if (!(await areTablesEmpty(db))) {
    writeAuditLog(`UYARI: data/ klasöründe eski JSON dosyaları var (${var_.join(', ')}) ama veritabanı tabloları dolu; dosyalara dokunulmadı. Veri artık veritabanında; bu dosyaları yedekledikten sonra silebilirsiniz.`);
    return { status: 'skipped' };
  }
  const path = (d) => join(dataDir, d);
  const sign = (m) => createHmac('sha256', secret).update(m).digest('hex');

  // 1) oku + donustur (veritabanina hic dokunmadan: bozuk dosya burada durdurur)
  const source = {
    users: var_.includes('kullanicilar.json') ? readJson(path('kullanicilar.json'), 'kullanicilar.json') : [],
    permissions: var_.includes('yetki.json') ? readJson(path('yetki.json'), 'yetki.json') : null,
    devices: var_.includes('cihazlar.json') ? readJson(path('cihazlar.json'), 'cihazlar.json') : null,
    hubLinks: var_.includes('merkez-baglari.json') ? readJson(path('merkez-baglari.json'), 'merkez-baglari.json') : {},
  };
  if (!Array.isArray(source.users)) throw new Error('kullanicilar.json bir dizi olmalı');
  // Turkish-era field and value names -> current names (idempotent: files that already use the current names pass through)
  source.users = source.users.map(legacy.memberRecord);
  if (source.permissions) source.permissions = legacy.permissionsFile(source.permissions);
  if (source.devices) source.devices = legacy.devicesFile(source.devices);
  source.hubLinks = Object.fromEntries(Object.entries(source.hubLinks).map(([sub, b]) => [sub, legacy.hubLinkRecord(b)]));
  const settingDocuments = {};
  const SETTING_FILES = [['kanallar.json', 'channels', legacy.channelsDoc], ['guncelleme.json', 'update-status', legacy.updateStatusDoc], ['live-duzen.json', 'live-layout', legacy.layoutDoc]];
  for (const [file, name, convert] of SETTING_FILES) if (var_.includes(file)) settingDocuments[name] = convert(readJson(path(file), file));
  const auditLines = var_.includes('gunluk.jsonl') ? read(path('gunluk.jsonl'), 'gunluk.jsonl').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const sourceChainError = verifyChain(auditLines, sign);
  if (sourceChainError) throw new Error(`gunluk.jsonl: ${sourceChainError}; imza zinciri doğrulanamadan aktarılmaz (yanlış gizli anahtar olabilir)`);
  const d = convertLegacyData(source);
  const roles = Object.entries(d.permissions.roles).map(([id, r]) => ({ id, ...r }));
  const builtin = Object.entries(d.permissions.builtinPermissions).map(([role, permissions]) => ({ role, permissions }));
  const links = Object.entries(d.links).map(([sub, b]) => ({ sub, ...b }));
  const expected = { users: d.members.length, devices: d.deviceList.length, roles: roles.length, builtin_role_permissions: builtin.length, api_keys: d.permissions.keys.length, hub_links: links.length, audit_log: auditLines.length };

  // 2) + 3) tek islemde yaz ve dogrula
  await db.transaction(async (c) => {
    await new Collection(db, MEMBERS).addBulk(c, d.members);
    await new Collection(db, DEVICES).addBulk(c, d.deviceList);
    await new Collection(db, ROLES).addBulk(c, roles);
    await new Collection(db, BUILTIN_PERMISSIONS).addBulk(c, builtin);
    await new Collection(db, API_KEYS).addBulk(c, d.permissions.keys);
    await new Collection(db, HUB_LINKS).addBulk(c, links);
    const settings = new Settings(db);
    if (source.devices) await settings.write('device-block-limit', d.blockLimit, c);
    for (const [name, value] of Object.entries(settingDocuments)) await settings.write(name, value, c);
    for (let i = 0; i < auditLines.length; i += PART) {
      const rows = auditLines.slice(i, i + PART).map((m) => { const k = legacy.auditRecordView(JSON.parse(m)); return [k.time, k.localTime ?? null, String(k.event).slice(0, 100), k.username == null ? null : String(k.username).slice(0, 512), k.ip == null ? null : String(k.ip).slice(0, 100), k.forwarded ? JSON.stringify(k.forwarded) : null, k.previous, k.signature, m]; });
      await c.query('INSERT INTO audit_log (ts, local_time, event, username, ip, forwarded, previous_signature, signature, record) VALUES ?', [rows]);
    }
    // sayilar
    for (const [table, n] of Object.entries(expected)) {
      const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM ${table}`);
      if (Number(r.n) !== n) throw new Error(`Aktarım tutarsız: ${table} tablosunda ${r.n} satır var, kaynakta ${n}`);
    }
    // zincir (veritabanindan)
    const [records] = await c.query('SELECT record FROM audit_log ORDER BY id');
    const zh = verifyChain(records.map((x) => x.record), sign);
    if (zh) throw new Error(`Aktarım sonrası günlük zinciri doğrulanamadı: ${zh}`);
    // ayarlar geri okuma
    for (const [name, value] of Object.entries(settingDocuments)) {
      const [[r]] = await c.query('SELECT value FROM settings WHERE name = ?', [name]);
      if (JSON.stringify(JSON.parse(r.value)) !== JSON.stringify(value)) throw new Error(`Aktarım tutarsız: settings/${name} kaynakla aynı değil`);
    }
  });

  // 4) onaylandi: dosyalar yeniden adlandirilir (silinmez)
  const renamed = [];
  for (const file of var_) {
    let target = `${path(file)}.imported`;
    if (existsSync(target)) target = `${target}.${Date.now()}`;
    renameSync(path(file), target); renamed.push(file);
  }
  writeAuditLog(`eski veri aktarıldı: ${Object.entries(expected).map(([t, n]) => `${t}=${n}`).join(', ')}; settings=${Object.keys(settingDocuments).join(',') || '-'}; günlük zinciri doğrulandı; dosyalar .imported adıyla saklandı (${renamed.join(', ')})`);
  return { status: 'imported', counts: expected };
}
