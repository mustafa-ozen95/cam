/** Bagimsiz hata siniflari (baska modulu ice aktarmaz: dairesel bagimlilik olmasin). */

/** Veritabani yazma/okuma hatasi: kullaniciya 500 doner, ayrinti (neden) yalniz sunucu gunlugune yazilir. */
export class VeritabaniHatasi extends Error {
  constructor(neden) { super('Veritabanına yazılamadı; işlem yapılmadı.'); this.durum = 500; this.kod = 'VERITABANI'; this.neden = neden; }
}
