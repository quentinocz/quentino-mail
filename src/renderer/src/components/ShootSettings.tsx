import { useEffect, useState } from 'react';
import type { CameraSetting } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Ovládání fotoaparátu.
 *
 * ## Proč se seznam voleb nevykresluje napevno
 *
 * Každé tělo umí jiné hodnoty — clona jde po třetinách nebo po polovinách
 * podle objektivu, ISO končí jinde u každé řady, formát se u Canonu jmenuje
 * jinak než u Nikonu. Volby se proto čtou z fotoaparátu a políčko se
 * postaví podle toho, co v něm opravdu je.
 *
 * ## Proč se po přestavení čte hodnota zpátky
 *
 * Tělo hodnotu často přijme a tiše dá jinou: v automatu nejde přestavit
 * čas, u kitového objektivu nejde clona dokořán na dlouhém konci. Kdyby
 * se věřilo tomu, co jsme poslali, svítilo by v aplikaci něco jiného, než
 * co fotoaparát dělá — a to se pozná až na hotových fotkách.
 */

const GROUPS: { id: NonNullable<CameraSetting['group']>; label: string }[] = [
  { id: 'expozice', label: 'Expozice' },
  { id: 'barvy', label: 'Barvy' },
  { id: 'soubor', label: 'Soubor' },
  { id: 'ostření', label: 'Ostření a snímání' }
];

export default function ShootSettings({ connected, onNote }: {
  connected: boolean;
  onNote: (text: string, bad?: boolean) => void;
}) {
  const [handy, setHandy] = useState<CameraSetting[]>([]);
  const [rest, setRest] = useState<string[]>([]);
  const [more, setMore] = useState<Record<string, CameraSetting | null>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    if (!connected) { setHandy([]); setRest([]); return; }
    setLoading(true);
    try {
      const out = await api.shoot.settings(force);
      setHandy(out.handy);
      setRest(out.rest);
      if (out.error) onNote(out.error, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [connected]);

  const change = async (setting: CameraSetting, value: string) => {
    setBusy(setting.path);
    try {
      const out = await api.shoot.setSetting(setting.path, value);
      if (!out.ok) { onNote(out.error || 'nastavení neprošlo', true); return; }
      if (out.setting) {
        const back = out.setting.value;
        setHandy(list => list.map(one => (one.path === setting.path ? { ...one, value: back } : one)));
        setMore(had => (had[setting.path] !== undefined
          ? { ...had, [setting.path]: { ...(had[setting.path] as CameraSetting), value: back } }
          : had));
        if (back !== value) {
          onNote(`Fotoaparát nechal „${setting.label || setting.name}" na ${back} — v tomhle režimu to jinak nejde.`, true);
        }
      }
    } finally {
      setBusy('');
    }
  };

  const openMore = async (path: string) => {
    if (more[path] !== undefined) return;
    setMore(had => ({ ...had, [path]: null }));
    const one = await api.shoot.setting(path);
    setMore(had => ({ ...had, [path]: one }));
  };

  if (!connected) {
    return <div className="sh-panel-note">Nastavení se dá měnit, až bude fotoaparát připojený.</div>;
  }

  return (
    <div className="sh-settings">
      <div className="sh-panel-head">
        <b>Fotoaparát</b>
        {/* Tlačítko čte z těla znovu; při otevření panelu se bere to už načtené */}
        <button className="sh-mini" onClick={() => load(true)} disabled={loading}>
          <Icon name="refresh" size={12} /> {loading ? 'Čtu…' : 'Načíst znovu'}
        </button>
      </div>

      {!handy.length && !loading && (
        <div className="sh-panel-note">
          Tělo nevrátilo žádné nastavitelné volby. U některých fotoaparátů to jde,
          až když jsou v režimu M nebo Av a nemají zamčený ovladač.
        </div>
      )}

      {GROUPS.map(group => {
        const rows = handy.filter(one => one.group === group.id);
        if (!rows.length) return null;
        return (
          <div className="sh-group" key={group.id}>
            <small>{group.label}</small>
            {rows.map(setting => (
              <Field
                key={setting.path}
                setting={setting}
                busy={busy === setting.path}
                onChange={value => change(setting, value)}
              />
            ))}
          </div>
        );
      })}

      {!!rest.length && (
        <div className="sh-group">
          <button className="sh-more" onClick={() => setOpen(one => !one)}>
            <Icon name={open ? 'chevDown' : 'chevRight'} size={12} />
            Ostatní volby fotoaparátu ({rest.length})
          </button>
          {open && (
            <div className="sh-rest">
              {rest.map(path => {
                const one = more[path];
                return (
                  <div className="sh-rest-row" key={path}>
                    {one === undefined
                      ? (
                        <button className="sh-rest-name" onClick={() => openMore(path)}>
                          {path.split('/').pop()}
                        </button>
                      )
                      : one === null
                        ? <span className="sh-rest-name">{path.split('/').pop()} — čtu…</span>
                        : (
                          <Field
                            setting={one}
                            busy={busy === one.path}
                            onChange={value => change(one, value)}
                          />
                        )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ setting, busy, onChange }: {
  setting: CameraSetting;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const label = setting.label || setting.name;

  if (setting.type === 'RADIO' || setting.type === 'MENU') {
    return (
      <label className="sh-field">
        <span>{label}</span>
        <select value={setting.value} disabled={busy} onChange={e => onChange(e.target.value)}>
          {/*
            * Hodnota, kterou tělo hlásí, nemusí být v nabídce — u režimu M
            * vrací Canon čas, který v seznamu voleb chybí. Bez téhle položky
            * by políčko ukázalo první volbu a vypadalo by, že se nastavení
            * samo přepnulo.
            */}
          {!setting.choices.some(one => one.value === setting.value) && setting.value
            ? <option value={setting.value}>{setting.value}</option>
            : null}
          {setting.choices.map(one => (
            <option key={`${one.index}-${one.value}`} value={one.value}>{one.value}</option>
          ))}
        </select>
      </label>
    );
  }

  if (setting.type === 'TOGGLE') {
    const on = setting.value === '1' || setting.value.toLowerCase() === 'on';
    return (
      <label className="sh-field sh-field-toggle">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={e => onChange(e.target.checked ? '1' : '0')}
        />
      </label>
    );
  }

  if (setting.type === 'RANGE') {
    return (
      <label className="sh-field">
        <span>{label}</span>
        <span className="sh-range">
          <input
            type="range"
            min={setting.bottom ?? 0}
            max={setting.top ?? 100}
            step={setting.step || 1}
            value={Number(setting.value) || 0}
            disabled={busy}
            onChange={e => onChange(e.target.value)}
          />
          <b>{setting.value}</b>
        </span>
      </label>
    );
  }

  return (
    <label className="sh-field">
      <span>{label}</span>
      <input
        type="text"
        defaultValue={setting.value}
        disabled={busy}
        onBlur={e => { if (e.target.value !== setting.value) onChange(e.target.value); }}
      />
    </label>
  );
}
