# Canli izleme (/live) icin mediamtx: resmi imaj + bu deponun ayari. Ayar imajda durur, sunucuya dosya
# baglanmaz (her platform ayni sekilde kurar). Surum panelin denedigiyle ayni tutulur.
FROM bluenviron/mediamtx:1.11.3-ffmpeg
COPY docker/mediamtx.yml /mediamtx.yml
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:9997/v3/paths/list || exit 1
