import { useEffect, useState } from 'react';
import { api } from './api';
import { toolWindowByHash } from '@shared/windows';
import type { ToolWindowId } from '@shared/windows';

/**
 * Které nástroje mají zrovna otevřené vlastní okno.
 *
 * Ptá se na to nabídka Funkcí (aby zvýraznila, co už někde běží) i proužky
 * s rozdělanou prací (aby nenabízely otevřít otevřené). Seznam drží hlavní
 * proces — jediné místo, které o oknech ví — a při každé změně ho rozešle
 * do všech oken.
 *
 * V telefonu okna nejsou a kanál pro ně nativní obal nemá; chyba se proto
 * spolkne a seznam zůstane prázdný, což je pravda.
 */
export function useOpenTools(): ToolWindowId[] {
  const [open, setOpen] = useState<ToolWindowId[]>([]);
  useEffect(() => {
    // Seznam musí být pole i tehdy, když kanál nic nevrátí — jinak by se na
    // nic neptající se telefon rozpadl při prvním `includes`
    api.tool.list().then(list => setOpen(list ?? [])).catch(() => {});
    return api.on('tool:windows', (list: ToolWindowId[]) => setOpen(list ?? []));
  }, []);
  return open;
}

/**
 * Běží tenhle nástroj ve vlastním okně aplikace?
 *
 * Nástroje jsou psané jako překryv nad aplikací a mají v hlavičce svoje
 * ovládání okna — křížek a zvětšení na celou obrazovku. Ve vlastním okně
 * obojí dělá systém: křížek je v rámu okna a zvětšení taky, takže tlačítka
 * v hlavičce jen matou (a „zmenšit na normální velikost" tam nemá co
 * zmenšovat).
 *
 * Pozná se to podle adresy, ne podle třídy na `body`: tu přidává okno až
 * po vykreslení a nástroj by se napoprvé nakreslil s tlačítky, která pak
 * zmizí. Na telefonu je adresa prázdná, takže se nic nemění.
 */
export function inToolWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return !!toolWindowByHash((window.location.hash || '').replace('#', ''));
}
