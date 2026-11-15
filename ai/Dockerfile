# cam-ai: YOLO11n-pose (ONNX) ile goruntu analizi. 1. asama modeli ONNX'e cevirir (torch yalniz burada), 2. asama hafif calisma imaji.
FROM python:3.12-slim AS export
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir ultralytics onnx onnxslim \
 && pip uninstall -y opencv-python && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless
WORKDIR /m
RUN yolo export model=yolo11n-pose.pt format=onnx imgsz=416 simplify=True \
 && yolo export model=yolo11n-seg.pt format=onnx imgsz=416 simplify=True && ls -la /m

FROM python:3.12-slim
RUN pip install --no-cache-dir onnxruntime numpy open-image-models "fast-plate-ocr[onnx]" \
 && (pip uninstall -y opencv-python || true) && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless
# plaka modelleri (bulucu + okuyucu) imaja gomulur: calisirken indirme yok (konteyner salt okunur)
ENV HOME=/opt/ai
RUN python -c "from open_image_models import LicensePlateDetector as D; from fast_plate_ocr import LicensePlateRecognizer as R; D(detection_model='yolo-v9-t-384-license-plate-end2end'); R('cct-s-v1-global-model')" \
 && chmod -R a+rX /opt/ai && du -sh /opt/ai
COPY --from=export /m/yolo11n-pose.onnx /m/yolo11n-seg.onnx /models/
COPY worker.py /app/worker.py
USER nobody
CMD ["python", "-u", "/app/worker.py"]
