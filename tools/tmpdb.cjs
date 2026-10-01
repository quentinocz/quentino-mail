/**
 * Úklid dočasné databáze zkoušky — i s žurnály.
 *
 * ## Proč to je zvlášť
 *
 * Zkoušky si zakládají databázi v dočasné složce a na začátku ji mažou,
 * aby se každý běh potkal s prázdnem. Mazal se ale jen soubor `.db`;
 * SQLite k němu ale v režimu WAL vede ještě `-wal` (zápisy, které zatím
 * nejsou v databázi) a `-shm` (sdílená paměť mezi procesy).
 *
 * Při normálním konci je po sobě SQLite uklidí samo, takže to nikdy
 * nevadilo. Když se ale běh **přeruší** — Ctrl+C uprostřed sady, pád
 * počítače — oba soubory zůstanou. Další běh pak smaže `.db`, založí
 * nový a narazí na žurnál od databáze, která už neexistuje. macOS to
 * oznámí jako `disk I/O error`, tedy hláškou, která ukazuje na vadný
 * disk — a hledá se pak všude jinde než v dočasné složce. Navíc pokaždé
 * v jiné zkoušce, podle toho, která se k souboru dostane první.
 *
 * Proto se maže celá trojice. Stálo to půl hodiny hledání v modulu
 * focení, který s tím neměl nic společného.
 */
const fs = require('fs');

/** Smaže databázi i oba její žurnály. */
function smazDb(file) {
  for (const cesta of [file, `${file}-wal`, `${file}-shm`]) {
    fs.rmSync(cesta, { force: true });
  }
}

module.exports = { smazDb };
