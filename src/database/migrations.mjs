/**
 * Database migrations: ORDERED and IMMUTABLE. A schema change is added as a new version; an existing migration is never edited
 * (it may already be applied in production). Timestamps are stored as ISO text so values from the JSON era are kept verbatim.
 * Every table's first column is "seq" (insertion order), the second is the natural key.
 */
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
];
