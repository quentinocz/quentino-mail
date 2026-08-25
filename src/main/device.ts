import crypto from 'crypto';
import os from 'os';
import { getSetting, setSetting } from './db';

/**
 * Trvalá totožnost zařízení.
 *
 * Synchronizace přes sdílenou složku má jednu past: když do jednoho souboru
 * zapisují všechna zařízení, cloud při souběžném zápisu jednu verzi zahodí
 * (nebo z ní udělá „konfliktní kopii", které si nikdo nevšimne) a s ní i
 * změny, které měl jen ten jeden. Řešení je, aby **každé zařízení psalo do
 * vlastního souboru** a ostatní jen četlo — pak nemá co koho přepsat.
 *
 * K tomu je potřeba stálé jméno zařízení. Vygeneruje se jednou a od té chvíle
 * se nemění; do zálohy nepatří, protože po obnovení na druhém počítači by
 * obě zařízení tvrdila, že jsou totéž, a psala by si do stejného souboru.
 */

const ID_KEY = 'deviceId';
const NAME_KEY = 'deviceName';

export function deviceId(): string {
  let id = getSetting(ID_KEY, '')!;
  if (!id) {
    id = crypto.randomUUID();
    setSetting(ID_KEY, id);
  }
  return id;
}

/** Jméno pro člověka — do hlášek typu „kód vydal MacBook". */
export function deviceName(): string {
  let name = getSetting(NAME_KEY, '')!;
  if (!name) {
    name = os.hostname().replace(/\.local$/i, '') || 'Tohle zařízení';
    setSetting(NAME_KEY, name);
  }
  return name;
}

export function setDeviceName(name: string): string {
  const clean = name.trim().slice(0, 60);
  if (clean) setSetting(NAME_KEY, clean);
  return deviceName();
}

/** Jméno v souboru: `id` je jednoznačné, `název` je jen pro čitelnost. */
export function deviceLabel(): string {
  return `${deviceName()} (${deviceId().slice(0, 8)})`;
}
