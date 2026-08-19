import { useEffect, useState } from 'react';

export type FormFactor = 'phone' | 'tablet' | 'desktop';

/**
 * Na jakém zařízení rozhraní běží.
 *
 * Nativní obal iOS řekne v `data-form`, jestli je to telefon nebo tablet (viz
 * `Bridge/Shim.swift`) — spoléhat se u toho na rozměry okna nejde, protože
 * skript obalu běží dřív, než prohlížeč přečte hlavičku `viewport`, a vyšla by
 * výchozí šířka 980 px. Přesto má úzké okno vždycky přednost: kdyby obal mlčel
 * nebo se spletl, rozvržení se stejně přepne, jak má.
 *
 * Na počítači atribut chybí a jede se podle šířky okna — mobilní rozvržení tak
 * jde vyzkoušet i v prohlížeči zúžením okna.
 */
function detect(): FormFactor {
  const width = window.innerWidth || 0;
  // Do téhle šířky se tři sloupce nevejdou, ať si o sobě zařízení myslí cokoliv
  if (width > 0 && width < 600) return 'phone';

  const attr = document.documentElement.dataset.form;
  if (attr === 'phone' || attr === 'tablet') return attr;

  return width > 0 && width < 760 ? 'phone' : 'desktop';
}

const listeners = new Set<(f: FormFactor) => void>();
let current = detect();

function apply(next: FormFactor) {
  current = next;
  document.documentElement.dataset.formFactor = next;
}

function update() {
  const next = detect();
  if (next === current) return;
  apply(next);
  listeners.forEach(fn => fn(next));
}

apply(current);

window.addEventListener('resize', update);
window.addEventListener('orientationchange', update);
// Rozměry i atribut od obalu můžou dosednout až po prvním vykreslení, proto se
// hodnota přepočítá ještě po načtení stránky a hned v další smyčce.
window.addEventListener('load', update);
document.addEventListener('DOMContentLoaded', update);
setTimeout(update, 0);
setTimeout(update, 300);
window.visualViewport?.addEventListener('resize', update);

export function useFormFactor(): FormFactor {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

export function useIsPhone(): boolean {
  return useFormFactor() === 'phone';
}
