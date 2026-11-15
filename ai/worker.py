"""
cam-ai: kamera panelinin goruntu analizi (YOLO11n-pose, CPU, onnxruntime).

 - Panelden ayar alir (POST /api/ai/heartbeat, 15 sn) ve her kanal icin ayri surec acar.
 - Kare kaynagi panelin PAYLASILAN alt akisi (GET /api/ai/stream?channel=N, ham JPEG dizisi): cihaza ek baglanti acilmaz.
 - Yazilim hareket on-suzgeci -> pose (kisi kutusu + 17 eklem) -> basit IoU izleyici -> durum kurallari:
     person   : yeni kisi (3 karede dogrulanmis iz)
     fall     : dik durustan 1.5 sn icinde yatay duruma gecis
     collapse : yatay ve hareketsiz > collapseSec
     fight    : (deneysel) iki kisi ust uste ve bilekler cok hizli
     motion   : kisi yokken hareket
 - Olay -> POST /api/ai/report (isaretli JPEG, base64). Bildirim karari (bekleme, saat) panelde. Diske hicbir sey yazilmaz.
"""
import base64, json, math, multiprocessing as mp, os, signal, threading, time, urllib.request

import cv2
import numpy as np
import onnxruntime as ort

CAM = os.environ.get('CAM_URL', 'http://cam').rstrip('/')
SECRET = os.environ.get('CAM_AI_SECRET', '')
MODEL = os.environ.get('CAM_AI_MODEL', '/models/yolo11n-pose.onnx')
SIZE = int(os.environ.get('CAM_AI_SIZE', '416'))
THREADS = int(os.environ.get('CAM_AI_THREADS', '2'))
HEADERS = {'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'}
# COCO eklemleri: 5/6 omuz, 9/10 bilek, 11/12 kalca
SKELETON = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16)]


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def post(path, body, timeout=10):
    req = urllib.request.Request(CAM + path, data=json.dumps(body).encode(), headers=HEADERS, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


def post_jpeg(channel, data):
    h = {'Authorization': HEADERS['Authorization'], 'Content-Type': 'image/jpeg'}
    req = urllib.request.Request(f'{CAM}/api/ai/preview?channel={channel}', data=data, headers=h, method='POST')
    with urllib.request.urlopen(req, timeout=5) as r:
        return bool(json.loads(r.read() or b'{}').get('watch'))


# ------------------------------------------------------------------ model
class Pose:
    def __init__(self):
        o = ort.SessionOptions()
        o.intra_op_num_threads = THREADS
        o.inter_op_num_threads = 1
        o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.s = ort.InferenceSession(MODEL, o, providers=['CPUExecutionProvider'])
        self.name = self.s.get_inputs()[0].name

    def __call__(self, img, conf=0.35):
        h, w = img.shape[:2]
        r = SIZE / max(h, w)
        nw, nh = int(round(w * r)), int(round(h * r))
        pad = np.full((SIZE, SIZE, 3), 114, np.uint8)
        top, left = (SIZE - nh) // 2, (SIZE - nw) // 2
        pad[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.s.run(None, {self.name: x})[0][0].T          # (N, 56): cx cy w h conf + 17*(x y v)
        out = out[out[:, 4] >= conf]
        if not len(out):
            return []
        cx, cy, bw, bh = out[:, 0], out[:, 1], out[:, 2], out[:, 3]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, bw, bh], 1)
        keep = cv2.dnn.NMSBoxes(boxes.tolist(), out[:, 4].tolist(), conf, 0.45)
        res = []
        for i in np.array(keep).flatten():
            b = boxes[i].copy()
            b[0] = (b[0] - left) / r; b[1] = (b[1] - top) / r; b[2] /= r; b[3] /= r
            k = out[i, 5:].reshape(17, 3).copy()
            k[:, 0] = (k[:, 0] - left) / r; k[:, 1] = (k[:, 1] - top) / r
            res.append({'box': [float(b[0]), float(b[1]), float(b[0] + b[2]), float(b[1] + b[3])], 'score': float(out[i, 4]), 'kp': k})
        return res


def iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    i = max(0, x2 - x1) * max(0, y2 - y1)
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def posture(p):
    """Govde acisi (dikeyden derece) ve yatay mi. Eklem guveni dusukse kutu orani."""
    k, (x1, y1, x2, y2) = p['kp'], p['box']
    w, h = x2 - x1, y2 - y1
    if min(k[5, 2], k[6, 2], k[11, 2], k[12, 2]) > 0.4:
        sx, sy = (k[5, 0] + k[6, 0]) / 2, (k[5, 1] + k[6, 1]) / 2
        hx, hy = (k[11, 0] + k[12, 0]) / 2, (k[11, 1] + k[12, 1]) / 2
        ang = math.degrees(math.atan2(abs(sx - hx), abs(sy - hy) + 1e-6))
        return ang, ang > 60 or (w > 1.3 * h and ang > 45)
    return (75.0 if w > 1.3 * h else 10.0), w > 1.3 * h


class Track:
    n = 0

    def __init__(self, p, t):
        Track.n += 1
        self.id, self.p, self.first, self.seen, self.hits = Track.n, p, t, t, 1
        self.announced = False
        self.upright_at = None          # son dik gorulme ani
        self.lying_since = None
        self.lying_anchor = None        # yatma anindaki merkez (hareketsizlik olcusu)
        self.fell = self.collapsed = False
        self.wrists = []                # (t, [x9,y9,x10,y10])


# ------------------------------------------------------------------ kanal sureci
def frames(channel, latest, stop):
    """Okuyucu ipligi: akisi okur, yalniz EN SON kareyi tutar (isleme yetismezse eski kareler atlanir)."""
    back = 1
    while not stop.is_set():
        try:
            req = urllib.request.Request(f'{CAM}/api/ai/stream?channel={channel}', headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as r:
                buf, back = b'', 1
                while not stop.is_set():
                    chunk = r.read1(65536) if hasattr(r, 'read1') else r.read(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        a = buf.find(b'\xff\xd8')
                        if a < 0:
                            buf = b''; break
                        e = buf.find(b'\xff\xd9', a + 2)
                        if e < 0:
                            buf = buf[a:]; break
                        latest['jpeg'], latest['t'] = buf[a:e + 2], time.time()
                        buf = buf[e + 2:]
                    if len(buf) > 4_000_000:
                        buf = b''
        except Exception as ex:  # noqa: BLE001
            log(f'K{channel + 1} akis: {ex}')
        stop.wait(back); back = min(back * 2, 30)


ASCII = str.maketrans('ıİğĞüÜşŞöÖçÇ°', 'iIgGuUsSoOcC ')


def draw(img, people, title):
    title = title.translate(ASCII)
    v = img.copy()
    for p in people:
        x1, y1, x2, y2 = map(int, p['box'])
        c = (0, 0, 255) if p.get('alarm') else (0, 200, 0)
        cv2.rectangle(v, (x1, y1), (x2, y2), c, 2)
        if p.get('label'):
            t = p['label'].translate(ASCII)
            (tw, th), _ = cv2.getTextSize(t, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            ty = max(y1, th + 26)
            cv2.rectangle(v, (x1, ty - th - 4), (x1 + tw + 6, ty), c, -1)
            cv2.putText(v, t, (x1 + 3, ty - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        k = p['kp']
        for a, b in SKELETON:
            if k[a, 2] > 0.4 and k[b, 2] > 0.4:
                cv2.line(v, (int(k[a, 0]), int(k[a, 1])), (int(k[b, 0]), int(k[b, 1])), (255, 200, 0), 1)
    cv2.rectangle(v, (0, 0), (v.shape[1], 22), (0, 0, 0), -1)
    cv2.putText(v, title, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    ok, j = cv2.imencode('.jpg', v, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return j.tobytes() if ok else None


def annotate(img, people, title):
    j = draw(img, people, title)
    return base64.b64encode(j).decode() if j else None


def run_channel(channel, cfg, counter):
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    model, latest, stop = Pose(), {'jpeg': None, 't': 0}, threading.Event()
    threading.Thread(target=frames, args=(channel, latest, stop), daemon=True).start()
    tracks, prev, last_t, last_motion_ev, last_inf = [], None, 0, 0, 0
    local_gap = {}                       # tur -> son gonderim (yerel seyreltme; asil bekleme panelde)
    view = {'watch': False, 'at': 0}

    def show(img, people, note):
        """Canli algilama onizlemesi: izleyen varken her islenen kare, yoksa 3 sn'de bir (izleyici var mi diye)."""
        now = time.time()
        if now - view['at'] < (0 if view['watch'] else 3):
            return
        view['at'] = now
        j = draw(img, people, f'K{channel + 1}  {time.strftime("%H:%M:%S")}  {note}')
        try:
            view['watch'] = post_jpeg(channel, j) if j else False
        except Exception:  # noqa: BLE001
            view['watch'] = False

    def report(kind, score, detail, img, people):
        now = time.time()
        if now - local_gap.get(kind, 0) < 10 or not cfg.get('types', {}).get(kind):
            return
        local_gap[kind] = now
        image = annotate(img, people, f'K{channel + 1}  {kind}  {time.strftime("%H:%M:%S")}')
        try:
            post('/api/ai/report', {'channel': channel, 'type': kind, 'score': round(score, 3) if score is not None else None, 'detail': detail, 'image': image}, 15)
            log(f'K{channel + 1} olay {kind} {detail}')
        except Exception as ex:  # noqa: BLE001
            log(f'K{channel + 1} rapor: {ex}')

    while True:
        fps = max(1.0, float(cfg.get('fps', 4)))
        wait = last_t + 1.0 / fps - time.time()
        if wait > 0:
            time.sleep(wait)
        last_t = time.time()
        jpeg, ft = latest['jpeg'], latest['t']
        if jpeg is None or last_t - ft > 5:
            time.sleep(0.5); continue
        latest['jpeg'] = None
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        now = ft
        # --- hareket on-suzgeci (160 px gri)
        g = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(img, (160, int(160 * img.shape[0] / img.shape[1]))), cv2.COLOR_BGR2GRAY), (5, 5), 0)
        moved = 0.0
        if prev is not None and prev.shape == g.shape:
            moved = float((cv2.absdiff(g, prev) > 25).mean())
        prev = g
        motion = moved > 0.01
        # kisi izi yoksa ve hareket yoksa model calismaz (2 sn'de bir yine bakilir)
        if not motion and not tracks and now - last_inf < 2:
            counter.value += 1
            show(img, [], 'sakin (model beklemede)')
            continue
        last_inf = now
        people = [p for p in model(img, 0.35) if p['score'] >= 0.35]
        counter.value += 1
        min_score = float(cfg.get('minScore', 0.5))
        # --- izleyici (acgozlu IoU)
        used = set()
        for tr in tracks:
            best, bi = 0.3, -1
            for i, p in enumerate(people):
                if i not in used and iou(tr.p['box'], p['box']) > best:
                    best, bi = iou(tr.p['box'], p['box']), i
            if bi >= 0:
                used.add(bi); tr.p, tr.seen, tr.hits = people[bi], now, tr.hits + 1
        for i, p in enumerate(people):
            if i not in used:
                tracks.append(Track(p, now))
        tracks = [t for t in tracks if now - t.seen < 3]
        live = [t for t in tracks if t.seen == now]
        # --- kurallar
        for tr in live:
            p = tr.p
            ang, lying = posture(p)
            p['label'] = f'#{tr.id} {"yatay" if lying else "dik"} {int(ang)}° %{int(p["score"] * 100)}'
            x1, y1, x2, y2 = p['box']
            cx, cy, size = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1)
            if not tr.announced and tr.hits >= 3 and p['score'] >= min_score:
                tr.announced = True
                report('person', p['score'], f'{len(live)} kişi', img, [t.p for t in live])
            if not lying:
                tr.upright_at, tr.lying_since, tr.lying_anchor, tr.fell, tr.collapsed = now, None, None, False, False
                continue
            if tr.lying_since is None:
                tr.lying_since, tr.lying_anchor = now, (cx, cy, size)
                if tr.upright_at and now - tr.upright_at < 1.5 and not tr.fell:
                    tr.fell = True; p['alarm'] = True
                    report('fall', p['score'], f'gövde açısı {int(ang)}°', img, [t.p for t in live])
            ax, ay, asz = tr.lying_anchor
            if math.hypot(cx - ax, cy - ay) > 0.25 * asz:          # yatarken yer degistirdi: hareketsiz degil
                tr.lying_since, tr.lying_anchor = now, (cx, cy, size)
            p['label'] += f' {int(now - tr.lying_since)}sn'
            if tr.fell or tr.collapsed:
                p['alarm'] = True
            if not tr.collapsed and now - tr.lying_since >= float(cfg.get('collapseSec', 20)):
                tr.collapsed = True; p['alarm'] = True
                report('collapse', p['score'], f'{int(now - tr.lying_since)} sn hareketsiz yatıyor', img, [t.p for t in live])
        # kavga (deneysel): iki kisi temas halinde ve bilek hizi > 1.5 boy/sn, 1 sn boyunca
        if cfg.get('types', {}).get('fight') and len(live) >= 2:
            for tr in live:
                k = tr.p['kp']
                tr.wrists = [w for w in tr.wrists if now - w[0] < 1.5] + [(now, k[9, :2].copy(), k[10, :2].copy(), k[9, 2] > 0.4 and k[10, 2] > 0.4)]
            fast = []
            for tr in live:
                w = [x for x in tr.wrists if x[3]]
                h = tr.p['box'][3] - tr.p['box'][1]
                if len(w) >= 3 and h > 0:
                    sp = [max(np.linalg.norm(b[1] - a[1]), np.linalg.norm(b[2] - a[2])) / max(b[0] - a[0], 1e-3) / h for a, b in zip(w, w[1:])]
                    if np.median(sp) > 1.5:
                        fast.append(tr)
            close = any(iou(a.p['box'], b.p['box']) > 0.05 for i, a in enumerate(live) for b in live[i + 1:])
            if fast and close:
                for tr in fast:
                    tr.p['alarm'] = True
                report('fight', max(t.p['score'] for t in fast), f'{len(live)} kişi, hızlı kol hareketi', img, [t.p for t in live])
        show(img, [t.p for t in live], f'{len(live)} kişi' + (f'  hareket %{moved * 100:.0f}' if motion else ''))
        if motion and not live and now - last_motion_ev > 30:
            last_motion_ev = now
            report('motion', None, f'görüntünün %{moved * 100:.0f} değişti', img, [])


# ------------------------------------------------------------------ yonetici
def cpu_usage():
    try:
        with open('/sys/fs/cgroup/cpu.stat') as f:
            for line in f:
                if line.startswith('usage_usec'):
                    return int(line.split()[1]) / 1e6
    except OSError:
        pass
    return None


def main():
    if not SECRET:
        log('CAM_AI_SECRET yok: bekleniyor'); time.sleep(3600); return
    if not os.path.exists(MODEL):
        log(f'model yok: {MODEL}'); return
    manager = mp.Manager()
    cfg = manager.dict()
    procs, counters = {}, {}
    last_cpu, last_t, last_frames = cpu_usage(), time.time(), 0
    stats = {}
    ncpu = os.cpu_count() or 1
    while True:
        try:
            g = post('/api/ai/heartbeat', {'stats': stats})
            for k in ('types', 'collapseSec', 'minScore', 'fps'):
                cfg[k] = g.get(k)
            want = {c['channel'] for c in g.get('channels', [])} if g.get('enabled') else set()
        except Exception as ex:  # noqa: BLE001
            log(f'nabiz: {ex}'); want = set(procs)      # panel kapaliysa calisan surecler surer
        for k in list(procs):
            if k not in want or not procs[k].is_alive():
                procs[k].terminate(); procs[k].join(5); del procs[k]
                log(f'K{k + 1} durdu')
        for k in want - set(procs):
            counters.setdefault(k, mp.Value('L', 0))
            procs[k] = mp.Process(target=run_channel, args=(k, cfg, counters[k]), daemon=True)
            procs[k].start(); log(f'K{k + 1} basladi')
        now, cpu = time.time(), cpu_usage()
        frames_total = sum(c.value for c in counters.values())
        dt = max(now - last_t, 1e-3)
        stats = {'channels': len(procs), 'fps': round((frames_total - last_frames) / dt, 1),
                 'cpu': round((cpu - last_cpu) / dt / ncpu * 100) if cpu is not None and last_cpu is not None else None}
        last_t, last_cpu, last_frames = now, cpu, frames_total
        time.sleep(15)


if __name__ == '__main__':
    main()
