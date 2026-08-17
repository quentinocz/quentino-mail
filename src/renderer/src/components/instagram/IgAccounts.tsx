import { useEffect, useState } from 'react';
import type { IgOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { fmtDate } from './IgShared';

interface Props {
  overview: IgOverview;
  onChanged: () => void;
}

/**
 * Připojení účtů a služeb.
 *
 * Meta vyžaduje návrat z přihlášení přes HTTPS adresu. Místo vlastního serveru
 * se do úložiště médií vystaví jedna statická stránka — tlačítko níž ji tam
 * nahraje a rovnou vypíše adresu, kterou stačí vložit do Meta aplikace.
 */
export default function IgAccounts({ overview, onChanged }: Props) {
  const toast = useToast();
  const c = overview.connection;

  const [appId, setAppId] = useState(c.appId);
  const [appSecret, setAppSecret] = useState('');
  const [storageUrl, setStorageUrl] = useState(c.storage.url);
  const [storageBucket, setStorageBucket] = useState(c.storage.bucket);
  const [storageKey, setStorageKey] = useState('');
  const [callbackUrl, setCallbackUrl] = useState(c.callbackUrl);
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState<{ igUserId: string; username: string; pageName: string }[] | null>(null);
  const [manual, setManual] = useState<{ lang: string; token: string } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<number, { used: number; cap: number } | null>>({});

  useEffect(() => api.on('ig:connected', (p: any) => {
    if (p?.pick) setPick(p.pick);
    if (p?.saved) setPick(null);
  }), []);

  useEffect(() => {
    let alive = true;
    Promise.all(overview.accounts.map(async a => [a.id, await api.ig.limit(a.id).catch(() => null)] as const))
      .then(rows => { if (alive) setLimits(Object.fromEntries(rows)); });
    return () => { alive = false; };
  }, [overview.accounts]);

  const run = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (ok) toast(ok);
      onChanged();
      return res;
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const saveConn = () => run('save', () => api.ig.saveConnection({
    appId,
    ...(appSecret ? { appSecret } : {}),
    storageUrl,
    storageBucket,
    ...(storageKey ? { storageKey } : {}),
    callbackUrl
  }), 'Uloženo.');

  /**
   * Přidání účtu pro trh. Když aplikace drží přístup z minulého přihlášení,
   * účet se připojí hned; jinak se otevře přihlášení v prohlížeči.
   */
  const connect = async (lang: string) => {
    setBusy(`c-${lang}`);
    try {
      await api.ig.saveConnection({ appId, ...(appSecret ? { appSecret } : {}), callbackUrl });
      const res = await api.ig.addMarket(lang);
      if (res.pick) {
        setPick(res.pick);
      } else if (res.needsLogin) {
        await api.ig.connect(lang);
        toast('Otevřel jsem přihlášení v prohlížeči.');
      } else {
        toast(`Účet připojen jako ${lang}.`);
      }
      onChanged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const marketsWithoutAccount = overview.markets.filter(m =>
    m.enabled && !overview.accounts.some(a => a.lang === m.lang));

  return (
    <div className="ig-page">
      <div className="ig-head"><h2>Účty a připojení</h2></div>

      <div className="ig-cols">
        <section className="ig-card">
          <h3>Připojené účty</h3>
          {overview.accounts.length === 0 && (
            <p className="ig-muted">Zatím žádný. Začni českým účtem — z něj se čerpají příspěvky.</p>
          )}
          {overview.accounts.map(a => (
            <div key={a.id} className="ig-account">
              <span className="ig-lang ig-lang-done" style={{ background: a.color, borderColor: a.color }}>{a.lang}</span>
              <div className="ig-account-body">
                <div className="ig-account-name">
                  @{a.username}
                  {a.isSource && <span className="ig-tag-src">zdroj</span>}
                </div>
                <div className="ig-muted">
                  přístup platí do {fmtDate(a.tokenExpires)}
                  {limits[a.id] && ` · dnes ${limits[a.id]!.used}/${limits[a.id]!.cap} příspěvků`}
                </div>
                {a.pageId ? (
                  <label className="ig-checkline" data-tip="Stejný obsah se po zveřejnění na Instagramu přidá i na Facebook stránku">
                    <input
                      type="checkbox"
                      checked={a.shareFb}
                      onChange={e => run(`fb-${a.id}`, async () => api.ig.setShareFb(a.id, e.target.checked),
                        e.target.checked ? 'Bude se sdílet i na Facebook.' : 'Sdílení na Facebook vypnuto.')}
                    />
                    Sdílet i na stránku {a.pageName || 'Facebook'}
                  </label>
                ) : (
                  <div className="ig-muted">Stránka není známá — připoj účet znovu, doplní se.</div>
                )}
                {a.lastError && <div className="ig-job-error">{a.lastError}</div>}
              </div>
              <div className="ig-job-actions">
                <button className="btn ghost"
                  onClick={() => run(`re-${a.id}`, async () => api.ig.relogin(a.lang),
                    'Otevřel jsem přihlášení — potvrď i oprávnění ke stránce.')}
                  data-tip="Zahodí uložený přístup a projde přihlášením znovu, aby token dostal aktuální oprávnění">
                  Rozšířit oprávnění
                </button>
                {!a.isSource && (
                  <button className="btn ghost" onClick={() => run(`s-${a.id}`, async () => api.ig.setSource(a.id), 'Zdroj přenastaven.')}>
                    Nastavit jako zdroj
                  </button>
                )}
                <button className="btn danger" onClick={() => run(`d-${a.id}`, async () => api.ig.disconnect(a.id), 'Odpojeno.')}>
                  Odpojit
                </button>
              </div>
            </div>
          ))}

          {marketsWithoutAccount.length > 0 && (
            <>
              <div className="ig-section-title">Přidat účet</div>
              <div className="ig-market-picks">
                {marketsWithoutAccount.map(m => (
                  <button
                    key={m.lang}
                    className="ig-pick"
                    style={{ color: m.color, borderColor: m.color }}
                    disabled={busy === `c-${m.lang}` || !appId}
                    onClick={() => connect(m.lang)}
                  >
                    <Icon name="plus" size={12} /> {m.lang} · {m.label}
                  </button>
                ))}
              </div>
              {!appId && <p className="ig-muted">Nejdřív vyplň App ID Meta aplikace vpravo.</p>}
              {overview.accounts.length > 0 && (
                <p className="ig-muted">
                  Přístup z prvního přihlášení si aplikace pamatuje, takže další trh
                  se připojí bez přihlašování — jen vyber jeho zkratku.
                </p>
              )}
              <div className="ig-actions">
                <button className="btn ghost" onClick={() => setPaste('')}
                  data-tip="Když prohlížeč po přihlášení nepřepne zpátky do aplikace">
                  Dokončit z adresy prohlížeče
                </button>
                <button className="btn ghost" onClick={() => setManual({ lang: marketsWithoutAccount[0].lang, token: '' })}>
                  Vložit token ručně
                </button>
              </div>
            </>
          )}

          <button className="btn ghost" onClick={() => run('tok', () => api.ig.refreshTokens(), 'Přístupy obnoveny.')}>
            <Icon name="refresh" size={13} /> Obnovit přístupy
          </button>
        </section>

        <section className="ig-card">
          <h3>Meta aplikace</h3>
          <p className="ig-muted">
            Založ ji na developers.facebook.com jako typ Business a přidej produkt Instagram.
            Účty musí být Professional (Business nebo Creator) a propojené s Facebook stránkou.
          </p>
          <div className="field">
            <label>App ID</label>
            <input value={appId} onChange={e => setAppId(e.target.value)} placeholder="1234567890" />
          </div>
          <div className="field">
            <label>App Secret</label>
            <input
              type="password"
              value={appSecret}
              onChange={e => setAppSecret(e.target.value)}
              placeholder={c.hasAppSecret ? '•••••••• (uloženo)' : 'z Nastavení aplikace v Meta'}
            />
            <span className="desc">Uloží se do systémové klíčenky, stejně jako hesla k poště.</span>
          </div>
          <div className="field">
            <label>Návratová adresa (Valid OAuth Redirect URI)</label>
            <div className="ig-when">
              <input value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} placeholder="vyplní se tlačítkem níž" />
              <button
                className="btn ghost"
                disabled={busy === 'cb'}
                onClick={() => run('cb', async () => {
                  const url = await api.ig.installCallback();
                  setCallbackUrl(url);
                  return url;
                }, 'Stránka je nahraná — adresu vlož do Meta aplikace.')}
              >Vytvořit</button>
            </div>
            <span className="desc">Statická stránka v úložišti, která přihlášení vrátí zpět do aplikace. Žádný server.</span>
          </div>

          <h3>Úložiště médií</h3>
          <p className="ig-muted">
            Instagram si fotku stahuje z veřejné adresy, takže musí být kde ležet.
            Založ projekt na supabase.com a přenes sem adresu a service role klíč.
          </p>
          <div className="field">
            <label>Adresa projektu</label>
            <input value={storageUrl} onChange={e => setStorageUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
          </div>
          <div className="field-grid">
            <div className="field">
              <label>Bucket</label>
              <input value={storageBucket} onChange={e => setStorageBucket(e.target.value)} placeholder="instagram" />
            </div>
            <div className="field">
              <label>Service role klíč</label>
              <input
                type="password"
                value={storageKey}
                onChange={e => setStorageKey(e.target.value)}
                placeholder={c.storage.hasKey ? '•••••••• (uloženo)' : 'z Settings → API'}
              />
            </div>
          </div>

          <div className="ig-actions">
            <button className="btn primary" onClick={saveConn} disabled={busy === 'save'}>Uložit</button>
            <button className="btn ghost" disabled={busy === 'st'} onClick={() => run('st', () => api.ig.testStorage())}>
              Vyzkoušet úložiště
            </button>
          </div>
        </section>
      </div>

      {pick && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPick(null); }}>
          <div className="modal" style={{ width: 'min(460px, 94vw)' }}>
            <div className="modal-head">
              <span>Který účet připojit?</span>
              <button className="icon-btn" onClick={() => setPick(null)}><Icon name="x" size={15} /></button>
            </div>
            <div className="modal-body">
              {pick.map(p => (
                <button key={p.igUserId} className="ig-draft-row" onClick={() => run('fin', async () => {
                  await api.ig.finishConnect(p.igUserId);
                  setPick(null);
                }, 'Účet připojen.')}>
                  <span className="ig-draft-title">@{p.username}</span>
                  <span className="ig-muted">{p.pageName}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {paste !== null && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPaste(null); }}>
          <div className="modal" style={{ width: 'min(560px, 94vw)' }}>
            <div className="modal-head">
              <span>Dokončení přihlášení z adresy</span>
              <button className="icon-btn" onClick={() => setPaste(null)}><Icon name="x" size={15} /></button>
            </div>
            <div className="modal-body">
              <p className="ig-muted">
                Když se po přihlášení otevře stránka „Účet je ověřený" a nic se nestane,
                zkopíruj celou adresu z řádku prohlížeče a vlož ji sem. Obsahuje
                jednorázový kód, kterým se připojení dokončí.
              </p>
              <div className="field">
                <label>Adresa z prohlížeče</label>
                <textarea
                  rows={4}
                  value={paste}
                  autoFocus
                  placeholder="https://…/callback.html?code=…&state=…"
                  onChange={e => setPaste(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setPaste(null)}>Zavřít</button>
              <button className="btn primary" disabled={!paste.includes('code=') || busy === 'pc'}
                onClick={() => run('pc', async () => {
                  const res = await api.ig.pasteCallback(paste);
                  if (res.pick) setPick(res.pick);
                  setPaste(null);
                }, 'Účet připojen.')}>Dokončit</button>
            </div>
          </div>
        </div>
      )}

      {manual && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setManual(null); }}>
          <div className="modal" style={{ width: 'min(520px, 94vw)' }}>
            <div className="modal-head">
              <span>Připojení tokenem</span>
              <button className="icon-btn" onClick={() => setManual(null)}><Icon name="x" size={15} /></button>
            </div>
            <div className="modal-body">
              <p className="ig-muted">
                Náhradní cesta, když přihlášení přes prohlížeč nefunguje. Token vezmi
                z Graph API Exploreru — musí mít oprávnění instagram_basic,
                instagram_content_publish, pages_show_list a business_management.
              </p>
              <div className="field">
                <label>Trh</label>
                <select value={manual.lang} onChange={e => setManual({ ...manual, lang: e.target.value })}>
                  {overview.markets.map(m => <option key={m.lang} value={m.lang}>{m.lang} · {m.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Token</label>
                <textarea rows={4} value={manual.token} onChange={e => setManual({ ...manual, token: e.target.value })} />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setManual(null)}>Zavřít</button>
              <button className="btn primary" onClick={() => run('mt', async () => {
                const res = await api.ig.connectToken(manual.lang, manual.token);
                if (res.pick) setPick(res.pick);
                setManual(null);
              }, 'Token ověřen.')}>Připojit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
