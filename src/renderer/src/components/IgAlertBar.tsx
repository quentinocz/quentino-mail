import { useCallback, useEffect, useState } from 'react';
import type { IgAlert } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Připomínka k naplánovaným příspěvkům.
 *
 * Plán sám nic nepublikuje: příspěvek potřebuje fotky, text a odsouhlasení.
 * Bez připomínky se na to přijde ve chvíli, kdy měl vyjít — a to je pozdě,
 * protože fotky se nenafotí za hodinu. Proto se to říká **dopředu a s
 * různým předstihem**: chybějící fotky tři dny, chybějící schválení den.
 *
 * Vypadá a chová se stejně jako nabídka rozdělané práce z telefonu: je to
 * totéž sdělení („něco na tebe čeká") a učit se dvě podoby téhož by bylo
 * zbytečné. Vnucovat se nesmí — zavřít jde bez otevření a vrátí se, až se
 * plán změní nebo se aplikace spustí znovu.
 */
export default function IgAlertBar({ hidden, onOpen }: {
  /** Když jsou sociální sítě otevřené, není co připomínat */
  hidden?: boolean;
  onOpen: () => void;
}) {
  const [alerts, setAlerts] = useState<IgAlert[]>([]);
  const [closed, setClosed] = useState(false);

  const load = useCallback(() => {
    api.ig.alerts().then(list => {
      setAlerts(list ?? []);
      /*
       * Nová připomínka zavřený proužek zase otevře. Kdo si ho zavřel,
       * odbyl si tím to, co v něm tehdy bylo — ne všechno, co kdy přijde.
       */
      setClosed(prev => (prev && (list ?? []).length > 0 ? prev : false));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    return api.on('ig:changed', () => load());
  }, [load]);

  /*
   * Čas běží i bez změny dat: příspěvek, který byl ráno „za tři dny", je
   * večer „zítra". Přepočítá se proto i sám od sebe, ne jen při změně.
   */
  useEffect(() => {
    const t = setInterval(load, 15 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  const one = alerts[0];
  if (!one || hidden || closed) return null;

  const kolik = alerts.length;
  const text = one.kind === 'late'
    ? `„${one.title}" měl vyjít ${kdy(one.at)} a nevyšel`
    : one.kind === 'media'
      ? `„${one.title}" má vyjít ${kdy(one.at)} a nemá fotky`
      : `„${one.title}" vychází ${kdy(one.at)} a chybí schválení`;

  return (
    <div className={`pt-statusbar live-offer ig-alert ${one.kind === 'late' ? 'late' : ''}`}>
      <span className="pt-status-ico">
        <Icon name={one.kind === 'media' ? 'image' : one.kind === 'late' ? 'alert' : 'check'} size={14} />
      </span>
      <span className="pt-status-text">
        {text}
        {kolik > 1 && <span className="ig-alert-more"> · a další {kolik - 1}</span>}
      </span>
      <button className="btn ghost" onClick={onOpen}>Otevřít</button>
      <button className="icon-btn" onClick={() => setClosed(true)}
        data-tip="Skrýt do příští změny" aria-label="Skrýt">
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/** Termín lidsky — „dnes", „zítra", jinak datum. */
function kdy(at: string): string {
  const d = new Date(String(at).replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return at;
  const dny = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (dny === 0) return 'dnes';
  if (dny === 1) return 'zítra';
  if (dny < 0) return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
  return `za ${dny} dní`;
}
