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
     approach : korunan araca (kamera basina sabit koruma alani, guardZones) yaklasan kisi; alani olmayan kanalda arac yok
 - Kontur: yolo11n-seg (kisi + arac maskesi -> cokgen). Canli goruntu ustu katman (POST /api/ai/overlay) yalniz izleyen varken.
     plate    : hareket varken 3 sn'de bir ANA akistan tek kare (GET /api/ai/snapshot) -> plaka bulucu + OCR;
                yalniz >=45 px plaka, Turk plaka bicimi, 60 sn icinde 2 ayni okuma; ayni plaka 30 dk gorulmeden tekrar bildirilmez
 - Olay -> POST /api/ai/report (isaretli JPEG, base64). Bildirim karari (bekleme, saat) panelde. Diske hicbir sey yazilmaz.
"""
import base64, json, math, multiprocessing as mp, os, re, signal, threading, time, urllib.request
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")         # numpy BLAS 8 is parcacigiyla bos donuyordu (olculdu: seg 1003 -> 283 ms CPU)

import cv2
cv2.setNumThreads(1)                     # kanal surecleri zaten paralel; OpenCV ic is parcaciklari CPU sisiriyor
import numpy as np
import onnxruntime as ort

CAM = os.environ.get('CAM_URL', 'http://cam').rstrip('/')
SECRET = os.environ.get('CAM_AI_SECRET', '')
MODEL = os.environ.get('CAM_AI_MODEL', '/models/yolo11n-pose.onnx')
SEGMENT = os.environ.get('CAM_AI_SEG', '/models/yolo11n-seg.onnx')
SIZE = int(os.environ.get('CAM_AI_SIZE', '416'))
THREADS = int(os.environ.get('CAM_AI_THREADS', '2'))
HEADERS = {'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'}
PLATE_RE = re.compile(r'^(0[1-9]|[1-7][0-9]|8[01])([A-Z]{1,3})([0-9]{2,4})$')
PLATE_MIN_W = int(os.environ.get('CAM_AI_PLATE_MIN', '45'))   # px (ana akis); daha kucuk plaka okunamiyor (olculdu: 17-29 px cop)
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


def snapshot(channel):
    req = urllib.request.Request(f'{CAM}/api/ai/snapshot?channel={channel}', headers={'Authorization': HEADERS['Authorization']})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


# ------------------------------------------------------------------ model
class Plates:
    """Plaka bulucu (open-image-models yolo-v9-t-384) + okuyucu (fast-plate-ocr cct-s global). Modeller imajda (HOME onbellegi)."""
    def __init__(self):
        from open_image_models import LicensePlateDetector
        from fast_plate_ocr import LicensePlateRecognizer
        self.det = LicensePlateDetector(detection_model='yolo-v9-t-384-license-plate-end2end')
        self.ocr = LicensePlateRecognizer('cct-s-v1-global-model')

    def __call__(self, img):
        h, w = img.shape[:2]
        res = []
        for d in self.det.predict(img):
            b = d.bounding_box
            if b.x2 - b.x1 < PLATE_MIN_W or d.confidence < 0.5:
                continue
            px, py = int((b.x2 - b.x1) * 0.1), int((b.y2 - b.y1) * 0.2)     # %10 pay: dar kirpmada son hane kaciyor (olculdu)
            crop = img[max(0, b.y1 - py):min(h, b.y2 + py), max(0, b.x1 - px):min(w, b.x2 + px)]
            r = self.ocr.run(crop)[0]
            text = re.sub(r'[^0-9A-Z]', '', str(getattr(r, 'plate', r)).upper())
            m = PLATE_RE.match(text)
            if m:
                res.append({'text': text, 'show': ' '.join(m.groups()), 'box': [b.x1, b.y1, b.x2, b.y2], 'score': float(d.confidence)})
        return res


class Pose:
    def __init__(self, path=MODEL):
        o = ort.SessionOptions()
        o.intra_op_num_threads = THREADS
        o.inter_op_num_threads = 1
        o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.s = ort.InferenceSession(path, o, providers=['CPUExecutionProvider'])
        self.name = self.s.get_inputs()[0].name

    def letterbox(self, img):
        h, w = img.shape[:2]
        r = SIZE / max(h, w)
        nw, nh = int(round(w * r)), int(round(h * r))
        pad = np.full((SIZE, SIZE, 3), 114, np.uint8)
        top, left = (SIZE - nh) // 2, (SIZE - nw) // 2
        pad[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        return self.s.run(None, {self.name: x})[0][0].T, r, top, left

    def __call__(self, img, conf=0.35):
        out, r, top, left = self.letterbox(img)          # (N, 56): cx cy w h conf + 17*(x y v)
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


def detect(model, img, conf):
    """Genis karede iki kare dilim (yukseklik x yukseklik) ayri calisir: uzaktaki kucuk kisi 416'ya kuculunce kaybolmaz."""
    h, w = img.shape[:2]
    if w < h * 1.2:
        return model(img, conf)
    out = []
    for x in (0, w - h):
        for p in model(img[:, x:x + h], conf):
            b = p['box']; p['box'] = [b[0] + x, b[1], b[2] + x, b[3]]
            if p.get('kp') is not None:
                p['kp'][:, 0] += x
            if p.get('poly') is not None:
                p['poly'] = p['poly'] + np.array([x, 0], p['poly'].dtype)
            out.append(p)
    out.sort(key=lambda p: -p['score'])
    keep = []
    for p in out:                                   # dilim ortusmesindeki kopyalar
        if all(iou(p['box'], q['box']) < 0.5 for q in keep):
            keep.append(p)
    return keep


class Seg(Pose):
    """yolo11n-seg (COCO): kisi(0), araba(2), kamyon(7) -> kutu + kontur cokgeni (goruntu pikseli)."""
    def __call__(self, img, conf=0.35):
        h0, w0 = img.shape[:2]
        r = SIZE / max(h0, w0)
        nw, nh = int(round(w0 * r)), int(round(h0 * r))
        pad = np.full((SIZE, SIZE, 3), 114, np.uint8)
        top, left = (SIZE - nh) // 2, (SIZE - nw) // 2
        pad[top:top + nh, left:left + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(pad, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        o = self.s.run(None, {self.name: x})
        out, proto = o[0][0].T, o[1][0]                      # (N, 4+80+32), (32, mh, mw)
        cls = out[:, 4:84].argmax(1); sc = out[np.arange(len(out)), 4 + cls]
        m = ((cls == 0) | (cls == 2) | (cls == 7)) & (sc >= conf)
        out, sc, cls = out[m], sc[m], cls[m]
        if not len(out):
            return []
        boxes = np.stack([out[:, 0] - out[:, 2] / 2, out[:, 1] - out[:, 3] / 2, out[:, 2], out[:, 3]], 1)
        shifted = boxes.copy(); shifted[:, :2] += (cls[:, None] > 0) * 4096      # sinif basina NMS
        keep = np.array(cv2.dnn.NMSBoxes(shifted.tolist(), sc.tolist(), conf, 0.45)).flatten()
        if not len(keep):
            return []
        mh, mw = proto.shape[1:]
        masks = 1 / (1 + np.exp(-(out[keep, 84:] @ proto.reshape(32, -1)))).reshape(-1, mh, mw)
        res = []
        for j, i in enumerate(keep):
            bx, by, bw, bh = boxes[i]
            box = [float((bx - left) / r), float((by - top) / r), float((bx + bw - left) / r), float((by + bh - top) / r)]
            # kontur model uzayinda (SIZE) bulunur, sonra goruntuye olceklenir: tam boy maske buyutme yok (CPU)
            mk = cv2.resize(masks[j], (SIZE, SIZE)) > 0.5
            x1, y1, x2, y2 = max(0, int(bx)), max(0, int(by)), min(SIZE, int(bx + bw) + 1), min(SIZE, int(by + bh) + 1)
            cut = np.zeros((SIZE, SIZE), np.uint8); cut[y1:y2, x1:x2] = mk[y1:y2, x1:x2]
            cs, _ = cv2.findContours(cut, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            poly = None
            if cs:
                c = max(cs, key=cv2.contourArea)
                if cv2.contourArea(c) > 4:
                    c = cv2.approxPolyDP(c, 0.006 * cv2.arcLength(c, True), True).reshape(-1, 2).astype(np.float32)
                    poly = (c - np.array([left, top], np.float32)) / r
            res.append({'cls': 'person' if cls[i] == 0 else 'car', 'box': box, 'score': float(sc[i]), 'poly': poly})
        return res


def follow(poly, a, b):
    """Kutu a'da bulunmus konturu kutu b'ye tasir (seg her karede calismaz)."""
    sx = (b[2] - b[0]) / max(a[2] - a[0], 1e-3); sy = (b[3] - b[1]) / max(a[3] - a[1], 1e-3)
    q = poly.copy(); q[:, 0] = b[0] + (q[:, 0] - a[0]) * sx; q[:, 1] = b[1] + (q[:, 1] - a[1]) * sy
    return q


def overlay_items(marks, w, h):
    """Isaretler -> normalize (0..1) katman ogeleri."""
    items = []
    for p in marks:
        it = {'k': 'car' if p.get('car') else 'vehicle' if p.get('other') else 'person', 'box': [round(p['box'][0] / w, 4), round(p['box'][1] / h, 4), round(p['box'][2] / w, 4), round(p['box'][3] / h, 4)],
              'label': p.get('label') or '', 'alarm': bool(p.get('alarm'))}
        if p.get('poly') is not None:
            it['poly'] = [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in p['poly']]
        k = p.get('kp')
        v = p.get('v')
        if v is not None:
            it['v'] = [round(v[0] / w, 4), round(v[1] / h, 4)]   # hiz (normalize/sn): istemci gecikmeyi ileri tasir
        if k is not None:
            it['kp'] = [[round(float(k[i, 0]) / w, 4), round(float(k[i, 1]) / h, 4)] if k[i, 2] > 0.4 else None for i in range(17)]
        items.append(it)
    return items


def white_ratio(img, box):
    h, w = img.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in box]
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    if x2 - x1 < 8 or y2 - y1 < 8:
        return 0.0
    hsv = cv2.cvtColor(img[y1:y2, x1:x2], cv2.COLOR_BGR2HSV)
    return float(((hsv[:, :, 1] < 50) & (hsv[:, :, 2] > 150)).mean())


def near(person, car, margin=0.25):
    m = margin * (car[2] - car[0])
    x1, y1, x2, y2 = car[0] - m, car[1] - m, car[2] + m, car[3] + m
    return person[0] < x2 and person[2] > x1 and person[1] < y2 and person[3] > y1


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
        c = (255, 140, 0) if p.get('car') else (0, 0, 255) if p.get('alarm') else (0, 200, 0)
        if p.get('poly') is not None and len(p['poly']) >= 3:
            cv2.polylines(v, [p['poly'].astype(np.int32)], True, c, 2, cv2.LINE_AA)
        else:
            cv2.rectangle(v, (x1, y1), (x2, y2), c, 2)
        if p.get('label'):
            t = p['label'].translate(ASCII)
            (tw, th), _ = cv2.getTextSize(t, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            ty = max(y1, th + 26)
            cv2.rectangle(v, (x1, ty - th - 4), (x1 + tw + 6, ty), c, -1)
            cv2.putText(v, t, (x1 + 3, ty - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        k = p.get('kp')
        for a, b in (SKELETON if k is not None else []):
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
    seg = Seg(SEGMENT) if os.path.exists(SEGMENT) else None
    cars, car_check, seg_at = [], 0, 0   # korunan arac [{box, poly, score, at}]
    others = []                          # korunan disindaki araclar (yalniz katmanda gosterilir)
    threading.Thread(target=frames, args=(channel, latest, stop), daemon=True).start()
    tracks, prev, last_t, last_motion_ev, last_inf = [], None, 0, 0, 0
    local_gap = {}                       # tur -> son gonderim (yerel seyreltme; asil bekleme panelde)
    view = {'watch': False, 'at': 0}
    ov = {'watch': False, 'at': 0}       # canli goruntu ustu katman
    state = {'motion_at': 0}

    def plates_loop():
        try:
            reader = Plates()
        except Exception as ex:  # noqa: BLE001
            log(f'K{channel + 1} plaka modeli yok: {ex}'); return
        votes, seen, told, last = {}, {}, set(), 0
        while True:
            time.sleep(0.5)
            now = time.time()
            if not cfg.get('types', {}).get('plate') or now - state['motion_at'] > 8 or now - last < 3:
                continue
            last = now
            try:
                img = cv2.imdecode(np.frombuffer(snapshot(channel), np.uint8), cv2.IMREAD_COLOR)
                found = reader(img) if img is not None else []
            except Exception as ex:  # noqa: BLE001
                log(f'K{channel + 1} plaka: {ex}'); time.sleep(10); continue
            now = time.time()
            for t in [t for t in told if now - seen.get(t, 0) > 1800]:   # 30 dk gorulmeyen plaka yeniden bildirilebilir
                told.discard(t)
            own = set(cfg.get('ownPlates') or [])
            for p in found:
                t = p['text']
                seen[t] = now
                votes[t] = [x for x in votes.get(t, []) if now - x < 60] + [now]
                if len(votes[t]) < 2 or t in told:
                    continue
                told.add(t)
                if t in own:
                    log(f'K{channel + 1} bizim plaka {p["show"]}'); continue
                s = 960 / img.shape[1]
                small = cv2.resize(img, (960, int(img.shape[0] * s)))
                mark = [{'box': [v * s for v in p['box']], 'car': True, 'label': p['show']}]
                try:
                    post('/api/ai/report', {'channel': channel, 'type': 'plate', 'score': None, 'detail': f'Plaka {p["show"]}',
                                            'image': annotate(small, mark, f'K{channel + 1}  plaka {p["show"]}  {time.strftime("%H:%M:%S")}')}, 15)
                    log(f'K{channel + 1} olay plate {p["show"]}')
                except Exception as ex:  # noqa: BLE001
                    log(f'K{channel + 1} rapor: {ex}')
            if len(seen) > 500:
                for t in sorted(seen, key=seen.get)[:250]:
                    seen.pop(t, None); votes.pop(t, None)

    threading.Thread(target=plates_loop, daemon=True).start()

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

    def overlay(img, marks):
        """Katman: izleyen varken her islenen kare, yoksa 3 sn'de bir (izleyen var mi diye)."""
        now = time.time()
        if now - ov['at'] < (0 if ov['watch'] else 3):
            return
        ov['at'] = now
        try:
            ov['watch'] = bool(post('/api/ai/overlay', {'channel': channel, 'age': round(max(0.0, time.time() - ov.get('ft', now)), 3), 'items': overlay_items(marks, img.shape[1], img.shape[0])}, 5).get('watch'))
        except Exception:  # noqa: BLE001
            ov['watch'] = False

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
        if ov['watch']:
            fps = max(fps, 8.0)         # canli katman izlenirken hareketi yakalamak icin daha sik
        wait = last_t + 1.0 / fps - time.time()
        if wait > 0:
            time.sleep(wait)
        last_t = time.time()
        jpeg, ft = latest['jpeg'], latest['t']
        if jpeg is None or last_t - ft > 5:
            time.sleep(0.5); continue
        latest['jpeg'] = None
        ov['ft'] = ft
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
        motion = moved > 0.002
        if moved > 0.01:                 # plaka okuyucu yalniz belirgin harekette (gurultu her 3 sn okumasin)
            state['motion_at'] = now
        # kisi izi yoksa ve hareket yoksa model calismaz (2 sn'de bir yine bakilir)
        if not motion and not tracks and not ov['watch'] and now - last_inf < 1:
            counter.value += 1
            calm = [{'box': c['box'], 'poly': c.get('poly'), 'car': True, 'label': 'korunan arac'} for c in cars]
            show(img, calm, 'sakin (model beklemede)'); overlay(img, others + calm)
            continue
        last_inf = now
        people = [p for p in model(img, 0.3) if p['score'] >= 0.3]   # pose tam kare (eklem); uzaktakini dilimli seg bulur
        counter.value += 1
        min_score = float(cfg.get('minScore', 0.5))
        # --- kontur (seg): izleyen varken saniyede en cok 2, yoksa korunan arac icin 5 sn'de bir
        zone = (cfg.get('guardZones') or {}).get(str(channel))
        segs = None
        # seg (dilimli): kisi bulucu olarak da calisir (pose-nano uzak/koyu giyimli kisiyi kaciriyor, olculdu 0.03 vs seg 0.52)
        if seg and now - seg_at >= (0.5 if ov['watch'] else 1.0):
            seg_at = now
            try:
                segs = detect(seg, img, 0.3)
            except Exception as ex:  # noqa: BLE001
                log(f'K{channel + 1} seg: {ex}'); segs = []
        for s in segs or []:                              # pose'un kacirdigi kisiler (eklemsiz: durus kutu oranindan)
            if s['cls'] == 'person' and s['score'] >= 0.35 and not any(iou(s['box'], p['box']) > 0.3 for p in people):
                people.append({'box': [float(v) for v in s['box']], 'score': s['score'], 'kp': np.zeros((17, 3), np.float32), 'poly': s['poly']})
        # --- korunan arac: yalniz kamera basina tanimli koruma alani (renk tahmini yok: siyah/diger araclar isaretlenmez)
        if zone and (segs is not None or not cars):
            h, w = img.shape[:2]
            zb = [zone[0] * w, zone[1] * h, zone[2] * w, zone[3] * h]
            best, bi = 0.2, None
            for s in segs or []:
                if s['cls'] == 'car' and s['poly'] is not None and iou(s['box'], zb) > best:
                    best, bi = iou(s['box'], zb), s
            poly = bi['poly'] if bi else (cars[0]['poly'] if cars else np.array([[zb[0], zb[1]], [zb[2], zb[1]], [zb[2], zb[3]], [zb[0], zb[3]]], np.float32))
            cars = [{'box': zb, 'poly': poly, 'score': 1.0, 'at': now}]   # kural alanla (sabit), cizim konturla
        elif not zone:
            cars = []
        if segs is not None:
            others = [{'box': s['box'], 'poly': s['poly'], 'other': True, 'label': 'araç'} for s in segs
                      if s['cls'] == 'car' and not any(iou(s['box'], c['box']) > 0.3 for c in cars)]
        car_marks = [{'box': c['box'], 'poly': c.get('poly'), 'score': c['score'], 'car': True, 'label': 'korunan arac'} for c in cars]
        # --- izleyici (acgozlu IoU)
        used = set()
        for tr in tracks:
            best, bi = 0.3, -1
            for i, p in enumerate(people):
                if i not in used and iou(tr.p['box'], p['box']) > best:
                    best, bi = iou(tr.p['box'], p['box']), i
            if bi >= 0:
                used.add(bi)
                a, b, dt = tr.p['box'], people[bi]['box'], now - tr.seen
                if 0 < dt < 1.5:          # merkez hizi (px/sn), yumusatilmis
                    nv = (((b[0] + b[2]) - (a[0] + a[2])) / 2 / dt, ((b[1] + b[3]) - (a[1] + a[3])) / 2 / dt)
                    ov_v = getattr(tr, 'v', None)
                    tr.v = nv if ov_v is None else (0.5 * ov_v[0] + 0.5 * nv[0], 0.5 * ov_v[1] + 0.5 * nv[1])
                tr.p, tr.seen, tr.hits = people[bi], now, tr.hits + 1
                tr.p['v'] = getattr(tr, 'v', None)
        for i, p in enumerate(people):
            if i not in used:
                tracks.append(Track(p, now))
        tracks = [t for t in tracks if now - t.seen < 3]
        live = [t for t in tracks if t.seen == now]
        for tr in live:                                  # kisi konturu: seg sonucundan esle, arada kutuyla tasi
            if segs is not None:
                best, bs = 0.3, None
                for s in segs:
                    if s['cls'] == 'person' and s['poly'] is not None and iou(s['box'], tr.p['box']) > best:
                        best, bs = iou(s['box'], tr.p['box']), s
                if bs:
                    tr.poly, tr.poly_box = bs['poly'], bs['box']
            if getattr(tr, 'poly', None) is not None:
                tr.p['poly'] = follow(tr.poly, tr.poly_box, tr.p['box'])
        # --- kurallar
        for tr in live:
            p = tr.p
            ang, lying = posture(p)
            p['label'] = f'#{tr.id} {"yatay" if lying else "dik"} {int(ang)}° %{int(p["score"] * 100)}'
            x1, y1, x2, y2 = p['box']
            cx, cy, size = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1)
            if cars and tr.hits >= 2 and not getattr(tr, 'near_car', False) and any(near(p['box'], c['box']) for c in cars):
                tr.near_car = True; p['alarm'] = True
                report('approach', p['score'], 'kişi korunan aracın yanında', img, car_marks + [t.p for t in live])
            elif cars and getattr(tr, 'near_car', False) and not any(near(p['box'], c['box'], 0.5) for c in cars):
                tr.near_car = False
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
        show(img, car_marks + [t.p for t in live], f'{len(live)} kişi' + ('  korunan araç' if cars else '') + (f'  hareket %{moved * 100:.0f}' if motion else ''))
        overlay(img, others + car_marks + [t.p for t in tracks if now - t.seen < 0.6])   # seg ile bulunan kisi seg araliginda da gorunur
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
            for k in ('types', 'collapseSec', 'minScore', 'fps', 'guardZones', 'ownPlates'):
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
