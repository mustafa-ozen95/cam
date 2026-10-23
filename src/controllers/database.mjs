/**
 * Veritabani sekmesi (database.manage): nerede, uzak sunucuya TASI ya da mevcut veritabanina BAGLAN. DC panellerindeki
 * Ayarlar -> Veritabani'nin karsiligi (bkz. services/database-move.mjs).
 *
 * IKI ADIM: once SINA, sonra TASI/BAGLAN. Sinanan baglanti bellekte (uye basina, 15 dakika) durur; ikinci adim parolayi yeniden
 * istemez ama sinamalari yeniden yapar — arada hedef dolmus ya da yetki alinmis olabilir. Parola hicbir yanitta ve gunlukte yok.
 * Islemin kendisi acilista yapilir: bu uc istegi birakir ve paneli yeniden baslatir (restart()).
 */
import { readBody, json } from '../core/http.mjs';
import { RUNNING, address, allOk, cleanTarget, currentInfo, isInternal, testTarget } from '../services/database-move.mjs';

const TEST_LIFETIME_MS = 15 * 60 * 1000;
const HOST_RE = /^[A-Za-z0-9.-]+$/, DB_RE = /^[A-Za-z0-9_-]+$/;

export function databaseController({ db, auditLog, databaseMove }) {
  const { file, secret, restart, connect } = databaseMove;
  const tested = new Map();   // uye adi -> { hedef, islem, zaman }

  const testedOf = (ctx) => {
    const t = tested.get(ctx.principal.name);
    if (!t || Date.now() - t.time > TEST_LIFETIME_MS) { tested.delete(ctx.principal.name); return null; }
    return t;
  };
  const publicTested = (t) => (t ? { host: t.target.host, port: t.target.port, database: t.target.database, username: t.target.username, islem: t.operation, adres: address(t.target) } : null);

  async function summary(ctx) {
    const current = await currentInfo(db, file);
    const status = file.status();
    return {
      current, status,
      // Suren ya da biten bir islem varken yeni form gosterilmez.
      canStart: current.source === 'ortam' && !RUNNING.includes(status?.durum),
      tested: publicTested(testedOf(ctx)),
    };
  }

  function validate(b) {
    const t = cleanTarget(b);
    const errors = {};
    if (!t.host || t.host.length > 255 || !HOST_RE.test(t.host)) errors.host = 'Konak adı ya da IPv4 adresi girin.';
    if (!(t.port >= 1 && t.port <= 65535)) errors.port = 'Port 1-65535 arasında olmalı.';
    if (!t.database || t.database.length > 64 || !DB_RE.test(t.database)) errors.database = 'Veritabanı adında yalnızca harf, rakam, alt çizgi ve tire olabilir.';
    if (!t.username || t.username.length > 80) errors.username = 'Kullanıcı adı gerekli.';
    if (!t.password || t.password.length > 200) errors.password = 'Parola gerekli.';
    const operation = b.islem === 'baglan' ? 'baglan' : 'tasi';
    if (!errors.host && isInternal(t.host)) errors.host = 'Bu adres konteynerin kendisi; uzak sunucunun adresini girin.';
    return { target: t, operation, errors };
  }

  return {
    async info(ctx) { return json(ctx.res, 200, await summary(ctx)); },

    async test(ctx) {
      const { target, operation, errors } = validate(await readBody(ctx.req));
      if (Object.keys(errors).length) return json(ctx.res, 400, { error: Object.values(errors)[0], code: 'INVALID_REQUEST', fields: errors });
      const results = await testTarget({ target, operation, current: await currentInfo(db, file), secret, connect });
      const ok = allOk(results);
      if (ok) tested.set(ctx.principal.name, { target, operation, time: Date.now() }); else tested.delete(ctx.principal.name);
      return json(ctx.res, 200, {
        ...await summary(ctx), results, ok,
        message: ok ? (operation === 'baglan' ? 'Sınamalar geçti. Bağlanmak için aşağıdaki düğmeyi kullanın.' : 'Sınamalar geçti. Taşımak için aşağıdaki düğmeyi kullanın.')
          : (operation === 'baglan' ? 'Hedefe bağlanılamaz; ayrıntılar aşağıda.' : 'Hedef taşımaya uygun değil; ayrıntılar aşağıda.'),
      });
    },

    async migrate(ctx) {
      const body = await readBody(ctx.req);
      const t = testedOf(ctx);
      if (!t) return json(ctx.res, 409, { error: 'Önce bağlantıyı sınayın (sınama 15 dakika geçerli).', code: 'NOT_TESTED' });
      if (RUNNING.includes(file.stage())) return json(ctx.res, 409, { error: 'Süren ya da tamamlanmış bir taşıma var.', code: 'IN_PROGRESS' });
      const linking = t.operation === 'baglan';
      const results = await testTarget({ target: t.target, operation: t.operation, current: await currentInfo(db, file), secret, connect });
      if (!allOk(results)) {
        tested.delete(ctx.principal.name);
        return json(ctx.res, 409, { error: `Sınamalar artık geçmiyor; ${linking ? 'bağlanılmadı.' : 'taşıma başlatılmadı.'}`, code: 'TEST_FAILED', results });
      }
      const where = address(t.target);
      try {
        file.writeConnection(t.target);
        file.writeStage(linking ? 'baglanacak' : 'tasinacak', null, { hedef: where, islem: t.operation, isteyen: ctx.principal.name, istenme: new Date().toISOString() });
      } catch (e) {
        console.error('veritabani istegi yazilamadi:', e?.message ?? e);
        file.deleteConnection();
        return json(ctx.res, 500, { error: 'İstek yazılamadı (data/database). Sunucu yöneticisine bildirin.', code: 'WRITE_FAILED' });
      }
      const reason = String(body.reason ?? '').trim().slice(0, 500);
      auditLog.write(linking ? 'database-connect' : 'database-move', ctx.principal.auditActor, ctx.req, { target: where, ...(reason ? { reason } : {}) });
      tested.delete(ctx.principal.name);
      json(ctx.res, 202, {
        ...await summary(ctx),
        message: linking
          ? 'Bağlanma istendi. Panel birkaç saniye içinde yeniden başlayacak ve hedef veritabanıyla açılacak; oturumlar kapanır. Sonucu bu sekmede görürsünüz.'
          : 'Taşıma istendi. Panel birkaç saniye içinde yeniden başlayacak ve kopya bitene kadar erişilemeyecek; oturumlar kapanır. Sonucu bu sekmede görürsünüz.',
      });
      await auditLog.wait();
      restart();
    },
  };
}
