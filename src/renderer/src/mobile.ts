import { useEffect, useState } from 'react';

export type FormFactor = 'phone' | 'tablet' | 'desktop';

/**
 * Na jakém zařízení rozhraní běží.
 *
 * Nativní obal iOS nastaví `data-form` na `phone` nebo `tablet` (viz
 * `Bridge/Shim.swift`). Na počítači atribut chybí, takže se jede podle šířky
 * okna — díky tomu jde mobilní rozvržení vyzkoušet i v prohlížeči zúžením okna.
 */
function detect(): FormFactor {
  const attr = document.documentElement.dataset.form;
  if (attr === 'phone' || attr === 'tablet') return attr;
  return window.innerWidth < 760 ? 'phone' : 'desktop';
}

const listeners = new Set<(f: FormFactor) => void>();
let current = detect();

function update() {
  const next = detect();
  if (next === current) return;
  current = next;
  document.documentElement.dataset.formFactor = next;
  listeners.forEach(fn => fn(next));
}

document.documentElement.dataset.formFactor = current;
window.addEventListener('resize', update);
window.addEventListener('orientationchange', update);

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
