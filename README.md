# Quentino Mail

Desktopový e-mailový klient (IMAP/SMTP) s AI asistencí přes Claude API. Funguje na macOS i Windows.

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

## Kde jsou data

Vše lokálně ve složce uživatelských dat aplikace (`userData`): SQLite databáze, přílohy (`attachments/`), archiv (`archive/*.eml`).

## Architektura

- `src/main/` — Electron main proces: IMAP (imapflow), SMTP (nodemailer), SQLite (better-sqlite3), Claude API (@anthropic-ai/sdk), plánovač odesílání, šifrování (safeStorage)
- `src/preload/` — contextBridge s whitelistem IPC kanálů (contextIsolation zapnuto)
- `src/renderer/` — React UI (Vite), sanitizace e-mailů přes DOMPurify
- `src/shared/` — sdílené typy
