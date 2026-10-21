/**
 * live: uyeliksiz, gecikmesiz canli izleme. Oynatma: WebRTC, WHEP (mediamtx), istemci teklifini
 * aday beklemeden gonderir. Ek olarak baglanti koparsa kendiliginden yeniden baglanir.
 * Duzen (hangi kamera nerede, sutun sayisi) SUNUCUDA ortaktir: herkes ayni duzeni gorur, yalniz admin degistirir
 * (Duzenle -> taslak -> Kaydet). Acik sayfa duzeni 30 sn'de bir yeniden okur.
 */
'use strict';
const $ = (s) => document.querySelector(s);
const el = (ad, o = {}, ...c) => { const e = document.createElement(ad); for (const [k, v] of Object.entries(o)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } e.append(...c); return e; };

let kameralar = [], varsayilan = [], kayitli = { yollar: [], sutun: 4 }, duzen = kayitli, duzenKipi = false;
const oynaticilar = new Map();   // yol -> Oynatici (kare yeniden cizilse de baglanti korunur)

class Oynatici {
  constructor(yol) {
    this.yol = yol; this.deneme = 0; this.pc = null; this.zaman = null;
    this.video = el('video', { autoplay: '', muted: '', playsinline: '' });
    this.video.muted = true;
    this.durum = el('div', { class: 'kare__durum' }, 'Bağlanıyor…');
    this.video.addEventListener('playing', () => { this.durum.textContent = ''; this.deneme = 0; });
    this.video.addEventListener('error', () => { if (this.pc) this.yeniden('Oynatıcı hatası'); });
  }
  async baslat() {
    this.kapat(false);
    const pc = (this.pc = new RTCPeerConnection());
    // Bekci: baglanti "connected" kalip goruntu durabilir (kaynak dustu, cevirici takildi); baglanti olayi gelmez, sayfa
    // donuk kalirdi. Cozulen kare sayisi 8 sn artmazsa (ilk kare icin 20 sn) yeniden baglanir.
    let kare = 0, z = performance.now();
    this.bekci = setInterval(async () => {
      let k = 0;
      try { (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') k = r.framesDecoded ?? 0; }); } catch { return; }
      if (this.pc !== pc) return;
      if (k > kare) { kare = k; z = performance.now(); }
      else if (performance.now() - z > (kare ? 8000 : 20_000)) this.yeniden(kare ? 'Görüntü durdu' : 'Görüntü gelmedi');
    }, 2000);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      // En dusuk gecikme: alici tamponu bekletmesin (desteklenen tarayicida)
      try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; else if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch {}
      this.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.yeniden('Bağlantı koptu');
      else if (pc.connectionState === 'disconnected') { clearTimeout(this.kopma); this.kopma = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.yeniden('Bağlantı koptu'); }, 3000); }
    };
    try {
      const teklif = await pc.createOffer();
      await pc.setLocalDescription(teklif);
      // Zaman asimi: cevapsiz kalan istek yeniden denemeyi sonsuza dek bekletiyordu ("yeniden deneniyor (1)" deyip kalirdi)
      // X-Kamera: panelin CSRF kurali (istegi panel karsilar, mediamtx'e o gecirir)
      const r = await fetch(`rtc/${this.yol}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Kamera': '1' }, body: teklif.sdp, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cevap = await r.text();
      if (this.pc !== pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: cevap });
    } catch { if (this.pc === pc) this.yeniden('Bağlanamadı'); }
  }
  yeniden(neden) {
    this.kapat(false);
    this.deneme++;
    this.durum.textContent = `${neden}, yeniden deneniyor (${this.deneme})…`;
    this.zaman = setTimeout(() => this.baslat(), Math.min(10_000, 1000 * 2 ** Math.min(this.deneme, 3)));
  }
  kapat(tamamen = true) {
    clearTimeout(this.zaman); clearTimeout(this.kopma); clearInterval(this.bekci);
    const pc = this.pc; this.pc = null;
    try { pc?.close(); } catch {}
    if (tamamen) this.video.srcObject = null;
  }
}

const kamera = (yol) => kameralar.find((k) => k.yol === yol);
function oynatici(yol) {
  let o = oynaticilar.get(yol);
  if (!o) { o = new Oynatici(yol); oynaticilar.set(yol, o); o.baslat(); }
  return o;
}

// ---- surukle-birak: tasinan { tur: 'kare', i } (izgaradan) ya da { tur: 'liste', yol }
let tasinan = null;
function birak(i) {
  if (!tasinan) return;
  const y = [...duzen.yollar];
  if (tasinan.tur === 'kare') { if (tasinan.i === i) return; [y[tasinan.i], y[i]] = [y[i], y[tasinan.i]]; }
  else {
    const eski = y.indexOf(tasinan.yol);
    if (i >= y.length) { if (eski >= 0) return; y.push(tasinan.yol); }
    else if (eski >= 0) [y[eski], y[i]] = [y[i], y[eski]];
    else y[i] = tasinan.yol;
  }
  duzenDegis(y.filter(Boolean));
}
function hedefYap(e, i) {
  e.addEventListener('dragover', (o) => { o.preventDefault(); e.classList.add('kare--hedef'); });
  e.addEventListener('dragleave', () => e.classList.remove('kare--hedef'));
  e.addEventListener('drop', (o) => { o.preventDefault(); e.classList.remove('kare--hedef'); birak(i); tasinan = null; });
}

function izgaraCiz() {
  const iz = $('#izgara');
  iz.style.setProperty('--sutun', String(duzen.sutun));
  iz.classList.toggle('duzen', duzenKipi);
  const kareler = duzen.yollar.filter(kamera).map((yol, i) => {
    const o = oynatici(yol), k = kamera(yol);
    // Izlemede kamera adi yazilmaz: kamera kendi goruntusune yaziyor. Yalniz duzenleme kipinde yazilir.
    const kare = el('div', { class: 'kare', draggable: duzenKipi ? 'true' : 'false', role: 'img', 'aria-label': k.ad }, o.video, ...(duzenKipi ? [el('span', { class: 'kare__ad' }, k.ad)] : []), o.durum,
      el('button', { type: 'button', class: 'btn btn--sm btn--icon kare__sil', title: 'Kaldır', 'aria-label': `${k.ad} kaldır`, onclick: () => duzenDegis(duzen.yollar.filter((x) => x !== yol)) }, '×'));
    kare.addEventListener('dragstart', (e) => { tasinan = { tur: 'kare', i }; e.dataTransfer.effectAllowed = 'move'; });
    kare.addEventListener('dblclick', () => { if (!duzenKipi) kare.requestFullscreen?.(); });
    hedefYap(kare, i);
    return kare;
  });
  if (duzenKipi) { const bos = el('div', { class: 'kare kare--bos' }, '+ buraya bırakın'); hedefYap(bos, duzen.yollar.length); kareler.push(bos); }
  iz.replaceChildren(...kareler);
  // Izgaradan cikan kameranin baglantisi kapanir (sunucuda akis da kapanir)
  for (const [yol, o] of oynaticilar) if (!duzen.yollar.includes(yol)) { o.kapat(); oynaticilar.delete(yol); }
  for (const v of iz.querySelectorAll('video')) v.play?.().catch(() => {});
  if (!duzenKipi) $('#bilgi').textContent = kayitli.kaydeden ? `${duzen.yollar.filter(kamera).length} kamera · düzen: ${kayitli.kaydeden}` : `${duzen.yollar.filter(kamera).length} kamera`;
}

function listeCiz() {
  const gruplar = new Map();
  for (const k of kameralar) { if (!gruplar.has(k.cihaz)) gruplar.set(k.cihaz, []); gruplar.get(k.cihaz).push(k); }
  $('#listeIc').replaceChildren(...[...gruplar].flatMap(([cihaz, ks]) => [el('div', { class: 'liste__baslik' }, cihaz || 'Cihaz'), ...ks.map((k) => {
    const b = el('div', { class: 'row-item', role: 'button', tabindex: '0', draggable: 'true', ...(duzen.yollar.includes(k.yol) ? { 'aria-selected': 'true' } : {}),
      onclick: () => { if (!duzen.yollar.includes(k.yol)) duzenDegis([...duzen.yollar, k.yol]); } }, el('span', { class: 'row-item__label' }, k.ad));
    b.addEventListener('dragstart', (e) => { tasinan = { tur: 'liste', yol: k.yol }; e.dataTransfer.effectAllowed = 'copyMove'; });
    return b;
  })]));
}

/** Duzenleme taslak uzerinde: kaydedilene kadar baskasi gormez. */
function duzenDegis(yollar) { duzen.yollar = yollar; izgaraCiz(); if (duzenKipi) listeCiz(); }
function kipAyarla(acik) {
  duzenKipi = acik;
  $('#liste').hidden = $('#kaydet').hidden = $('#vazgec').hidden = $('#sutunAlan').hidden = !acik;
  $('#duzenle').hidden = acik;
  if (acik) { duzen = { sutun: kayitli.sutun, yollar: [...kayitli.yollar] }; $('#sutun').value = String(duzen.sutun); listeCiz(); }
  else duzen = kayitli;
  izgaraCiz();
}
const bilgiYaz = (...c) => $('#bilgi').replaceChildren(...c);

$('#sutun').addEventListener('change', (e) => { duzen.sutun = Number(e.target.value); izgaraCiz(); });
/** Ust serit yalniz admin oturumunda gorunur; ziyaretci yalniz kameralari gorur. */
async function yetkiSor() {
  let y = null;
  try { y = await (await fetch('yetki', { cache: 'no-store', credentials: 'same-origin' })).json(); } catch {}
  $('#ust').hidden = !y?.duzenleyebilir;
  // Tema yalniz admin icin (tema.mjs); admin degilse hep gece.
  if (y?.duzenleyebilir) { document.documentElement.dataset.admin = '1'; document.dispatchEvent(new Event('live-admin')); }
  else { delete document.documentElement.dataset.admin; document.documentElement.dataset.theme = 'dark'; }
  if (!y?.duzenleyebilir && duzenKipi) kipAyarla(false);
  return !!y?.duzenleyebilir;
}
$('#duzenle').addEventListener('click', async () => { if (await yetkiSor()) kipAyarla(true); });
$('#vazgec').addEventListener('click', () => kipAyarla(false));
$('#kaydet').addEventListener('click', async () => {
  const d = $('#kaydet'); d.disabled = true;
  try {
    const r = await fetch('duzen', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Kamera': '1' }, body: JSON.stringify({ sutun: duzen.sutun, yollar: duzen.yollar }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { yetkiSor(); throw new Error(j.hata ?? 'oturum yok'); }
    if (!r.ok) throw new Error(j.hata ?? `HTTP ${r.status}`);
    kayitli = j; kipAyarla(false); bilgiYaz('Kaydedildi: bu sayfayı açan herkes bu düzeni görür.');
  } catch (e) { bilgiYaz(`Kaydedilemedi: ${e.message}`); }
  finally { d.disabled = false; }
});
$('#sifirla').addEventListener('click', () => duzenDegis([...varsayilan]));
$('#tam').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));

(async function ac() {
  try {
    const r = await (await fetch('kameralar.json', { cache: 'no-store' })).json();
    kameralar = r.kameralar; varsayilan = r.varsayilan;
  } catch { $('#bilgi').textContent = 'Kamera listesi alınamadı, yeniden deneniyor…'; return setTimeout(ac, 5000); }
  if (!kameralar.length) { $('#bilgi').textContent = 'Kamera listesi hazırlanıyor…'; return setTimeout(ac, 5000); }
  await duzenAl();
  yetkiSor();
  setInterval(() => { if (!duzenKipi && !document.hidden) duzenAl(); }, 30_000);
})();
let sonDuzen = null;
async function duzenAl() {
  try {
    const ham = await (await fetch('duzen.json', { cache: 'no-store' })).text();
    if (ham === sonDuzen) return;
    sonDuzen = ham; const d = JSON.parse(ham);
    kayitli = { ...d, yollar: d.yollar.filter(kamera) };
    if (!duzenKipi) { duzen = kayitli; izgaraCiz(); }
  } catch {}
}
