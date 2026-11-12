/**
 * live: uyeliksiz canli izleme. Oynatma PANELIN KENDISIYLE AYNI: ayni oynatici (/js/mp4-player.js) ve ayni sunucu akisi
 * (alt akis MP4; tarayici H.265 oynatamazsa sunucu H.264'e cevirir). Baglanti koparsa ya da goruntu durursa kendiliginden
 * yeniden baglanir ("…, yeniden deneniyor").
 * Duzen (hangi kamera nerede, sutun sayisi) SUNUCUDA ortaktir: herkes ayni duzeni gorur, yalniz admin degistirir
 * (Duzenle -> taslak -> Kaydet). Acik sayfa kamera listesini ve duzeni 30 sn'de bir yeniden okur.
 */
import { LiveMp4Player } from '/js/mp4-player.js';

const $ = (s) => document.querySelector(s);
const el = (name, o = {}, ...c) => { const e = document.createElement(name); for (const [k, v] of Object.entries(o)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } e.append(...c); return e; };

let cameras = [], defaultOrder = [], saved = { paths: [], column: 4 }, layout = saved, layoutMode = false;
const players = new Map();   // yol -> Oynatici (kare yeniden cizilse de baglanti korunur)

class Player {
  constructor(path) {
    this.video = el('video', { autoplay: '', muted: '', playsinline: '' });
    this.status = el('div', { class: 'frame__status' }, 'Bağlanıyor…');
    this.m = new LiveMp4Player(this.video, {
      key: () => `${camera(path)?.device ?? ''}/Extra1`,
      url: (convert) => `stream/${path}?t=${Date.now()}${convert ? '&h264=1' : ''}`,
      status: (t) => { this.status.textContent = t; },
      first: () => { this.status.textContent = ''; },
    });
  }
  start() { this.m.start(); }
  close() { this.m.stop(); }
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
  if (!layoutMode) $('#info').textContent = `${layout.paths.filter(camera).length} kamera`;
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

/** Kamera listesi; degistiyse true. */
let lastCameras = null;
async function getCameras() {
  const raw = await (await fetch('cameras.json', { cache: 'no-store' })).text();
  if (raw === lastCameras) return false;
  lastCameras = raw; const r = JSON.parse(raw);
  cameras = r.cameras; defaultOrder = r.defaultOrder;
  return true;
}
(async function open() {
  try { await getCameras(); }
  catch { $('#info').textContent = 'Kamera listesi alınamadı, yeniden deneniyor…'; return setTimeout(open, 5000); }
  if (!cameras.length) { lastCameras = null; $('#info').textContent = 'Kamera listesi hazırlanıyor…'; return setTimeout(open, 5000); }
  await getLayout();
  permissionAsk();
  // Sonradan gelen kamera (cihaz gec yanit verdi) da cizilsin: liste degisince duzen yeniden suzulur
  setInterval(async () => {
    if (layoutMode || document.hidden) return;
    let changed = false;
    try { changed = await getCameras(); } catch {}
    getLayout(changed);
  }, 30_000);
})();
let lastLayout = null;
async function getLayout(force = false) {
  try {
    const raw = await (await fetch('layout.json', { cache: 'no-store' })).text();
    if (raw === lastLayout && !force) return;
    lastLayout = raw; const d = JSON.parse(raw);
    saved = { ...d, paths: d.paths.filter(camera) };
    if (!layoutMode) { layout = saved; drawGrid(); }
  } catch {}
}
