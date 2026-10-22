/** Bagimsiz hata siniflari (baska modulu ice aktarmaz: dairesel bagimlilik olmasin). */

/** Veritabani yazma/okuma hatasi: kullaniciya 500 doner, ayrinti (neden) yalniz sunucu gunlugune yazilir. */
export class DatabaseError extends Error {
  constructor(reason) { super('Veritabanına yazılamadı; işlem yapılmadı.'); this.status = 500; this.code = 'DATABASE'; this.reason = reason; }
}
