import { useEffect, useState } from 'react';
import { api } from './api';
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
