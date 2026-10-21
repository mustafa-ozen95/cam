/**
 * Guncelleme kontrolu: panelin yeni surumu var mi? DC panellerindeki GuncellemeDenetimi'nin (PHP) karsiligi; kurallar ve
 * iletiler ayni.
 *
 * Calisan surum (imaja derlemede yazilan commit, UYGULAMA_SURUMU) GitHub'daki main dalinin SON BASARILI IMAJ DERLEMESIYLE
 * karsilastirilir. Son commit degil: imaji derlenmemis ya da derlemesi dusmus bir commit kurulamaz.
 *
 * YON OLCULUR: calisan surum son derlemeden YENI olabilir (yeni commit'in derlemesi dusmus, elle kurulmus imaj); o zaman
 * "guncelleme" denen sey geri almak olurdu. GitHub compare'i kac commit geride, kac commit ileride oldugunu ayri soyler.
 *
 * JETON ISTEGE BAGLI: depo acikken jetonsuz sorulur (GitHub'in jetonsuz siniri IP basina saatte 60 istek; gunde bir tur
 * ve elle basilan dugme icin yeter). Ozel depo jeton ister; jetonsuz sorulan ozel depo 404 doner.
 *
 * YALNIZCA BAKAR, KURMAZ: guncelleme sunucudan, onayli yapilir. Sonuc veritabaninda (ayarlar tablosu, "guncelleme"): her sabahki tur
 * yazar, ekran ve uyari seridi okur. Jeton sonucta ve iletilerde gecmez.
 */
import { VeritabaniHatasi } from '../core/errors.mjs';

export const DURUMLAR = ['guncel', 'yeni', 'ileride', 'ayrisik', 'bilinmiyor', 'hata'];

/** Ekranda gosterilen yeni commit sayisi; fazlasi "ve N commit daha" olur. */
const EN_COK_COMMIT = 20;

export class GuncellemeHizmeti {
  /** ayarlar: Ayarlar (veritabani); ayar: yapilandirma.guncelleme; fetch: testler sahtesini verir. Son sonucu yukle() getirir. */
  constructor({ ayarlar, ayar, fetch = globalThis.fetch }) {
    this.ayarlar = ayarlar; this.ayar = ayar; this.fetch = fetch; this.zamanlayici = null; this.sonuc = null;
  }

  async yukle() {
    const v = await this.ayarlar.oku('update-status');
    this.sonuc = v && DURUMLAR.includes(v.durum) ? v : null;
    return this;
  }

  /** Calisan commit (40 haneli); imaj surum bilgisi olmadan derlendiyse null. */
  surum() {
    const s = String(this.ayar.surum ?? '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  }

  son() { return this.sonuc; }

  /** Uyari seridi: son kontrol yeni surum bulduysa VE o kontrol su an calisan surumle yapildiysa (guncellenince susar). */
  yeniVar() {
    const s = this.son();
    return s?.durum === 'yeni' && s.calisan === this.surum();
  }

  /** GitHub'a sorar, sonucu yazar ve dondurur. Hata FIRLATMAZ: sonuc "hata" durumuyla yazilir. */
  async denetle(tetikleyen) {
    let sonuc = { calisan: this.surum(), depo: this.ayar.depo, tetikleyen };
    try { sonuc = { ...sonuc, ...(await this.#sor(sonuc.calisan)) }; } catch (e) { sonuc = { ...sonuc, durum: 'hata', aciklama: this.#temiz(String(e?.message ?? e)) }; }
    sonuc.zaman = new Date().toISOString();
    await this.#yaz(sonuc);
    return sonuc;
  }

  /** Her gun ayar.saat'te (sunucu saati, TZ) bir kontrol. */
  baslat() {
    const [sa, dk] = String(this.ayar.saat ?? '06:50').split(':').map(Number);
    const kur = () => {
      const simdi = new Date(), sonraki = new Date(simdi);
      sonraki.setHours(sa, dk, 0, 0);
      if (sonraki <= simdi) sonraki.setDate(sonraki.getDate() + 1);
      this.zamanlayici = setTimeout(async () => { try { await this.denetle('günlük tur'); } catch { /* sonuc zaten yazildi */ } kur(); }, sonraki - simdi);
      this.zamanlayici.unref?.();
    };
    kur();
  }

  kapat() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  async #sor(calisan) {
    const is = (await this.#al(`/repos/${this.ayar.depo}/actions/workflows/${this.ayar.is}/runs`, { branch: this.ayar.dal, status: 'success', event: 'push', per_page: 1 }))?.workflow_runs?.[0];
    if (!is || typeof is.head_sha !== 'string') return { durum: 'hata', aciklama: 'Depoda başarılı bir imaj derlemesi bulunamadı.' };

    const son = { son: is.head_sha, son_tarih: is.updated_at ?? null };
    if (calisan === null) return { ...son, durum: 'bilinmiyor', aciklama: 'Çalışan sürüm bilinmiyor: imaj sürüm bilgisi olmadan derlenmiş. Son derleme gösteriliyor.' };
    if (calisan === is.head_sha) return { ...son, durum: 'guncel', geride: 0, ileride: 0, aciklama: 'Panel son sürümde.' };

    const fark = await this.#al(`/repos/${this.ayar.depo}/compare/${calisan}...${is.head_sha}`);
    const geride = Number(fark?.ahead_by ?? 0), ileride = Number(fark?.behind_by ?? 0);
    const commitler = [...(fark?.commits ?? [])].reverse().slice(0, EN_COK_COMMIT).map((c) => ({
      sha: String(c?.sha ?? ''),
      baslik: String(c?.commit?.message ?? '').split('\n')[0].slice(0, 200),
      tarih: c?.commit?.committer?.date ?? null,
    }));
    const ek = {
      ahead: { durum: 'yeni', aciklama: `${geride} commit geride.` },
      identical: { durum: 'guncel', aciklama: 'Panel son sürümde.' },
      behind: { durum: 'ileride', aciklama: `Çalışan sürüm son başarılı derlemeden ${ileride} commit ileride: daha yeni bir commit'ten kurulmuş. "Güncellemek" geri almak olur.` },
    }[fark?.status] ?? { durum: 'ayrisik', aciklama: `Çalışan sürüm main dalında değil (${geride} geride, ${ileride} ileride): ayrı bir daldan ya da elle derlenmiş.` };
    return { ...son, geride, ileride, commitler, ...ek };
  }

  async #al(yol, sorgu = {}) {
    const u = new URL(this.ayar.api + yol);
    for (const [k, v] of Object.entries(sorgu)) u.searchParams.set(k, String(v));
    const jeton = String(this.ayar.jeton ?? '').trim();
    const basliklar = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cam' };
    if (jeton) basliklar.Authorization = `Bearer ${jeton}`;
    let r;
    try {
      r = await this.fetch(u, { headers: basliklar, signal: AbortSignal.timeout(10_000) });
    } catch { throw new Error('GitHub\'a erişilemedi (ağ kapalı ya da yanıt yok).'); }
    if (r.ok) return r.json();
    if (r.status === 401) throw new Error('GitHub jetonu reddetti (401): süresi dolmuş ya da silinmiş olabilir.');
    if (!jeton && r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub jetonsuz istek sınırı doldu (403, saatte 60): bir saat sonra yeniden deneyin ya da GUNCELLEME_JETONU tanımlayın.');
    if (!jeton && (r.status === 403 || r.status === 404)) throw new Error(`Depo bulunamadı ya da özel (${r.status}): ${this.ayar.depo} özelse GUNCELLEME_JETONU gerekir.`);
    if (r.status === 403 || r.status === 404) throw new Error(`Jeton bu depoyu görmüyor (${r.status}): ${this.ayar.depo} için Contents ve Actions okuma yetkisi gerekir.`);
    let m = ''; try { m = String((await r.json())?.message ?? '').slice(0, 200); } catch { /* govde JSON degil */ }
    throw new Error(`GitHub yanıtı: ${r.status} ${m}`);
  }

  /** Jeton hicbir iletide gecmez. */
  #temiz(ileti) {
    const j = String(this.ayar.jeton ?? '').trim();
    return (j ? ileti.split(j).join('***') : ileti).slice(0, 300);
  }

  async #yaz(sonuc) {
    try { await this.ayarlar.yaz('update-status', sonuc); } catch (e) { console.error('guncelleme sonucu yazilamadi:', e?.code ?? '', e?.message ?? e); throw new VeritabaniHatasi(e); }
    this.sonuc = sonuc;
  }
}
