# cam-ai: YOLO11n-pose (ONNX) ile goruntu analizi. 1. asama modeli ONNX'e cevirir (torch yalniz burada), 2. asama hafif calisma imaji.
FROM python:3.12-slim AS export
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir ultralytics onnx onnxslim \
 && pip uninstall -y opencv-python && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless
WORKDIR /m
RUN yolo export model=yolo11n-pose.pt format=onnx imgsz=416 simplify=True \
 && yolo export model=yolo11n.pt format=onnx imgsz=416 simplify=True && ls -la /m

FROM python:3.12-slim
RUN pip install --no-cache-dir onnxruntime opencv-python-headless numpy
COPY --from=export /m/yolo11n-pose.onnx /m/yolo11n.onnx /models/
COPY worker.py /app/worker.py
USER nobody
CMD ["python", "-u", "/app/worker.py"]
