/**
 * live: uyeliksiz, gecikmesiz canli izleme. Oynatma: WebRTC, WHEP (mediamtx), istemci teklifini
 * aday beklemeden gonderir. Ek olarak baglanti koparsa kendiliginden yeniden baglanir.
 * Duzen (hangi kamera nerede, sutun sayisi) SUNUCUDA ortaktir: herkes ayni duzeni gorur, yalniz admin degistirir
 * (Duzenle -> taslak -> Kaydet). Acik sayfa duzeni 30 sn'de bir yeniden okur.
 */
'use strict';
const $ = (s) => document.querySelector(s);
const el = (name, o = {}, ...c) => { const e = document.createElement(name); for (const [k, v] of Object.entries(o)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } e.append(...c); return e; };

let cameras = [], defaultOrder = [], saved = { paths: [], column: 4 }, layout = saved, layoutMode = false;
const players = new Map();   // yol -> Oynatici (kare yeniden cizilse de baglanti korunur)

class Player {
  constructor(path) {
    this.path = path; this.attempts = 0; this.pc = null; this.time = null;
    this.video = el('video', { autoplay: '', muted: '', playsinline: '' });
    this.video.muted = true;
    this.status = el('div', { class: 'frame__status' }, 'Bağlanıyor…');
    this.video.addEventListener('playing', () => { this.status.textContent = ''; this.attempts = 0; });
    this.video.addEventListener('error', () => { if (this.pc) this.retry('Oynatıcı hatası'); });
  }
  async start() {
    this.close(false);
    const pc = (this.pc = new RTCPeerConnection());
    // Bekci: baglanti "connected" kalip goruntu durabilir (kaynak dustu, cevirici takildi); baglanti olayi gelmez, sayfa
    // donuk kalirdi. Cozulen kare sayisi 8 sn artmazsa (ilk kare icin 20 sn) yeniden baglanir.
    let frame = 0, z = performance.now();
    this.watcher = setInterval(async () => {
      let k = 0;
      try { (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') k = r.framesDecoded ?? 0; }); } catch { return; }
      if (this.pc !== pc) return;
      if (k > frame) { frame = k; z = performance.now(); }
      else if (performance.now() - z > (frame ? 8000 : 20_000)) this.retry(frame ? 'Görüntü durdu' : 'Görüntü gelmedi');
    }, 2000);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      // En dusuk gecikme: alici tamponu bekletmesin (desteklenen tarayicida)
      try { if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; else if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0; } catch {}
      this.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.retry('Bağlantı koptu');
      else if (pc.connectionState === 'disconnected') { clearTimeout(this.stall); this.stall = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.retry('Bağlantı koptu'); }, 3000); }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Zaman asimi: cevapsiz kalan istek yeniden denemeyi sonsuza dek bekletiyordu ("yeniden deneniyor (1)" deyip kalirdi)
      // X-Cam: panelin CSRF kurali (istegi panel karsilar, mediamtx'e o gecirir)
      const r = await fetch(`rtc/${this.path}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Cam': '1' }, body: offer.sdp, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const answer = await r.text();
      if (this.pc !== pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch { if (this.pc === pc) this.retry('Bağlanamadı'); }
  }
  retry(reason) {
    this.close(false);
    this.attempts++;
    this.status.textContent = `${reason}, yeniden deneniyor (${this.attempts})…`;
    this.time = setTimeout(() => this.start(), Math.min(10_000, 1000 * 2 ** Math.min(this.attempts, 3)));
  }
  close(fully = true) {
    clearTimeout(this.time); clearTimeout(this.stall); clearInterval(this.watcher);
    const pc = this.pc; this.pc = null;
    try { pc?.close(); } catch {}
    if (fully) this.video.srcObject = null;
  }
}

const camera = (path) => cameras.find((k) => k.path === path);
function player(path) {
  let o = players.get(path);
  if (!o) { o = new Player(path); players.set(path, o); o.start(); }
  return o;
}

// ---- surukle-birak: tasinan { tur: 'kare', i } (izgaradan) ya da { tur: 'liste', yol }
let moved = null;
function release(i) {
  if (!moved) return;
  const y = [...layout.paths];
  if (moved.type === 'frame') { if (moved.i === i) return; [y[moved.i], y[i]] = [y[i], y[moved.i]]; }
  else {
    const old = y.indexOf(moved.path);
    if (i >= y.length) { if (old >= 0) return; y.push(moved.path); }
    else if (old >= 0) [y[old], y[i]] = [y[i], y[old]];
    else y[i] = moved.path;
  }
  changeLayout(y.filter(Boolean));
}
function makeTarget(e, i) {
  e.addEventListener('dragover', (o) => { o.preventDefault(); e.classList.add('frame--target'); });
  e.addEventListener('dragleave', () => e.classList.remove('frame--target'));
  e.addEventListener('drop', (o) => { o.preventDefault(); e.classList.remove('frame--target'); release(i); moved = null; });
}

function drawGrid() {
  const gridEl = $('#grid');
  gridEl.style.setProperty('--columns', String(layout.column));
  gridEl.classList.toggle('layout', layoutMode);
  const frames = layout.paths.filter(camera).map((path, i) => {
    const o = player(path), k = camera(path);
    // Izlemede kamera adi yazilmaz: kamera kendi goruntusune yaziyor. Yalniz duzenleme kipinde yazilir.
    const frame = el('div', { class: 'frame', draggable: layoutMode ? 'true' : 'false', role: 'img', 'aria-label': k.name }, o.video, ...(layoutMode ? [el('span', { class: 'frame__name' }, k.name)] : []), o.status,
      el('button', { type: 'button', class: 'btn btn--sm btn--icon frame__remove', title: 'Kaldır', 'aria-label': `${k.name} kaldır`, onclick: () => changeLayout(layout.paths.filter((x) => x !== path)) }, '×'));
    frame.addEventListener('dragstart', (e) => { moved = { type: 'frame', i }; e.dataTransfer.effectAllowed = 'move'; });
    frame.addEventListener('dblclick', () => { if (!layoutMode) frame.requestFullscreen?.(); });
    makeTarget(frame, i);
    return frame;
  });
  if (layoutMode) { const empty = el('div', { class: 'frame frame--empty' }, '+ buraya bırakın'); makeTarget(empty, layout.paths.length); frames.push(empty); }
  gridEl.replaceChildren(...frames);
  // Izgaradan cikan kameranin baglantisi kapanir (sunucuda akis da kapanir)
  for (const [path, o] of players) if (!layout.paths.includes(path)) { o.close(); players.delete(path); }
  for (const v of gridEl.querySelectorAll('video')) v.play?.().catch(() => {});
  if (!layoutMode) $('#info').textContent = saved.savedBy ? `${layout.paths.filter(camera).length} kamera · düzen: ${saved.savedBy}` : `${layout.paths.filter(camera).length} kamera`;
}

function drawList() {
  const groups = new Map();
  for (const k of cameras) { if (!groups.has(k.device)) groups.set(k.device, []); groups.get(k.device).push(k); }
  $('#listInner').replaceChildren(...[...groups].flatMap(([device, ks]) => [el('div', { class: 'list__header' }, device || 'Cihaz'), ...ks.map((k) => {
    const b = el('div', { class: 'row-item', role: 'button', tabindex: '0', draggable: 'true', ...(layout.paths.includes(k.path) ? { 'aria-selected': 'true' } : {}),
      onclick: () => { if (!layout.paths.includes(k.path)) changeLayout([...layout.paths, k.path]); } }, el('span', { class: 'row-item__label' }, k.name));
    b.addEventListener('dragstart', (e) => { moved = { type: 'list', path: k.path }; e.dataTransfer.effectAllowed = 'copyMove'; });
    return b;
  })]));
}

/** Duzenleme taslak uzerinde: kaydedilene kadar baskasi gormez. */
function changeLayout(paths) { layout.paths = paths; drawGrid(); if (layoutMode) drawList(); }
function modeSet(isOpen) {
  layoutMode = isOpen;
  $('#list').hidden = $('#save').hidden = $('#cancel').hidden = $('#columnField').hidden = !isOpen;
  $('#edit').hidden = isOpen;
  if (isOpen) { layout = { column: saved.column, paths: [...saved.paths] }; $('#columns').value = String(layout.column); drawList(); }
  else layout = saved;
  drawGrid();
}
const writeInfo = (...c) => $('#info').replaceChildren(...c);

$('#columns').addEventListener('change', (e) => { layout.column = Number(e.target.value); drawGrid(); });
/** Ust serit yalniz admin oturumunda gorunur; ziyaretci yalniz kameralari gorur. */
async function permissionAsk() {
  let y = null;
  try { y = await (await fetch('access', { cache: 'no-store', credentials: 'same-origin' })).json(); } catch {}
  $('#topBar').hidden = !y?.canEdit;
  // Tema yalniz admin icin (theme.mjs); admin degilse hep gece.
  if (y?.canEdit) { document.documentElement.dataset.admin = '1'; document.dispatchEvent(new Event('live-admin')); }
  else { delete document.documentElement.dataset.admin; document.documentElement.dataset.theme = 'dark'; }
  if (!y?.canEdit && layoutMode) modeSet(false);
  return !!y?.canEdit;
}
$('#edit').addEventListener('click', async () => { if (await permissionAsk()) modeSet(true); });
$('#cancel').addEventListener('click', () => modeSet(false));
$('#save').addEventListener('click', async () => {
  const d = $('#save'); d.disabled = true;
  try {
    const r = await fetch('layout', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Cam': '1' }, body: JSON.stringify({ column: layout.column, paths: layout.paths }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { permissionAsk(); throw new Error(j.error ?? 'oturum yok'); }
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    saved = j; modeSet(false); writeInfo('Kaydedildi: bu sayfayı açan herkes bu düzeni görür.');
  } catch (e) { writeInfo(`Kaydedilemedi: ${e.message}`); }
  finally { d.disabled = false; }
});
$('#reset').addEventListener('click', () => changeLayout([...defaultOrder]));
$('#full').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));

(async function open() {
  try {
    const r = await (await fetch('cameras.json', { cache: 'no-store' })).json();
    cameras = r.cameras; defaultOrder = r.defaultOrder;
  } catch { $('#info').textContent = 'Kamera listesi alınamadı, yeniden deneniyor…'; return setTimeout(open, 5000); }
  if (!cameras.length) { $('#info').textContent = 'Kamera listesi hazırlanıyor…'; return setTimeout(open, 5000); }
  await getLayout();
  permissionAsk();
  setInterval(() => { if (!layoutMode && !document.hidden) getLayout(); }, 30_000);
})();
let lastLayout = null;
async function getLayout() {
  try {
    const raw = await (await fetch('layout.json', { cache: 'no-store' })).text();
    if (raw === lastLayout) return;
    lastLayout = raw; const d = JSON.parse(raw);
    saved = { ...d, paths: d.paths.filter(camera) };
    if (!layoutMode) { layout = saved; drawGrid(); }
  } catch {}
}
