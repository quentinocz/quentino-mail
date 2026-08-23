import { useCallback, useEffect, useState } from 'react';
import type { PtransGoogleView, PtransAudit, PtransIssue } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Karta produktu z pohledu vyhledávače a Google Nákupů.
 *
 * Dvě věci vedle sebe, protože spolu souvisí: **atributy**, které se do feedu
 * posílají, a **audit**, který říká, co na nich vadí. Bez auditu jsou atributy
 * jen tabulka a nikdo nepozná, jestli je dobrá; bez atributů je audit seznam
 * stížností, se kterými se nedá nic udělat.
 *
 * Texty píše model, číselníky skládá kód. Rozdíl je vidět i v ovládání:
 * u titulku a popisu je tlačítko „napsat", u barvy a pohlaví „doplnit".
 */

const SEVERITY_LABEL: Record<string, string> = {
  error: 'chyba',
  warn: 'varování',
  info: 'doporučení'
};

/** Číselníkové hodnoty, ať v rozhraní nesvítí `male` a `adult`. */
const VALUE_LABEL: Record<string, string> = {
  male: 'muži', female: 'ženy', unisex: 'unisex',
  adult: 'dospělí', kids: 'děti', infant: 'kojenci', newborn: 'novorozenci', toddler: 'batolata',
  new: 'nové', refurbished: 'repasované', used: 'použité',
  yes: 'ano', no: 'ne'
};

function human(value: string): string {
  return VALUE_LABEL[value] ?? value;
}

export default function ProductGoogle({ code, langs, onChanged }: {
  code: string;
  langs: { code: string; label: string }[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [views, setViews] = useState<PtransGoogleView[]>([]);
  const [audits, setAudits] = useState<PtransAudit[]>([]);
  const [lang, setLang] = useState(langs[0]?.code ?? '');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [google, audit] = await Promise.all([
        api.ptrans.google(code),
        api.ptrans.auditOf(code)
      ]);
      setViews(google);
      setAudits(audit);
      setLang(prev => (google.some(v => v.lang === prev) ? prev : google[0]?.lang ?? ''));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [code, toast]);

  useEffect(() => { load(); }, [load]);

  const view = views.find(v => v.lang === lang);
  const audit = audits.find(a => a.lang === lang);

  const write = async (kind: 'google_title' | 'google_desc') => {
    setBusy(kind);
    try {
      await api.ptrans.googleWrite(code, lang, kind);
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const fill = async () => {
    setBusy('fill');
    try {
      const result = await api.ptrans.googleFill([code]);
      toast(`Doplněno ${result.written} hodnot`);
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const setBundle = async (isBundle: boolean) => {
    setBusy('bundle');
    try {
      const rule = await api.ptrans.markBundle(code, isBundle);
      toast(rule
        ? `Zapamatováno pro tvar „${rule.pattern}" — stejné produkty se označí samy.`
        : 'Uloženo.');
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const fixAll = async () => {
    setBusy('fix');
    try {
      const result = await api.ptrans.fixIssues(code, lang);
      toast(result.fixed.length
        ? `Spraveno ${result.fixed.length} vad${result.skipped.length ? `, ${result.skipped.length} nejde spravit odsud` : ''}`
        : 'Není co spravit automaticky.');
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const editValue = async (field: string, value: string) => {
    try {
      await api.ptrans.edit(code, lang, field, value);
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  if (!view) return <div className="ig-muted" style={{ padding: 14 }}>Načítám…</div>;

  const bundleField = view.fields.find(f => f.field === 'google_bundle');
  const isBundle = (bundleField?.value || '') === 'yes';

  return (
    <div className="pg-wrap">
      <div className="pg-head">
        <div className="ig-seg">
          {langs.map(item => (
            <button key={item.code} className={lang === item.code ? 'active' : ''}
              onClick={() => setLang(item.code)}>{item.code.toUpperCase()}</button>
          ))}
        </div>
        {audit && (
          <span className={`pg-score ${audit.score >= 85 ? 'ok' : audit.score >= 60 ? 'warn' : 'bad'}`}
            data-tip="Skóre kvality: 100 = feed nemá u tohohle produktu co vytknout">
            {audit.score} / 100
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={fill} disabled={!!busy}>
          {busy === 'fill' ? <span className="spinner-inline" /> : <Icon name="zap" size={13} />}
          Doplnit číselníky
        </button>
        {audit && audit.issues.some(issue => issue.fixable) && (
          <button className="btn primary" onClick={fixAll} disabled={!!busy}>
            {busy === 'fix' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />}
            Spravit ({audit.issues.filter(i => i.fixable).length})
          </button>
        )}
      </div>

      <div className="pg-cols">
        <section className="pg-col">
          <h4>Texty pro Google</h4>
          {(['google_title', 'google_desc'] as const).map(field => {
            const row = view.fields.find(f => f.field === field)!;
            return (
              <div key={field} className="pg-text">
                <div className="pg-text-head">
                  <b>{row.label}</b>
                  <span className="ig-muted">{row.value.length} znaků</span>
                  {row.manual && <span className="pt-mem-badge manual">ručně</span>}
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost" onClick={() => write(field)} disabled={!!busy}>
                    {busy === field ? <span className="spinner-inline" /> : <Icon name="sparkles" size={13} />}
                    {row.value ? 'Napsat znovu' : 'Napsat'}
                  </button>
                </div>
                <textarea
                  rows={field === 'google_title' ? 2 : 6}
                  value={row.value}
                  placeholder={row.suggested || 'Zatím prázdné — model to napíše podle parametrů produktu.'}
                  onChange={e => setViews(prev => prev.map(v => v.lang !== lang ? v : {
                    ...v,
                    fields: v.fields.map(f => f.field === field ? { ...f, value: e.target.value } : f)
                  }))}
                  onBlur={e => { if (e.target.value !== row.feed) editValue(field, e.target.value); }}
                />
                {field === 'google_title' && row.suggested && row.suggested !== row.value && (
                  <button className="pg-suggest" onClick={() => editValue(field, row.suggested)}>
                    <Icon name="chevRight" size={11} /> ze šablony: {row.suggested}
                  </button>
                )}
              </div>
            );
          })}
        </section>

        <section className="pg-col">
          <h4>Číselníky</h4>
          <p className="ig-muted">
            Tyhle hodnoty model nepíše — Google u nich zná jen konkrétní možnosti a
            „skoro správně" znamená zahozeno. Skládá je aplikace z parametrů a kategorií.
          </p>
          <table className="pg-table">
            <tbody>
              {view.fields.filter(f => !f.field.endsWith('title') && !f.field.endsWith('desc')).map(row => (
                <tr key={row.field}>
                  <td className="pg-label">{row.label}</td>
                  <td>
                    {row.value
                      ? <span className="pg-value">{human(row.value)}</span>
                      : <span className="pg-empty">chybí</span>}
                    {row.manual && <span className="pt-mem-badge manual">ručně</span>}
                  </td>
                  <td className="pg-sugg">
                    {row.suggested && row.suggested !== row.value && (
                      <button onClick={() => editValue(row.field, row.suggested)}>
                        doplnit „{human(row.suggested)}"
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pg-bundle">
            <div className="pg-bundle-head">
              <b>Je to set?</b>
              <span className={`pt-mem-badge ${view.bundleLearned ? 'manual' : ''}`}>
                {view.bundleLearned ? 'naučeno' : 'z pravidel'}
              </span>
            </div>
            <p className="ig-muted">{view.bundleReason}</p>
            <div className="ig-seg">
              <button className={isBundle ? 'active' : ''} disabled={!!busy}
                onClick={() => setBundle(true)}>Set</button>
              <button className={!isBundle ? 'active' : ''} disabled={!!busy}
                onClick={() => setBundle(false)}>Jeden výrobek</button>
            </div>
            <p className="ig-muted pg-hint">
              Změna se uloží jako pravidlo pro stejný tvar názvu — příště se takové
              produkty označí samy.
            </p>
          </div>
        </section>
      </div>

      {audit && (
        <section className="pg-issues">
          <h4>Co brání dohledatelnosti {audit.issues.length ? `(${audit.issues.length})` : ''}</h4>
          {audit.issues.length === 0 && (
            <div className="ig-muted">U tohohle produktu není v {lang.toUpperCase()} co vytknout.</div>
          )}
          {audit.issues.map((issue: PtransIssue, index: number) => (
            <div key={index} className={`pg-issue ${issue.severity}`}>
              <span className="pg-sev">{SEVERITY_LABEL[issue.severity]}</span>
              <span className="pg-msg">{issue.message}</span>
              {issue.fixable && (
                <button className="btn ghost" disabled={!!busy}
                  onClick={async () => {
                    setBusy(issue.key);
                    try {
                      await api.ptrans.fixIssues(code, lang, [issue.key]);
                      await load();
                      onChanged();
                    } catch (e: any) {
                      toast(e.message, 'error');
                    } finally {
                      setBusy('');
                    }
                  }}>
                  {busy === issue.key ? <span className="spinner-inline" /> : <Icon name="check" size={12} />}
                  Spravit
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
