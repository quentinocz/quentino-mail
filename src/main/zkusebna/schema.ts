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
  rucne INTEGER NOT NULL DEFAULT 0,
  velikosti INTEGER NOT NULL DEFAULT 0,
  schvaleno INTEGER NOT NULL DEFAULT 0,
  kdy TEXT NOT NULL DEFAULT ''
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
