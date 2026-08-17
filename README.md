# Quentino App

Desktopová aplikace pro Quentino: e-mailová schránka (IMAP/SMTP) s AI asistencí přes Claude API,
zákaznický chat z e-shopu a vícejazyčné publikování na Instagram a Facebook. Funguje na macOS i Windows.

## Funkce

- Více účtů přes IMAP/SMTP (přihlášení jménem a heslem), složky, vlákna, vyhledávání, přílohy
- Hesla a API klíč šifrovány v systémové keychain (macOS Keychain / Windows DPAPI)
- **AI odpověď z poznámky** — napíšeš „ok, pošleme zítra" a Claude vytvoří slušnou odpověď dle kontextu vlákna a brand promptu Quentina
- **AI shrnutí** — badge s jednou větou o čem e-mail je (automaticky pro nové zprávy, nebo na kliknutí)
- **Vylepšení textu / korekce gramatiky** napsaného e-mailu
- **Překlad** cizojazyčného e-mailu do češtiny + volitelné odeslání odpovědi v jazyce příjemce
- **Automatické třídění** doručené pošty: Objednávky / Lidé / Firmy / Ostatní (pravidla + AI klasifikace)
- Upravitelný **brand prompt** (výchozí: lovebrand, pozitivní tón Quentino) a **HTML podpisy** per účet
- **Plánované odeslání** (fronta „K odeslání" s možností zrušit)
- **Lokální archivace** zpráv včetně příloh (.eml na disku, dostupné offline)
- **Vkládání produktů do e-mailů** — grafická karta s obrázkem, cenou a tlačítkem; odkaz i cena se řídí jazykem e-mailu (CZ/SK/EN). Katalog se plní z Upgates XML feedu a aktualizuje se automaticky každý den.
- Bezpečné zobrazení e-mailů: sanitizace HTML, sandboxovaný iframe, blokování vzdálených obrázků
- **Instagram** (přepínač v postranním panelu) — vícejazyčné publikování: čtení příspěvků z vlastního účtu, přepis popisků pro další trhy, generování textů k nahraným fotkám a videím, fronta a plánování publikací

## Vývoj

Vyžaduje Node.js 20+.

```bash
npm install        # nainstaluje závislosti + přebuildí nativní moduly pro Electron
npm run dev        # vývojový režim (hot reload UI)
npm start          # build + spuštění produkční verze
```

## Build instalátorů

Nativní modul (better-sqlite3) se builduje pro cílovou platformu, proto:

**macOS** (na Macu):
```bash
npm install
npm run dist:mac   # → release/*.dmg (arm64 i x64)
```
Bez Apple Developer podpisu macOS aplikaci při prvním spuštění zablokuje — otevři přes pravý klik → Otevřít, nebo `xattr -cr "/Applications/Quentino Mail.app"`. Pro distribuci podepiš a notarizuj (proměnné `CSC_LINK`, `APPLE_ID` — viz dokumentace electron-builder).

**Windows** (na Windows):
```bash
npm install
npm run dist:win   # → release/*.exe (NSIS instalátor)
```

## První spuštění

1. Nastavení → Účty a podpisy → Přidat účet — vyplň IMAP/SMTP údaje od hostingu (typicky port 993 IMAP SSL, 465 SMTP SSL), otestuj připojení, ulož.
2. Nastavení → AI — vlož Anthropic API klíč (console.anthropic.com), případně uprav brand prompt.
3. Nastavení → Třídění — volitelně uprav pravidla (např. odesílatel obchodu → Objednávky).

## Instagram

Druhý pracovní prostor aplikace (přepínač nahoře v postranním panelu). Z jednoho
zdrojového účtu čerpá příspěvky, přepisuje popisky pro jednotlivé trhy a publikuje
je na cílové účty. Texty píše stejný Claude API klíč, který používá pošta.

**Co je potřeba zařídit jednou:**

1. **Meta aplikace** — developers.facebook.com → Create App → typ **Business**,
   přidat produkt **Instagram**. Všechny účty přepnout na **Professional**
   (Business nebo Creator) a každý propojit s Facebook stránkou.
   App review není potřeba, dokud jsou všechny účty tvoje — stačí Standard Access
   v development módu a účty přidané jako **Instagram Testers**
   (pozvánku je nutné přijmout přímo v Instagramu daného účtu).
2. **Úložiště médií** — Instagram si fotku stahuje z veřejné adresy, přímý upload
   z počítače neexistuje. Aplikace používá Supabase Storage: založ projekt na
   supabase.com a v Instagram → Účty vyplň adresu projektu a service role klíč.
   Bezplatný tarif stačí — po zveřejnění se soubory z úložiště zase mažou.
3. **Návratová adresa** — tlačítko „Vytvořit" v Instagram → Účty nahraje do
   úložiště statickou stránku a vypíše její adresu. Tu vlož v Meta aplikaci do
   *Valid OAuth Redirect URIs*. Vlastní server tedy potřeba není; přihlášení se
   vrátí do aplikace odkazem `quentino-mail://`.

Pak už jen v Účtech připoj postupně jednotlivé účty (první ať je český — z něj se
čerpá) a ve Feedu klikni na „Načíst celý archiv".

**Co je dobré vědět**

- Popisek smí mít 2 200 znaků a 30 hashtagů; aplikace to hlídá před odesláním.
- Publikovat lze řádově desítky příspěvků na účet za 24 hodin (Meta uvádí 100).
- Přístup k účtům platí 60 dní a obnovuje se sám, dokud aplikaci občas zapneš.
- Odkazy na média z Instagramu vyprší, proto se neukládají — aplikace si o čerstvý
  řekne až ve chvíli, kdy soubor opravdu potřebuje.

## Kde jsou data

Vše lokálně ve složce uživatelských dat aplikace (`userData`): SQLite databáze, přílohy (`attachments/`), archiv (`archive/*.eml`).

## Architektura

- `src/main/` — Electron main proces: IMAP (imapflow), SMTP (nodemailer), SQLite (better-sqlite3), Claude API (@anthropic-ai/sdk), plánovač odesílání, šifrování (safeStorage)
- `src/main/instagram/` — Instagram: Graph API (`graph.ts`), úložiště médií (`media.ts`), generování popisků (`captions.ts`), fronta publikací (`publish.ts`), přihlášení (`oauth.ts`), tabulky (`schema.ts`, `store.ts`)
- `src/preload/` — contextBridge s whitelistem IPC kanálů (contextIsolation zapnuto)
- `src/renderer/` — React UI (Vite), sanitizace e-mailů přes DOMPurify; `components/instagram/` je druhý pracovní prostor
- `src/shared/` — sdílené typy
