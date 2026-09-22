import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Aktualizace v nastavení — co běží, co je venku a odkud se to bere.
 *
 * Proužek v okně řeší běžný případ („je novější verze, klepni"); tohle je
 * místo, kde se dá zkontrolovat ručně, vypnout hlídání a přepsat repozitář.
 *
 * ## Proč se to neaktualizuje samo bez ptaní
 *
 * Výměna aplikace znamená její restart. Udělat to uprostřed rozepsané
 * odpovědi zákazníkovi nebo běžícího překladu by bylo horší než počkat do
 * zítra — proto se nová verze jen nabídne a rozhodne člověk.
 */
export default function UpdateCard() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.update.state().then(one => { setState(one); setRepo(one.repo); }).catch(() => {});
    return api.on('update:changed', (one: UpdateState) => setState(one));
  }, []);

  if (!state) return null;

  const megabytes = state.size > 0 ? Math.round(state.size / 1_000_000) : 0;
  const when = state.checkedAt
    ? new Date(state.checkedAt).toLocaleString('cs-CZ',
      { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  /** Stažení i výměna za jedním tlačítkem — kdo klepne, chce novou verzi mít */
  const nasadit = async () => {
    const after = state.ready ? state : await api.update.download();
    setState(after);
    if (after.ready && !after.error) await api.update.install();
  };

  return (
    <>
      <div className="desc" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
        Aplikace hlídá <b>vydání na GitHubu</b> a novou verzi nabídne proužkem v okně.
        Archiv si stahuje a rozbaluje sama — proto po aktualizaci <b>nemusíš nic
        potvrzovat</b> v Nastavení → Soukromí a zabezpečení: značku „staženo
        z internetu", kvůli které se systém ptá, věší na soubor prohlížeč, ne aplikace.
        {!state.canInstall && (
          <> Tohle je vývojový běh, takže tady není co vyměnit — v sestavené aplikaci
          tlačítko funguje.</>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" disabled={state.checking}
          onClick={() => api.update.check().then(setState)}>
          {state.checking ? <span className="spinner-inline" /> : <Icon name="refresh" size={14} />}
          {' '}Zkontrolovat teď
        </button>
        {state.newer && state.canInstall && (
          <button className="btn primary" disabled={state.downloading} onClick={nasadit}>
            <Icon name="download" size={14} />
            {' '}{state.downloading
              ? `Stahuji ${state.progress} %`
              : `Nasadit ${String(state.latest).replace(/^v/i, '')}`}
          </button>
        )}
        {!!state.url && (
          <button className="btn ghost" onClick={() => api.shell.openUrl(state.url)}>
            Vydání na GitHubu
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {state.error
            ? state.error
            : state.newer
              ? `Nová verze ${String(state.latest).replace(/^v/i, '')}${megabytes ? ` · ${megabytes} MB` : ''}`
              : state.latest
                ? `Běží ${state.current} — poslední${when ? ` · kontrola ${when}` : ''}`
                : `Běží ${state.current}`}
        </span>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={state.auto}
          onChange={e => api.update.auto(e.target.checked).then(setState)}
        />
        Hlídat novou verzi sám (jednou za pár hodin)
      </label>

      <div className="field">
        <label>Zdroj aktualizací</label>
        <button className="btn ghost" onClick={() => setOpen(one => !one)}>
          {open ? 'Skrýt' : 'Změnit repozitář'}
        </button>
        {open && (
          <>
            <div className="desc">
              Repozitář ve tvaru <b>vlastnik/nazev</b>. Token je potřeba jen u soukromého
              repozitáře — u veřejného nech políčko prázdné.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={repo}
                placeholder="quentinocz/quentino-mail"
                onChange={e => setRepo(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                type="password"
                value={token}
                placeholder="token (jen u soukromého)"
                onChange={e => setToken(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn" onClick={() => api.update.repo(repo, token)
                .then(one => { setState(one); setToken(''); })}>
                Uložit
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
