/**
 * Canli akis gunlugu (docker logs): akis olaylari ve ffmpeg hata satirlari kamera adiyla.
 * Amac kopmanin kaynagini ayirmak: ffmpeg hatayla kapandiysa cihaz baglantiyi kesmistir (satirlar nedenini soyler);
 * ffmpeg calisirken veri kesildiyse cihaz baglantiyi tutup veri gondermeyi birakmistir.
 * Satir seli olmasin: akis basina 60 sn'de en cok 5 ffmpeg satiri yazilir (atlananlar sayilir); son 5 satir kapanista yazilir.
 */
const WINDOW = 60_000, WINDOW_MAX = 5, TAIL = 5;

/** Adresteki kimlik bilgisi gunluge girmez: rtsp://kullanici:parola@ ve Xiongmai'nin user=..&password=.. bicimi. */
export const redact = (s) => String(s)
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s@/]*@/gi, '$1***@')
  .replace(/\b(user|password)=[^&\s]*/gi, '$1=***');

export class FeedLog {
  constructor(label, write = console.log) {
    Object.assign(this, { label, write });
    this.tail = []; this.rest = ''; this.windowStart = 0; this.windowCount = 0; this.skipped = 0;
  }

  event(text) { this.write(`akis [${this.label}] ${text}`); }

  /** ffmpeg stderr parcasi: satirlara bolunur, maskelenir, sinirli sayida yazilir. */
  stderr(b) {
    const lines = (this.rest + b.toString()).split(/\r?\n|\r/);
    this.rest = lines.pop().slice(-2000);
    for (const raw of lines) {
      const line = redact(raw.trim()).slice(0, 300);
      if (!line) continue;
      this.tail.push(line); if (this.tail.length > TAIL) this.tail.shift();
      const now = Date.now();
      if (now - this.windowStart > WINDOW) { this.#flushSkipped(); this.windowStart = now; this.windowCount = 0; }
      if (this.windowCount++ < WINDOW_MAX) this.event(`ffmpeg: ${line}`); else this.skipped++;
    }
  }

  #flushSkipped() { if (this.skipped) this.event(`ffmpeg: (${this.skipped} satır daha yazılmadı)`); this.skipped = 0; }

  /** Kapanis: neden + yazilmamis satir sayisi + ffmpeg'in son satirlari. */
  end(reason) {
    if (this.rest.trim()) { this.stderr('\n'); }
    this.#flushSkipped();
    this.event(`kapandı: ${reason}${this.tail.length ? ` | son ffmpeg satırları: ${this.tail.join(' ‖ ')}` : ''}`);
  }
}
