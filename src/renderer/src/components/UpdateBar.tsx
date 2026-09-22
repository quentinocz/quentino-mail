import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Proužek s novou verzí.
 *
 * Nabídka, ne příkaz — stejně jako proužek s rozdělanou prací. Na obrazovce
 * může být rozepsaná odpověď zákazníkovi nebo běžící překlad a vyskočit přes
 * to celým oknem jen proto, že na GitHubu leží nové vydání, by bylo horší
 * než nic.
 *
 * Celá aktualizace je **jedno klepnutí**: stažení i výměna běží za tímhle
 * tlačítkem a aplikace se na konci sama spustí znovu. Aby se po ní nemuselo
 * nic potvrzovat v Nastavení → Soukromí a zabezpečení, stahuje si archiv
 * aplikace sama — karanténní značku, kvůli které se Gatekeeper ptá, věší
 * na soubor ten, kdo ho stáhl, a prohlížeč to je, kdežto aplikace ne.
 */
export default function UpdateBar() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    api.update.state().then(setState).catch(() => {});
    return api.on('update:changed', (one: UpdateState) => setState(one));
  }, []);

  if (!state || !state.newer || !state.canInstall) return null;

  const megabytes = state.size > 0 ? Math.round(state.size / 1_000_000) : 0;

  return (
    /*
     * Vypadá jako proužek s rozdělanou prací schválně — je to totéž
     * sdělení („na pozadí je něco k vyřízení") a učit se dvě podoby téhož
     * by bylo zbytečné. Vlastní třída je kvůli rozlišení, ne kvůli vzhledu.
     */
    <div className="pt-statusbar live-offer update-offer">
      <span className="pt-status-ico"><Icon name="download" size={14} /></span>
      <div className="pt-status-text">
        <b>Je k dispozici verze {String(state.latest).replace(/^v/i, '')}</b>
        <small>
          {state.downloading
            ? `Stahuji… ${state.progress} %`
            : state.ready
              ? 'Staženo — zbývá nasadit, aplikace se sama spustí znovu'
              : `Teď běží ${state.current}${megabytes ? ` · ke stažení ${megabytes} MB` : ''}`}
          {state.error ? ` · ${state.error}` : ''}
        </small>
      </div>
      <span style={{ flex: 1 }} />
      <button
        className="btn primary"
        disabled={state.downloading}
        onClick={async () => {
          /*
           * Jedno klepnutí na obojí. Rozdělit to na „stáhnout" a
           * „nainstalovat" by znamenalo dvě rozhodnutí o téže věci —
           * kdo klepne na aktualizaci, chce ji mít, ne o ní ještě jednou
           * přemýšlet.
           */
          const after = state.ready ? state : await api.update.download();
          setState(after);
          if (after.ready && !after.error) await api.update.install();
        }}
      >
        <Icon name="download" size={13} /> {state.downloading ? `${state.progress} %` : 'Aktualizovat'}
      </button>
      <button
        className="btn ghost"
        onClick={() => api.update.skip(state.latest).then(setState)}
      >
        <Icon name="x" size={12} /> Později
      </button>
    </div>
  );
}
