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
import { Ayarlar, Koleksiyon } from '../core/tables.mjs';
import { ANAHTARLAR, CIHAZLAR, MERKEZ_BAGLARI, ROLLER, UYELER, YERLESIK_IZINLER } from './schema.mjs';

export const ESKI_DOSYALAR = ['kullanicilar.json', 'yetki.json', 'cihazlar.json', 'kanallar.json', 'gunluk.jsonl', 'merkez-baglari.json', 'guncelleme.json', 'live-duzen.json'];
const PARCA = 500;

const oku = (yol, ad) => { try { return readFileSync(yol, 'utf8'); } catch (e) { throw new Error(`${ad} okunamadı: ${e.message}`); } };
const jsonOku = (yol, ad) => { const m = oku(yol, ad); try { return JSON.parse(m); } catch (e) { throw new Error(`${ad} geçerli JSON değil: ${e.message}`); } };

/** Eski dosyalardaki verinin bellege yuklenirken uygulanan donusumleri (JSON donemindeki kurucularin yaptiklari). */
export function eskiVeriyiDonustur({ kullanicilar, yetki, cihazlar, merkezBaglari }) {
  const simdi = new Date().toISOString();
  const uyeler = (kullanicilar ?? []).map((u) => ({ ...u, olusturma: u.olusturma || simdi }));
  const baglar = {};
  for (const [sub, b] of Object.entries(merkezBaglari ?? {})) {
    if (b.uyeKimlik) { baglar[sub] = b; continue; }
    const u = uyeler.find((x) => x.ad.toLowerCase() === String(b.ad).toLowerCase());
    if (u) baglar[sub] = { ...b, uyeKimlik: u.olusturma };   // uyesi olmayan eski bag atilir
  }
  const y = { surum: 1, roller: {}, anahtarlar: [], yerlesikIzinler: {}, ...(yetki ?? {}) };
  const cihazListe = cihazlar?.cihazlar ?? [];
  const ustSinir = Math.max(Number(cihazlar?.ustSinir) || 0, cihazListe.reduce((m, c) => Math.max(m, c.baslangic + c.kanalSayisi), 0));
  return { uyeler, baglar, yetki: y, cihazListe, ustSinir };
}

/** Gunluk zincirini kayit metinlerinden dogrular (veritabani donemindeki Gunluk.dogrula ile ayni kural). */
function zincirDogrula(metinler, imzala) {
  let onceki = '', n = 0;
  for (const m of metinler) {
    n++;
    let k; try { k = JSON.parse(m); } catch { return `${n}. günlük satırı okunamıyor`; }
    const { imza, ...gerisi } = k;
    if (k.onceki !== onceki || imzala(onceki + JSON.stringify(gerisi)) !== imza) return `${n}. günlük kaydında zincir bozuk (${k.z})`;
    onceki = imza;
  }
  return null;
}

async function tablolarBosMu(vt) {
  for (const t of ['users', 'devices', 'audit_log', 'roles', 'builtin_role_permissions', 'api_keys', 'hub_links']) {
    const [[r]] = await vt.havuz.query(`SELECT COUNT(*) AS n FROM ${t}`);
    if (Number(r.n) > 0) return false;
  }
  const [[a]] = await vt.havuz.query("SELECT COUNT(*) AS n FROM settings WHERE name <> 'key-fingerprint'");
  return Number(a.n) === 0;
}

/** Dondurur: { durum: 'yok' | 'atlandi' | 'aktarildi', sayilar } */
export async function eskiVeriyiAktar({ vt, veriKlasoru, gizli, gunlukYaz = console.log }) {
  const var_ = ESKI_DOSYALAR.filter((d) => existsSync(join(veriKlasoru, d)));
  if (!var_.length) return { durum: 'yok' };
  if (!(await tablolarBosMu(vt))) {
    gunlukYaz(`UYARI: data/ klasöründe eski JSON dosyaları var (${var_.join(', ')}) ama veritabanı tabloları dolu; dosyalara dokunulmadı. Veri artık veritabanında; bu dosyaları yedekledikten sonra silebilirsiniz.`);
    return { durum: 'atlandi' };
  }
  const yol = (d) => join(veriKlasoru, d);
  const imzala = (m) => createHmac('sha256', gizli).update(m).digest('hex');

  // 1) oku + donustur (veritabanina hic dokunmadan: bozuk dosya burada durdurur)
  const kaynak = {
    kullanicilar: var_.includes('kullanicilar.json') ? jsonOku(yol('kullanicilar.json'), 'kullanicilar.json') : [],
    yetki: var_.includes('yetki.json') ? jsonOku(yol('yetki.json'), 'yetki.json') : null,
    cihazlar: var_.includes('cihazlar.json') ? jsonOku(yol('cihazlar.json'), 'cihazlar.json') : null,
    merkezBaglari: var_.includes('merkez-baglari.json') ? jsonOku(yol('merkez-baglari.json'), 'merkez-baglari.json') : {},
  };
  if (!Array.isArray(kaynak.kullanicilar)) throw new Error('kullanicilar.json bir dizi olmalı');
  const ayarBelgeleri = {};
  for (const [dosya, ad] of [['kanallar.json', 'channels'], ['guncelleme.json', 'update-status'], ['live-duzen.json', 'live-layout']]) if (var_.includes(dosya)) ayarBelgeleri[ad] = jsonOku(yol(dosya), dosya);
  const gunlukMetinleri = var_.includes('gunluk.jsonl') ? oku(yol('gunluk.jsonl'), 'gunluk.jsonl').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const kaynakZincirHatasi = zincirDogrula(gunlukMetinleri, imzala);
  if (kaynakZincirHatasi) throw new Error(`gunluk.jsonl: ${kaynakZincirHatasi}; imza zinciri doğrulanamadan aktarılmaz (yanlış gizli anahtar olabilir)`);
  const d = eskiVeriyiDonustur(kaynak);
  const roller = Object.entries(d.yetki.roller).map(([id, r]) => ({ id, ...r }));
  const yerlesik = Object.entries(d.yetki.yerlesikIzinler).map(([rol, izinler]) => ({ rol, izinler }));
  const baglar = Object.entries(d.baglar).map(([sub, b]) => ({ sub, ...b }));
  const beklenen = { users: d.uyeler.length, devices: d.cihazListe.length, roles: roller.length, builtin_role_permissions: yerlesik.length, api_keys: d.yetki.anahtarlar.length, hub_links: baglar.length, audit_log: gunlukMetinleri.length };

  // 2) + 3) tek islemde yaz ve dogrula
  await vt.islem(async (c) => {
    await new Koleksiyon(vt, UYELER).topluEkle(c, d.uyeler);
    await new Koleksiyon(vt, CIHAZLAR).topluEkle(c, d.cihazListe);
    await new Koleksiyon(vt, ROLLER).topluEkle(c, roller);
    await new Koleksiyon(vt, YERLESIK_IZINLER).topluEkle(c, yerlesik);
    await new Koleksiyon(vt, ANAHTARLAR).topluEkle(c, d.yetki.anahtarlar);
    await new Koleksiyon(vt, MERKEZ_BAGLARI).topluEkle(c, baglar);
    const ayarlar = new Ayarlar(vt);
    if (kaynak.cihazlar) await ayarlar.yaz('device-block-limit', d.ustSinir, c);
    for (const [ad, deger] of Object.entries(ayarBelgeleri)) await ayarlar.yaz(ad, deger, c);
    for (let i = 0; i < gunlukMetinleri.length; i += PARCA) {
      const satirlar = gunlukMetinleri.slice(i, i + PARCA).map((m) => { const k = JSON.parse(m); return [k.z, k.yerel ?? null, String(k.olay).slice(0, 100), k.kullanici == null ? null : String(k.kullanici).slice(0, 512), k.ip == null ? null : String(k.ip).slice(0, 100), k.ileri ? JSON.stringify(k.ileri) : null, k.onceki, k.imza, m]; });
      await c.query('INSERT INTO audit_log (ts, local_time, event, username, ip, forwarded, previous_signature, signature, record) VALUES ?', [satirlar]);
    }
    // sayilar
    for (const [tablo, n] of Object.entries(beklenen)) {
      const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM ${tablo}`);
      if (Number(r.n) !== n) throw new Error(`Aktarım tutarsız: ${tablo} tablosunda ${r.n} satır var, kaynakta ${n}`);
    }
    // zincir (veritabanindan)
    const [kayitlar] = await c.query('SELECT record FROM audit_log ORDER BY id');
    const zh = zincirDogrula(kayitlar.map((x) => x.record), imzala);
    if (zh) throw new Error(`Aktarım sonrası günlük zinciri doğrulanamadı: ${zh}`);
    // ayarlar geri okuma
    for (const [ad, deger] of Object.entries(ayarBelgeleri)) {
      const [[r]] = await c.query('SELECT value FROM settings WHERE name = ?', [ad]);
      if (JSON.stringify(JSON.parse(r.value)) !== JSON.stringify(deger)) throw new Error(`Aktarım tutarsız: settings/${ad} kaynakla aynı değil`);
    }
  });

  // 4) onaylandi: dosyalar yeniden adlandirilir (silinmez)
  const adlandirilan = [];
  for (const dosya of var_) {
    let hedef = `${yol(dosya)}.imported`;
    if (existsSync(hedef)) hedef = `${hedef}.${Date.now()}`;
    renameSync(yol(dosya), hedef); adlandirilan.push(dosya);
  }
  gunlukYaz(`eski veri aktarıldı: ${Object.entries(beklenen).map(([t, n]) => `${t}=${n}`).join(', ')}; settings=${Object.keys(ayarBelgeleri).join(',') || '-'}; günlük zinciri doğrulandı; dosyalar .imported adıyla saklandı (${adlandirilan.join(', ')})`);
  return { durum: 'aktarildi', sayilar: beklenen };
}
