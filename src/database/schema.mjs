/**
 * Table definitions (for the Koleksiyon in src/core/tables.mjs): database column <-> field of the in-memory object.
 * A schema change goes into migrations.mjs as a new version; this file only holds the mapping.
 */
const s = (column, field, empty) => ({ s: column, a: field ?? column, t: 's', empty: empty });
const i = (column, field, empty) => ({ s: column, a: field, t: 'i', empty: empty });
const j = (column, field, empty) => ({ s: column, a: field, t: 'j', empty: empty });

export const MEMBERS = {
  table: 'users', key: 'name',
  columns: [s('name', 'name'), s('role', 'role'), s('salt', 'salt'), s('hash', 'hash'), s('created_at', 'createdAt'), i('session_version', 'sessionVersion', 0), j('scope', 'scope', null),
    s('expires_at', 'expiresAt', null), j('ips', 'ips', []), j('preferences', 'preferences')],
};
export const DEVICES = {
  table: 'devices', key: 'id',
  columns: [s('id'), s('name', 'name', ''), s('type', 'type'), s('host', 'host'), s('username', 'username'), j('password', 'password'), s('label', 'label'), i('channel_count', 'channelCount'),
    i('http_port', 'httpPort'), i('rtsp_port', 'rtspPort'), i('port', 'port'), s('template', 'template'), s('path', 'path'), i('start_index', 'startIndex'), s('created_at', 'createdAt')],
};
export const ROLES = {
  table: 'roles', key: 'id',
  columns: [s('id'), s('name', 'name'), s('description', 'description'), j('permissions', 'permissions', []), s('created_by', 'createdBy'), s('created_at', 'createdAt')],
};
export const BUILTIN_PERMISSIONS = {
  table: 'builtin_role_permissions', key: 'role',
  columns: [s('role', 'role'), j('permissions', 'permissions', [])],
};
export const API_KEYS = {
  table: 'api_keys', key: 'id',
  columns: [s('id'), s('name', 'name'), s('prefix', 'prefix'), s('hash', 'hash'), s('role', 'role', null), j('permissions', 'permissions', []), j('scope', 'scope', null), s('expires_at', 'expiresAt', null),
    j('ips', 'ips', []), i('rate_limit', 'rateLimit'), i('concurrent_streams', 'concurrentStreams'), s('owner', 'owner', null), s('created_by', 'createdBy'), s('created_at', 'createdAt'),
    j('last_used', 'lastUsed', null), i('counter', 'counter', 0), j('revoked', 'revoked', null), s('notes', 'notes', ''), i('version', 'version')],
};
export const HUB_LINKS = {
  table: 'hub_links', key: 'sub',
  columns: [s('sub'), s('username', 'name'), s('user_stamp', 'userStamp'), s('email', 'email'), s('role', 'role', null), { s: 'can_login', a: 'canLogin', t: 'b' }, s('checked_at', 'check', null),
    s('last_login', 'lastLogin', null), i('last_logout_ms', 'lastLogout')],
};
