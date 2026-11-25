/**
 * Tabulky zkušební kabiny.
 *
 * Obrázky v databázi nejsou — leží na disku a v tabulce je k nim cesta.
 * Vrstev je pro dvanáct postav skoro dvě stě a každá má stovky kilobajtů;
 * v databázi, která se zálohuje a synchronizuje mezi zařízeními, by to
 * byla desetkrát větší záloha kvůli datům, která se dají vygenerovat znovu.
 */
export const ZK_SCHEMA = `
CREATE TABLE IF NOT EXISTS zk_postavy (
  id TEXT PRIMARY KEY,
  vek TEXT NOT NULL,
  telo TEXT NOT NULL,
  vyska_cm INTEGER NOT NULL DEFAULT 180,
  sirka INTEGER NOT NULL DEFAULT 0,
  vyska INTEGER NOT NULL DEFAULT 0,
  -- Kde na plátně je temeno a kde podrážka. Od toho se počítá měřítko výšky
  -- a od toho se měří, jestli kus látky leží tam, kam patří.
  temeno INTEGER NOT NULL DEFAULT 0,
  podrazka INTEGER NOT NULL DEFAULT 0,
  zadani TEXT NOT NULL DEFAULT '',
  hotovo INTEGER NOT NULL DEFAULT 0,
  kdy TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS zk_vrstvy (
  postava TEXT NOT NULL,
  typ TEXT NOT NULL,
  varianta TEXT NOT NULL,
  soubor TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  sirka INTEGER NOT NULL DEFAULT 0,
  vyska INTEGER NOT NULL DEFAULT 0,
  podil REAL NOT NULL DEFAULT 0,
  okraje TEXT NOT NULL DEFAULT '',
  stav TEXT NOT NULL DEFAULT 'ceka',
  potiz TEXT NOT NULL DEFAULT '',
  zadani TEXT NOT NULL DEFAULT '',
  kdy TEXT NOT NULL DEFAULT '',
  -- Kovové části šablony (spony a posuvky kšand) zvlášť: nebarví se látkou
  kov TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (postava, typ, varianta)
);

-- Postava po jednotlivých krocích oblékání. Z nich se počítají rozdíly a
-- v okně se na nich pozná, kde se generování pokazilo.
CREATE TABLE IF NOT EXISTS zk_kroky (
  postava TEXT NOT NULL,
  poradi INTEGER NOT NULL,
  typ TEXT NOT NULL DEFAULT '',
  soubor TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (postava, poradi)
);

-- Ke které vrstvě patří který produkt a jakou má barvu. Barva se spočítá
-- z fotky; sloupec rucne znamená, že ji člověk přepsal a nesmí se
-- přepočítat při dalším projetí katalogu.
CREATE TABLE IF NOT EXISTS zk_produkty (
  kod TEXT PRIMARY KEY,
  typ TEXT NOT NULL DEFAULT '',
  varianta TEXT NOT NULL DEFAULT '',
  hex TEXT NOT NULL DEFAULT '',
  -- Vystřižený kousek látky z fotky, jako data: adresa. Motýlek s kostkou
  -- není jedna barva a na modelu se má dláždit vzor, ne flek.
  vzorek TEXT NOT NULL DEFAULT '',
  rucne INTEGER NOT NULL DEFAULT 0,
  -- Kolik centimetrů látky vzorek ukazuje — podle toho se na modelu
  -- zmenší, aby kytky na kravatě měly velikost kytek, ne talířů.
  vzorek_cm REAL NOT NULL DEFAULT 0,
  -- Variantu (šířku, velikost motýlka) vybral člověk: projití katalogu
  -- ji nepřepíše, ani když je produkt schválený.
  varianta_rucne INTEGER NOT NULL DEFAULT 0,
  -- Sada (kšandy s motýlkem, kravata s kapesníčkem): další kusy na modelu,
  -- každý s vlastní látkou. JSON [{typ, varianta, hex, vzorek, vzorekCm}].
  casti TEXT NOT NULL DEFAULT '',
  -- Proč produkt potřebuje kontrolu, než se ukáže v kabině (sada, víc kusů
  -- na fotce). Prázdné = nepotřebuje. Platí, dokud není schválený.
  kontrola TEXT NOT NULL DEFAULT '',
  -- Ruční doladění velikosti vzoru (1 = jak to odhadla aplikace).
  meritko REAL NOT NULL DEFAULT 1,
  -- Co na fotkách produktu poznala AI (JSON ZkRozpoznani): kusy, jejich
  -- látky a odkud se vzaly. V okně se podle toho kontroluje sada.
  ai TEXT NOT NULL DEFAULT '',
  velikosti INTEGER NOT NULL DEFAULT 0,
  schvaleno INTEGER NOT NULL DEFAULT 0,
  kdy TEXT NOT NULL DEFAULT ''
);

-- Produkt vykreslený na modelu (AI podle fotky výrobku a šablony jako
-- vodítka). Výřez kolem kusu ve dvojnásobném rozlišení postavy; x, y,
-- w, h jsou v bodech postavy. dil −1 = hlavní kus, jinak kus sady
-- (ne „cast" — to je v SQL klíčové slovo).
CREATE TABLE IF NOT EXISTS zk_vykresleni (
  kod TEXT NOT NULL,
  dil INTEGER NOT NULL DEFAULT -1,
  postava TEXT NOT NULL,
  typ TEXT NOT NULL DEFAULT '',
  varianta TEXT NOT NULL DEFAULT '',
  soubor TEXT NOT NULL DEFAULT '',
  nahled TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  stav TEXT NOT NULL DEFAULT 'ceka',
  potiz TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  kdy TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kod, dil, postava)
);

-- Uložené vzhledy. V aplikaci kvůli ukázkám a zkoušení; zákazníkovy vzhledy
-- zůstávají v jeho prohlížeči, do aplikace neputují.
CREATE TABLE IF NOT EXISTS zk_vzhledy (
  id TEXT PRIMARY KEY,
  nazev TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  kdy TEXT NOT NULL DEFAULT ''
);
`;

/** Doplňky sloupců pro databáze z minulých verzí. */
export const ZK_ALTERS: string[] = [
  "ALTER TABLE zk_produkty ADD COLUMN vzorek TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE zk_produkty ADD COLUMN vzorek_cm REAL NOT NULL DEFAULT 0",
  "ALTER TABLE zk_produkty ADD COLUMN varianta_rucne INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE zk_produkty ADD COLUMN casti TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE zk_produkty ADD COLUMN kontrola TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE zk_produkty ADD COLUMN meritko REAL NOT NULL DEFAULT 1",
  "ALTER TABLE zk_vrstvy ADD COLUMN kov TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE zk_produkty ADD COLUMN ai TEXT NOT NULL DEFAULT ''"
];
