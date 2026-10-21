FROM node:22-slim
# Güvenlik sürümü çıkınca artır; temel imaj bundan eskiyse derleme durur (önce: docker pull node:22-slim).
ARG NODE_EN_AZ=22.23.4
RUN node -e 'const [a, b] = [process.versions.node, process.env.NODE_EN_AZ].map(s => s.split(".").map(Number)); const k = a.findIndex((x, i) => x !== b[i]); if (k >= 0 && a[k] < b[k]) { console.error("Node en az " + process.env.NODE_EN_AZ + " olmalı"); process.exit(1); }'
RUN apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends ffmpeg tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY routes ./routes
COPY config ./config
COPY resources ./resources
COPY docs ./docs
RUN mkdir -p /app/veri && chown -R node:node /app/veri
# Konteynerde 80: Docker (20.10+) kök olmayan kullanıcıya düşük portu açar (ip_unprivileged_port_start=0).
ENV KAMERA_PORT=80 KAMERA_ADRES=0.0.0.0 TZ=Europe/Istanbul NODE_ENV=production
VOLUME /app/veri
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1/api/v1/saglik').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Hangi commit'ten derlendigi: panel kendi surumunu buradan bilir (Güncelleme sekmesi). Son katmanda: degeri her
# derlemede degisir, onbellegi bozmasin.
ARG SURUM=""
ENV UYGULAMA_SURUMU=${SURUM}
# SURUM verilmezse (commit vermeyen derleme ortamlarında) baglamdaki .git'ten okunur, /app/SURUM'a
# yazilir; config/app.mjs once ortama, sonra bu dosyaya bakar. .git yoksa dosya bos kalir.
RUN --mount=type=bind,target=/tmp/baglam sh /tmp/baglam/docker/surum-oku.sh > /app/SURUM
USER node
CMD ["node", "bin/cam.mjs"]
