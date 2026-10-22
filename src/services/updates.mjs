/**
 * Guncelleme kontrolu: panelin yeni surumu var mi? DC panellerindeki GuncellemeDenetimi'nin (PHP) karsiligi; kurallar ve
 * iletiler ayni.
 *
 * Calisan surum (imaja derlemede yazilan commit, APP_VERSION) GitHub'daki main dalinin SON BASARILI IMAJ DERLEMESIYLE
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
import { DatabaseError } from '../core/errors.mjs';

export const STATUSES = ['current', 'new', 'ahead', 'diverged', 'unknown', 'error'];

/** Ekranda gosterilen yeni commit sayisi; fazlasi "ve N commit daha" olur. */
const MAX_COMMITS = 20;

export class UpdateService {
  /** ayarlar: Ayarlar (veritabani); ayar: yapilandirma.guncelleme; fetch: testler sahtesini verir. Son sonucu yukle() getirir. */
  constructor({ settings, setting, fetch = globalThis.fetch }) {
    this.settings = settings; this.setting = setting; this.fetch = fetch; this.timer = null; this.result = null;
  }

  async load() {
    const v = await this.settings.read('update-status');
    this.result = v && STATUSES.includes(v.status) ? v : null;
    return this;
  }

  /** Calisan commit (40 haneli); imaj surum bilgisi olmadan derlendiyse null. */
  version() {
    const s = String(this.setting.version ?? '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  }

  last() { return this.result; }

  /** Uyari seridi: son kontrol yeni surum bulduysa VE o kontrol su an calisan surumle yapildiysa (guncellenince susar). */
  hasNew() {
    const s = this.last();
    return s?.status === 'new' && s.running === this.version();
  }

  /** GitHub'a sorar, sonucu yazar ve dondurur. Hata FIRLATMAZ: sonuc "hata" durumuyla yazilir. */
  async check(trigger) {
    let result = { running: this.version(), repo: this.setting.repo, trigger };
    try { result = { ...result, ...(await this.#ask(result.running)) }; } catch (e) { result = { ...result, status: 'error', description: this.#clean(String(e?.message ?? e)) }; }
    result.time = new Date().toISOString();
    await this.#write(result);
    return result;
  }

  /** Her gun ayar.saat'te (sunucu saati, TZ) bir kontrol. */
  start() {
    const [sa, min] = String(this.setting.clock ?? '06:50').split(':').map(Number);
    const setup = () => {
      const now = new Date(), next = new Date(now);
      next.setHours(sa, min, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      this.timer = setTimeout(async () => { try { await this.check('günlük tur'); } catch { /* sonuc zaten yazildi */ } setup(); }, next - now);
      this.timer.unref?.();
    };
    setup();
  }

  close() { clearTimeout(this.timer); this.timer = null; }

  async #ask(running) {
    const is = (await this.#get(`/repos/${this.setting.repo}/actions/workflows/${this.setting.is}/runs`, { branch: this.setting.branch, status: 'success', event: 'push', per_page: 1 }))?.workflow_runs?.[0];
    if (!is || typeof is.head_sha !== 'string') return { status: 'error', description: 'Depoda başarılı bir imaj derlemesi bulunamadı.' };

    const last = { last: is.head_sha, lastDate: is.updated_at ?? null };
    if (running === null) return { ...last, status: 'unknown', description: 'Çalışan sürüm bilinmiyor: imaj sürüm bilgisi olmadan derlenmiş. Son derleme gösteriliyor.' };
    if (running === is.head_sha) return { ...last, status: 'current', behind: 0, ahead: 0, description: 'Panel son sürümde.' };

    const diff = await this.#get(`/repos/${this.setting.repo}/compare/${running}...${is.head_sha}`);
    const behind = Number(diff?.ahead_by ?? 0), ahead = Number(diff?.behind_by ?? 0);
    const commitList = [...(diff?.commits ?? [])].reverse().slice(0, MAX_COMMITS).map((c) => ({
      sha: String(c?.sha ?? ''),
      header: String(c?.commit?.message ?? '').split('\n')[0].slice(0, 200),
      date: c?.commit?.committer?.date ?? null,
    }));
    const extra = {
      ahead: { status: 'new', description: `${behind} commit geride.` },
      identical: { status: 'current', description: 'Panel son sürümde.' },
      behind: { status: 'ahead', description: `Çalışan sürüm son başarılı derlemeden ${ahead} commit ileride: daha yeni bir commit'ten kurulmuş. "Güncellemek" geri almak olur.` },
    }[diff?.status] ?? { status: 'diverged', description: `Çalışan sürüm main dalında değil (${behind} geride, ${ahead} ileride): ayrı bir daldan ya da elle derlenmiş.` };
    return { ...last, behind, ahead, commitList, ...extra };
  }

  async #get(path, query = {}) {
    const u = new URL(this.setting.api + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    const token = String(this.setting.token ?? '').trim();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cam' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let r;
    try {
      r = await this.fetch(u, { headers: headers, signal: AbortSignal.timeout(10_000) });
    } catch { throw new Error('GitHub\'a erişilemedi (ağ kapalı ya da yanıt yok).'); }
    if (r.ok) return r.json();
    if (r.status === 401) throw new Error('GitHub jetonu reddetti (401): süresi dolmuş ya da silinmiş olabilir.');
    if (!token && r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub jetonsuz istek sınırı doldu (403, saatte 60): bir saat sonra yeniden deneyin ya da UPDATE_TOKEN tanımlayın.');
    if (!token && (r.status === 403 || r.status === 404)) throw new Error(`Depo bulunamadı ya da özel (${r.status}): ${this.setting.repo} özelse UPDATE_TOKEN gerekir.`);
    if (r.status === 403 || r.status === 404) throw new Error(`Jeton bu depoyu görmüyor (${r.status}): ${this.setting.repo} için Contents ve Actions okuma yetkisi gerekir.`);
    let m = ''; try { m = String((await r.json())?.message ?? '').slice(0, 200); } catch { /* govde JSON degil */ }
    throw new Error(`GitHub yanıtı: ${r.status} ${m}`);
  }

  /** Jeton hicbir iletide gecmez. */
  #clean(message) {
    const j = String(this.setting.token ?? '').trim();
    return (j ? message.split(j).join('***') : message).slice(0, 300);
  }

  async #write(result) {
    try { await this.settings.write('update-status', result); } catch (e) { console.error('guncelleme sonucu yazilamadi:', e?.code ?? '', e?.message ?? e); throw new DatabaseError(e); }
    this.result = result;
  }
}
