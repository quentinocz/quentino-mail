import { useState } from 'react';
import type { ChatOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';

/**
 * Napojení na nasazený chat. Adresa Supabase a veřejný klíč jsou tytéž, které
 * používá webový admin — aplikace se jen připojí k tomu, co už běží.
 */
export default function ChatSettings({ overview, onClose, onSaved }: {
  overview: ChatOverview | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const cfg = overview?.config;
  const [url, setUrl] = useState(cfg?.url ?? '');
  const [anonKey, setAnonKey] = useState('');
  const [apiBase, setApiBase] = useState(cfg?.apiBase ?? '');
  const [personId, setPersonId] = useState<number>(cfg?.operatorPersonId ?? 0);
  const [signMode, setSignMode] = useState<'first' | 'always' | 'off'>(cfg?.signMode ?? 'first');
  const [signSuffix, setSignSuffix] = useState(cfg?.signSuffix ?? 'Quentino');
  const [busy, setBusy] = useState('');

  const save = async () => {
    setBusy('save');
    try {
      await api.chat.saveConfig({
        url,
        ...(anonKey ? { anonKey } : {}),
        apiBase,
        operatorPersonId: personId || null,
        signMode,
        signSuffix
      });
      toast('Uloženo.');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      toast(await api.chat.test());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const person = overview?.persons.find(p => p.id === personId);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(560px, 94vw)' }}>
        <div className="modal-head">
          <span>Nastavení chatu</span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        <div className="modal-body">
          <p className="ig-muted">
            Údaje jsou stejné jako ve webovém adminu chatu — najdeš je v Supabase
            v Settings → API. Aplikace do nasazeného chatu nijak nezasahuje,
            jen čte a píše do téže databáze.
          </p>

          <div className="field">
            <label>Adresa Supabase projektu</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
          </div>
          <div className="field">
            <label>Veřejný (anon) klíč</label>
            <input
              type="password"
              value={anonKey}
              onChange={e => setAnonKey(e.target.value)}
              placeholder={cfg?.hasKey ? '•••••••• (uloženo)' : 'anon public key'}
            />
            <span className="desc">Uloží se do systémové klíčenky, stejně jako hesla k poště.</span>
          </div>

          {/*
            Bezplatný tarif Supabase projekt po pár dnech ticha uspí a chat na
            webu přestane fungovat. Aplikace ho za svého běhu drží vzhůru, ale
            když se týden nespustí, nepomůže to — proto je tady vidět, jak
            dlouho se projekt neozval.
          */}
          {cfg?.ready && (
            <div className={`chat-alive ${cfg.idleDays >= 4 ? 'warn' : ''}`}>
              <Icon name={cfg.idleDays >= 4 ? 'zap' : 'check'} size={13} />
              <span>
                {cfg.idleDays < 0
                  ? 'Projekt se zatím neozval — zkus Otestovat spojení.'
                  : cfg.idleDays === 0
                    ? 'Projekt se ozval dnes. Aplikace ho za svého běhu drží vzhůru.'
                    : `Projekt se neozval ${cfg.idleDays} ${cfg.idleDays < 5 ? 'dny' : 'dnů'}.`}
                <small>
                  Bezplatný tarif uspí projekt po několika dnech bez jediného dotazu a chat
                  na webu pak nefunguje. Dokud aplikace běží, ozývá se za tebe sama.
                </small>
              </span>
            </div>
          )}
          <div className="field">
            <label>Adresa nasazeného chatu</label>
            <input value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="https://chat.quentino.cz" />
            <span className="desc">Odsud se berou produktové karty a vyhledávání produktů.</span>
          </div>

          <div className="field">
            <label>Kdo odpovídá</label>
            <select value={personId} onChange={e => setPersonId(Number(e.target.value))}>
              <option value={0}>Nikdo — nepodepisovat</option>
              {overview?.persons.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <span className="desc">Seznam je stejný jako u podpisů v poště (Nastavení → Osoby).</span>
          </div>

          <div className="field-grid">
            <div className="field">
              <label>Podepisovat</label>
              <select value={signMode} onChange={e => setSignMode(e.target.value as 'first' | 'always' | 'off')}>
                <option value="first">Jen první odpověď v konverzaci</option>
                <option value="always">Každou odpověď</option>
                <option value="off">Vůbec</option>
              </select>
            </div>
            <div className="field">
              <label>Za jménem</label>
              <input value={signSuffix} onChange={e => setSignSuffix(e.target.value)} placeholder="Quentino" />
            </div>
          </div>

          {person && signMode !== 'off' && (
            <div className="ch-sign-preview">
              Podpis bude vypadat takhle: <b>{signSuffix ? `${person.short}, ${signSuffix}` : person.short}</b>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={test} disabled={busy === 'test'}>Vyzkoušet spojení</button>
          <button className="btn primary" onClick={save} disabled={busy === 'save'}>Uložit</button>
        </div>
      </div>
    </div>
  );
}
