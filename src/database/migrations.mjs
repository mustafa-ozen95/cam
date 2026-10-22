/**
 * Database migrations: ORDERED and IMMUTABLE. A schema change is added as a new version; an existing migration is never edited
 * (it may already be applied in production). Timestamps are stored as ISO text so values from the JSON era are kept verbatim.
 * Every table's first column is "seq" (insertion order), the second is the natural key.
 *
 * A migration is either `sql` (statements) or `run(conn)`: a data migration that runs inside ONE transaction together with its row in the
 * `migrations` table (an error rolls everything back). Data migrations are idempotent: converting an already converted value changes nothing.
 * A data migration receives `(conn, { secret, log })`: the panel's secret key (Buffer; absent when only the schema is being prepared) and a logger.
 */
import { createHmac, createHash } from 'node:crypto';
import * as legacy from './legacy-names.mjs';
import { auditSignature, devicePasswordKey, keyFingerprint, seal, unseal } from '../core/crypto-labels.mjs';

const ENGINE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const MIGRATIONS = [
  {
    version: 1, name: 'initial schema',
    sql: [
      `CREATE TABLE users (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL, role VARCHAR(64) NULL, salt CHAR(32) NULL, hash CHAR(64) NULL,
        created_at VARCHAR(40) NULL, session_version INT NULL DEFAULT 0,
        scope TEXT NULL, expires_at VARCHAR(40) NULL, ips TEXT NULL, preferences TEXT NULL, extra TEXT NULL,
        UNIQUE KEY users_name (name)
      ) ${ENGINE}`,
      `CREATE TABLE devices (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(64) NOT NULL, name VARCHAR(255) NULL, type VARCHAR(32) NULL, host VARCHAR(255) NULL, username VARCHAR(64) NULL,
        password TEXT NULL, label VARCHAR(16) NULL, channel_count INT NULL, http_port INT NULL, rtsp_port INT NULL, port INT NULL,
        template VARCHAR(32) NULL, path VARCHAR(255) NULL, start_index INT NULL, created_at VARCHAR(40) NULL, extra TEXT NULL,
        UNIQUE KEY devices_id (id)
      ) ${ENGINE}`,
      `CREATE TABLE audit_log (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ts VARCHAR(32) NOT NULL, local_time VARCHAR(64) NULL, event VARCHAR(100) NOT NULL, username VARCHAR(512) NULL, ip VARCHAR(100) NULL,
        forwarded TEXT NULL, previous_signature CHAR(64) NOT NULL, signature CHAR(64) NOT NULL,
        record LONGTEXT NOT NULL,
        KEY audit_log_event (event), KEY audit_log_ts (ts)
      ) ${ENGINE}`,
      `CREATE TABLE roles (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(32) NOT NULL, name VARCHAR(255) NULL, description TEXT NULL, permissions TEXT NULL, created_by VARCHAR(255) NULL, created_at VARCHAR(40) NULL, extra TEXT NULL,
        UNIQUE KEY roles_id (id)
      ) ${ENGINE}`,
      `CREATE TABLE builtin_role_permissions (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        role VARCHAR(32) NOT NULL, permissions TEXT NULL, extra TEXT NULL,
        UNIQUE KEY builtin_role_permissions_role (role)
      ) ${ENGINE}`,
      `CREATE TABLE api_keys (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        id VARCHAR(32) NOT NULL, name VARCHAR(255) NULL, prefix VARCHAR(64) NULL, hash CHAR(64) NULL, role VARCHAR(32) NULL, permissions TEXT NULL,
        scope TEXT NULL, expires_at VARCHAR(40) NULL, ips TEXT NULL, rate_limit INT NULL, concurrent_streams INT NULL,
        owner VARCHAR(255) NULL, created_by VARCHAR(255) NULL, created_at VARCHAR(40) NULL, last_used TEXT NULL, counter BIGINT NULL DEFAULT 0,
        revoked TEXT NULL, notes TEXT NULL, version INT NULL, extra TEXT NULL,
        UNIQUE KEY api_keys_id (id)
      ) ${ENGINE}`,
      `CREATE TABLE hub_links (
        seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        sub VARCHAR(128) NOT NULL, username VARCHAR(64) NULL, user_stamp VARCHAR(40) NULL, email VARCHAR(255) NULL, role VARCHAR(64) NULL,
        can_login TINYINT(1) NULL, checked_at VARCHAR(40) NULL, last_login VARCHAR(40) NULL, last_logout_ms BIGINT NULL, extra TEXT NULL,
        UNIQUE KEY hub_links_sub (sub)
      ) ${ENGINE}`,
      `CREATE TABLE settings (
        name VARCHAR(64) NOT NULL PRIMARY KEY, value LONGTEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ${ENGINE}`,
    ],
  },
  {
    // Turkish-era stored names -> English: permission ids, built-in role ids, scope/preference keys, device type/template, password envelope
    // keys, key usage records and the settings documents. audit_log is NOT touched (its rows are signed over their original text).
    version: 2, name: 'english names',
    run: async (c) => {
      const text = (f) => (v) => (v === null || v === undefined ? v : f(v));
      const json = (f) => (v) => {
        if (v === null || v === undefined) return v;
        let o; try { o = JSON.parse(v); } catch { return v; }   // not JSON: not ours to touch
        const fresh = JSON.stringify(f(o));
        return fresh === JSON.stringify(o) ? v : fresh;   // degismediyse metin aynen kalir (bicim bozulmaz)
      };
      /** Converts the given columns row by row; only changed rows are written. */
      const convert = async (table, columns) => {
        const names = Object.keys(columns);
        const [rows] = await c.query(`SELECT seq, ${names.join(', ')} FROM ${table}`);
        for (const row of rows) {
          const change = {};
          for (const n of names) { const fresh = columns[n](row[n]); if (fresh !== row[n]) change[n] = fresh; }
          if (Object.keys(change).length) await c.query(`UPDATE ${table} SET ${Object.keys(change).map((n) => `${n} = ?`).join(', ')} WHERE seq = ?`, [...Object.values(change), row.seq]);
        }
      };
      await convert('users', { role: text(legacy.roleId), scope: json(legacy.scope), preferences: json(legacy.preferences) });
      await convert('devices', { type: text(legacy.deviceType), template: text(legacy.deviceTemplate), password: json(legacy.envelope) });
      await convert('hub_links', { role: text(legacy.roleId) });
      await convert('roles', { permissions: json(legacy.permissionList) });
      await convert('builtin_role_permissions', { role: text(legacy.roleId), permissions: json(legacy.permissionList) });
      await convert('api_keys', {
        role: text(legacy.roleId), permissions: json(legacy.permissionList), scope: json(legacy.scope),
        last_used: json(legacy.keyLastUsed), revoked: json(legacy.keyRevoked),
      });
      const documents = { channels: legacy.channelsDoc, 'live-layout': legacy.layoutDoc, 'update-status': legacy.updateStatusDoc };
      for (const [name, f] of Object.entries(documents)) {
        const [found] = await c.query('SELECT value FROM settings WHERE name = ?', [name]);
        const row = found[0];
        if (!row) continue;
        const fresh = json(f)(row.value);
        if (fresh !== row.value) await c.query('UPDATE settings SET value = ? WHERE name = ?', [fresh, name]);
      }
    },
  },
  {
    // Cryptographic purpose labels -> English (src/core/crypto-labels.mjs). The PREVIOUS labels below are DATA: they are what the stored values were
    // made with and must stay as written.
    //  - device passwords: decrypted with the old key, encrypted again with the new one
    //  - audit log chain: verified with the old signing, then every record is signed again in the same order (record text and order unchanged)
    //  - key fingerprint (settings): recomputed
    //  - API keys: stored only as a one-way hash, so they cannot be moved to the new label: every active key is REVOKED (logged with its count)
    //  - session / sign-in flow cookies are short-lived and simply stop working
    version: 3, name: 'english crypto labels',
    run: async (c, { secret, log = console.log } = {}) => {
      // previous labels (API keys: 'kamera2/api-anahtar', unused here: the hash cannot be moved; the audit chain had no label)
      const OLD = { devicePassword: 'kamera2-cihaz-parola', fingerprint: 'cam/anahtar-izi' };
      const needSecret = () => { if (!secret) throw new Error('Göç 3 gizli anahtarı ister (CAM_SECRET_KEY ya da data/secret.key)'); return secret; };
      const WRONG_KEY = 'Gizli anahtar bu veritabanını dolduran anahtarla aynı değil (CAM_SECRET_KEY ya da data/secret.key). Doğru anahtarı verin; anahtar kaybolduysa kayıtlı cihaz parolaları yeniden girilmelidir.';
      const done = { fingerprint: false, devices: 0, audit: 0, keys: 0 };

      // 1) key fingerprint: checked FIRST, so a wrong key stops the migration before anything is rewritten
      const [saved] = await c.query("SELECT value FROM settings WHERE name = 'key-fingerprint'");
      if (saved.length) {
        const current = JSON.parse(saved[0].value);
        const previous = createHmac('sha256', needSecret()).update(OLD.fingerprint).digest('hex');
        if (current !== previous && current !== keyFingerprint(secret)) throw new Error(WRONG_KEY);
      }

      // 2) audit log chain
      const rows = async (after) => (await c.query('SELECT id, record FROM audit_log WHERE id > ? ORDER BY id LIMIT 500', [after]))[0];
      const oldSign = (text) => createHmac('sha256', needSecret()).update(text).digest('hex');   // the chain used to be signed without a label
      const walk = async (sign) => {
        let previous = '', n = 0, last = 0;
        for (let batch = await rows(last); batch.length; batch = await rows(last)) {
          for (const r of batch) {
            n++; last = r.id;
            let k; try { k = JSON.parse(r.record); } catch { return { ok: false, record: n }; }
            previous = legacy.auditChainStep(k, previous, sign);
            if (previous === null) return { ok: false, record: n };
          }
        }
        return { ok: true, record: n };
      };
      const [[total]] = await c.query('SELECT COUNT(*) AS n FROM audit_log');
      if (Number(total.n) > 0) {
        const newSign = (text) => auditSignature(needSecret(), text);
        const before = await walk(oldSign);
        if (before.ok) {
          let previous = '', last = 0;
          for (let batch = await rows(last); batch.length; batch = await rows(last)) {
            for (const r of batch) {
              last = r.id;
              const k = JSON.parse(r.record), isLegacy = legacy.isLegacyAuditRecord(k);
              const sigKey = isLegacy ? 'imza' : 'signature', prevKey = isLegacy ? 'onceki' : 'previous';
              k[prevKey] = previous;                       // existing keys keep their position: the text differs only in these two values
              const { [sigKey]: _old, ...rest } = k;
              k[sigKey] = newSign(previous + JSON.stringify(rest));
              await c.query('UPDATE audit_log SET previous_signature = ?, signature = ?, record = ? WHERE id = ?', [previous, k[sigKey], JSON.stringify(k), r.id]);
              previous = k[sigKey]; done.audit++;
            }
          }
          const after = await walk(newSign);
          if (!after.ok || after.record !== before.record) throw new Error(`Göç 3: günlük zinciri yeniden imzalandıktan sonra doğrulanamadı (${after.record}. kayıt)`);
        } else if (!(await walk(newSign)).ok) {
          throw new Error(`Göç 3: günlük zinciri doğrulanamadı (${before.record}. kayıtta bozuk ya da farklı anahtar); göç durdu, hiçbir şey değişmedi`);
        }   // else: zaten yeni etiketle imzalı
      }

      // 3) device passwords
      const [devices] = await c.query('SELECT seq, id, password FROM devices');
      if (devices.some((d) => d.password)) {
        const oldKey = createHash('sha256').update(`${OLD.devicePassword}|${needSecret().toString('hex')}`).digest(), newKey = devicePasswordKey(secret);
        for (const d of devices) {
          let o = null; try { o = d.password ? JSON.parse(d.password) : null; } catch { /* not an envelope */ }
          if (!o || typeof o !== 'object' || !o.iv || !o.tag || !o.data) continue;
          let plain;
          try { plain = unseal(oldKey, o); }
          catch {
            try { unseal(newKey, o); continue; } catch { /* neither: stop below */ }   // already moved
            throw new Error(`Göç 3: ${d.id} cihazının parolası çözülemedi (gizli anahtar yanlış olabilir); göç durdu, hiçbir şey değişmedi`);
          }
          await c.query('UPDATE devices SET password = ? WHERE seq = ?', [JSON.stringify(seal(newKey, plain)), d.seq]); done.devices++;
        }
      }

      // 4) API keys: not movable (one-way hash); revoke active ones once
      const [keys] = await c.query('SELECT seq, revoked FROM api_keys');
      const mark = JSON.stringify({ at: new Date().toISOString(), by: 'migration 3' });
      for (const k of keys) if (!k.revoked) { await c.query('UPDATE api_keys SET revoked = ? WHERE seq = ?', [mark, k.seq]); done.keys++; }

      // 5) fingerprint
      if (saved.length) { await c.query("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE name = 'key-fingerprint'", [JSON.stringify(keyFingerprint(secret))]); done.fingerprint = true; }

      log(`goc 3 (kripto etiketleri): ${done.audit} günlük kaydı yeniden imzalandı, ${done.devices} cihaz parolası yeniden şifrelendi, ${done.keys} API anahtarı iptal edildi (karması etiketle taşınamaz; yenileri oluşturulmalı), parmak izi ${done.fingerprint ? 'güncellendi' : 'yok (yeni kurulum)'}`);
    },
  },
];
