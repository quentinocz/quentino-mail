import { BrowserWindow, session } from 'electron';

/**
 * Načte stránku ve skrytém okně a vrátí HTML až po doběhnutí JavaScriptu.
 *
 * PPL, DPD i další vypisují cestu zásilky až z JS, takže prosté stažení vrátí
 * prázdnou kostru. Okno je bez node integrace a hned se zavírá.
 *
 * Načítání je záměrně shovívavé: stránky dopravců jsou plné reklam a měřicích
 * skriptů, jejichž rámy běžně selhávají. Na výsledek `loadURL` ani na chyby
 * podrámů se proto nečeká a rovnou se čte DOM.
 */

const PARTITION = 'ordertracking';

/** Co se pro čtení textu vůbec nemusí stahovat */
const BLOCKED_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);
const BLOCKED_HOSTS = /googletagmanager|google-analytics|doubleclick|googlesyndication|facebook\.net|facebook\.com|adform|bing\.com|leady\.com|hotjar|clarity\.ms|storyblok|smartlook|seznam\.cz\/rc|gemius|criteo/i;

let filtersReady = false;

/**
 * Stránky dopravců jsou z většiny reklama a měření. Pro vyčtení jednoho řádku
 * stavu je zbytečné to stahovat — bez nich se stránka vykreslí výrazně dřív.
 */
function installFilters() {
  if (filtersReady) return;
  filtersReady = true;
  const s = session.fromPartition(PARTITION);
  s.webRequest.onBeforeRequest((details, cb) => {
    if (BLOCKED_TYPES.has(details.resourceType) || BLOCKED_HOSTS.test(details.url)) {
      cb({ cancel: true });
      return;
    }
    cb({});
  });
}

export async function renderPage(url: string, waitForSource?: string, timeoutMs = 20_000): Promise<string | null> {
  installFilters();

  let win: BrowserWindow | null = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: PARTITION,
      // Skrytému oknu Electron ve výchozím stavu přiškrtí časovače, takže se
      // React widget dopravce vykresluje se zpožděním nebo vůbec
      backgroundThrottling: false
    }
  });

  const close = () => {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  };

  try {
    win.webContents.setAudioMuted(true);
    win.webContents.on('did-fail-load', () => { /* chyby podrámů nás nezajímají */ });
    void win.loadURL(url).catch(() => { /* přesměrování a přerušené navigace jsou běžné */ });

    const marker = waitForSource ?? 'stav z[áa]silky|datum a [čc]as|cesta z[áa]silky|historie|pohyb';
    const deadline = Date.now() + timeoutMs;

    // Během čekání se testuje jen krátká odpověď (nalezeno / délka textu).
    // Celé HTML se přenáší až nakonec — u PPL má přes megabajt a tahat ho
    // přes IPC při každém pokusu bylo to, co načítání zdržovalo.
    const probe = `(() => {
      const t = document.body ? (document.body.innerText || '') : '';
      return { len: t.length, hit: new RegExp(${JSON.stringify(marker)}, 'i').test(t) };
    })()`;

    let sawContent = false;
    while (Date.now() < deadline) {
      if (!win || win.isDestroyed()) break;
      try {
        const r = await win.webContents.executeJavaScript(probe, true) as { len: number; hit: boolean };
        if (r?.len > 200) sawContent = true;
        if (r?.hit) {
          // Nadpis výpisu je tam — krátce počkáme, než doběhnou řádky tabulky
          await new Promise(res => setTimeout(res, 700));
          break;
        }
      } catch { /* stránka se zrovna překresluje, zkusíme za chvíli */ }
      await new Promise(res => setTimeout(res, 250));
    }

    if (!win || win.isDestroyed()) return null;
    if (!sawContent) return null;
    return await win.webContents.executeJavaScript(
      'document.documentElement ? document.documentElement.outerHTML : ""', true
    ) as string;
  } catch {
    return null;
  } finally {
    close();
  }
}
