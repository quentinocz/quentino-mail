import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Review, ReviewText, ReviewsState } from '@shared/types';
import { api } from '../api';
import { pickForArticle, sizeOf, uploadToShop } from '../shopfiles';
import { useToast } from '../toast';
import Icon from './Icon';
import HtmlField from './HtmlField';

/**
 * Recenze zákazníků na e-shopu.
 *
 * ## Proč to není jen seznam
 *
 * Recenze je vždycky čtveřice: fotka, popisek pod ní (s odkazem na to, co
 * je na fotce vidět), text od zákazníka a podpis. A celé to ve třech
 * jazycích. Dokud to bylo natvrdo v kusu JavaScriptu na e-shopu, znamenalo
 * přidání jedné recenze dvanáct políček v kódu a jednu špatnou uvozovku od
 * rozbité zdi.
 *
 * Rozhraní je proto rozdělené: vlevo přehled všeho, vpravo jedna recenze
 * a v ní jazyky pod sebou. Vidí se tak na první pohled, co je kde
 * nepřeložené — a právě to je u recenzí nejčastější rozdělaná práce.
 *
 * ## Fotka
 *
 * Vybere se z počítače, převede do WebP a nahraje do souborů na e-shopu;
 * adresa se doplní sama. Ručně vložit adresu jde taky — u fotek, které na
 * e-shopu už jsou.
 */

/**
 * Jak dlouho se čeká, než se rozepsaná recenze uloží.
 *
 * Ukládalo se po každém úhozu a odpověď ze serveru se vracela zpátky do
 * políčka. Při rychlejším psaní se odpovědi míjely, text poskakoval a
 * v popisku (což je HTML) skákal kurzor na začátek — vypadalo to, jako by
 * psaní přestalo fungovat. Teď se píše do místní kopie a ukládá po pauze.
 */
const SAVE_DELAY = 600;

const LANGS: { code: string; label: string }[] = [
  { code: 'cz', label: 'Čeština' },
  { code: 'sk', label: 'Slovenština' },
  { code: 'en', label: 'Angličtina' }
];

function blank(): ReviewText {
  return { caption: '', review: '', name: '' };
}

/** Holý text z popisku — do přehledu, kde se HTML hodí jako pěst na oko. */
function plain(html: string): string {
  return (html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function missingLangs(review: Review): string[] {
  return LANGS
    .filter(one => one.code !== 'cz')
    .filter(one => !(review.langs[one.code]?.caption || '').trim())
    .map(one => one.code.toUpperCase());
}

/**
 * „4 recenzí" v hlavičce vypadalo jako překlep — čeština má u dvojky až
 * čtyřky jiný tvar než u pětky a výš.
 */
function pocetRecenzi(n: number): string {
  if (n === 1) return '1 recenze';
  if (n >= 2 && n <= 4) return `${n} recenze`;
  return `${n} recenzí`;
}

export default function ReviewsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<ReviewsState | null>(null);
  const [pickedId, setPickedId] = useState('');
  const [busy, setBusy] = useState('');
  const [showScript, setShowScript] = useState(false);
  /** Jednorázové převzetí recenzí z původního ručně psaného skriptu */
  const [showImport, setShowImport] = useState(false);
  const [size, setSize] = useState<'normal' | 'full'>(
    () => (localStorage.getItem('reviewsSize') as 'normal' | 'full') || 'normal'
  );

  const load = useCallback(async () => {
    try {
      setState(await api.reviews.state());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const items = state?.items ?? [];
  const picked = useMemo(
    () => items.find(one => one.id === pickedId) ?? items[0] ?? null,
    [items, pickedId]
  );

  /*
   * Rozepsaná recenze se drží tady, ne ve `state`.
   *
   * Políčka čtou z téhle kopie, takže do nich nikdy nespadne odpověď ze
   * serveru uprostřed psaní. `state` se obnoví až po uložení a mění jen
   * seznam vlevo.
   */
  const [edit, setEdit] = useState<Review | null>(null);
  const pending = useRef<Review | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const draft = pending.current;
    if (!draft) return;
    pending.current = null;
    try {
      setState(await api.reviews.save(draft));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  // Přepnutí na jinou recenzi: co je rozepsané, se uloží, a vezme se nová
  useEffect(() => {
    void flush();
    setEdit(picked);
    // Schválně jen podle `id` — při obnovení seznamu se rozepsaná kopie
    // nesmí přepsat tím, co vrátil server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.id]);

  // Zavření okna nesmí rozepsanou změnu ztratit
  useEffect(() => () => { void flush(); }, [flush]);

  /** Co se vykresluje v detailu: rozepsaná kopie, dokud nějaká je. */
  const shown = edit ?? picked;

  /** Uloží hned — pro změny, které se neklepou po písmenech (fotka, zapnutí). */
  const patch = async (review: Review, part: Partial<Review>) => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    pending.current = null;
    const next = { ...review, ...part };
    setEdit(next);
    try {
      setState(await api.reviews.save(next));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /** Psaní: místní kopie se změní hned, uložení se odloží. */
  const patchSoon = (review: Review, part: Partial<Review>) => {
    const next = { ...review, ...part };
    setEdit(next);
    pending.current = next;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, SAVE_DELAY);
  };

  const patchLang = (review: Review, lang: string, part: Partial<ReviewText>) => {
    const langs = { ...review.langs, [lang]: { ...(review.langs[lang] ?? blank()), ...part } };
    patchSoon(review, { langs });
  };

  const add = async () => {
    try {
      const sort = await api.reviews.nextSort();
      const next = await api.reviews.save({ sort, active: true, langs: { cz: blank() } });
      setState(next);
      // Nová je ta první v pořadí — hned se na ni přepne, aby se dala vyplnit
      setPickedId(next.items[0]?.id ?? '');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /**
   * Fotka z počítače: převod do WebP, nahrání na e-shop a adresa zpátky.
   *
   * Rozměry se čtou z hotové fotky, ne ze zadání — zeď je dává do
   * `width`/`height`, aby stránka při načítání nepodskakovala.
   */
  const uploadPhoto = async (review: Review) => {
    if (busy) return;
    let files;
    try {
      files = (await pickForArticle()).filter(one => one.kind === 'image');
    } catch (e: any) {
      return toast(e.message, 'error');
    }
    if (files.length === 0) return toast('Žádná fotka nevybrána.');

    setBusy('Připravuju…');
    try {
      const done = await uploadToShop(files.slice(0, 1), setBusy);
      const url = done[0]?.url ?? '';
      if (!url) {
        return toast(done[0]?.note || 'Adresu fotky se nepodařilo přečíst.', 'error');
      }
      const dims = await sizeOf(url);
      await patch(review, { image: url, width: dims.width, height: dims.height });
      toast('Fotka je na e-shopu a adresa je doplněná.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const translate = async (review: Review) => {
    if (busy) return;
    // Přeložit se má to, co je právě v políčkách, ne to, co bylo naposledy uložené
    await flush();
    setBusy('Překládám…');
    try {
      const out = await api.reviews.translate(review.id);
      await load();
      // Překlad dopsal jazyky, které aplikace nemá v rozepsané kopii — ta se
      // proto zahodí a detail se vykreslí z čerstvých dat
      setEdit(null);
      toast(out.unresolved.length === 0
        ? 'Přeloženo a odkazy dosazené.'
        : `Přeloženo. U ${out.unresolved.length} odkazů se nenašla adresa na cizím trhu: `
          + `${out.unresolved.slice(0, 3).join(', ')}${out.unresolved.length > 3 ? '…' : ''}`,
      out.unresolved.length === 0 ? undefined : 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    // Na web má jít i to, co je zrovna rozepsané
    await flush();
    setBusy('Vystavuju…');
    try {
      setState(await api.reviews.publish());
      toast('Recenze jsou na webu.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const pull = async () => {
    setBusy('Načítám z webu…');
    try {
      const out = await api.reviews.pull();
      setState(out.state);
      // Data z webu jsou od téhle chvíle ta platná — rozepsaná kopie by je přebíjela
      setEdit(null);
      toast(out.note || 'Načteno.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const remove = async (review: Review) => {
    if (!window.confirm('Opravdu smazat tuhle recenzi? Fotka na e-shopu zůstane.')) return;
    try {
      pending.current = null;
      setEdit(null);
      setState(await api.reviews.remove(review.id));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /**
   * Posun v pořadí.
   *
   * Rozepsané se nejdřív uloží a místní kopie se zahodí. Posun přepočítá
   * pořadí u všech recenzí — kdyby se pak uložila kopie z doby před posunem,
   * vrátila by u téhle recenze staré číslo a posun by se zrušil.
   */
  const move = async (id: string, dir: -1 | 1) => {
    await flush();
    setEdit(null);
    try {
      setState(await api.reviews.move(id, dir));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const ready = state?.config.ready;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={`modal rv-modal rv-${size}`}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="star" size={15} /> Recenze zákazníků</span>
          <small className="desc">
            {pocetRecenzi(items.length)}{state?.publishedAt
              ? ` · vystaveno ${new Date(state.publishedAt).toLocaleString('cs-CZ')}`
              : ' · zatím nevystaveno'}
          </small>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => setShowImport(true)} disabled={!!busy}>
            <Icon name="download" size={14} /> Z původního skriptu
          </button>
          <button className="btn ghost" onClick={() => setShowScript(true)}>
            <Icon name="fileText" size={14} /> Skript na web
          </button>
          <button className="btn ghost" onClick={pull} disabled={!!busy || !ready}>
            <Icon name="download" size={14} /> Načíst z webu
          </button>
          <button className="btn primary" onClick={publish} disabled={!!busy || !ready}>
            {busy ? <><span className="spinner-inline" /> {busy}</>
              : <><Icon name="upload" size={14} /> Vystavit{state?.dirty ? ' změny' : ''}</>}
          </button>
          <button className="icon-btn"
            onClick={() => {
              const next = size === 'full' ? 'normal' : 'full';
              setSize(next);
              localStorage.setItem('reviewsSize', next);
            }}
            data-tip={size === 'full' ? 'Zmenšit okno' : 'Na celou obrazovku'}>
            <Icon name={size === 'full' ? 'shrink' : 'expand'} size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
        </div>

        {!ready && (
          <p className="md-warn">
            <Icon name="alert" size={13} /> Chybí napojení na Supabase — vyplň ho v modulu
            „Texty na webu" (Napojení). Recenze se ukládají do téhož projektu.
          </p>
        )}
        {state?.dirty && ready && (
          <p className="rv-note">
            <Icon name="alert" size={13} /> V aplikaci jsou změny, které na webu ještě nejsou.
          </p>
        )}

        <div className="rv-body">
          <div className="rv-list">
            <button className="btn primary rv-add" onClick={add} disabled={!!busy}>
              <Icon name="plus" size={14} /> Nová recenze
            </button>
            {items.length === 0 && (
              <div className="empty-state" style={{ padding: '30px 10px' }}>
                <div className="big">⭐</div>
                <p>Zatím tu nic není.</p>
                <p className="desc">
                  Jestli jsou recenze zatím jen ve skriptu na e-shopu, vystav je odsud
                  a skript nahraď tím novým — dál se budou spravovat tady.
                </p>
              </div>
            )}
            {items.map((one, index) => {
              const missing = missingLangs(one);
              return (
                <button key={one.id}
                  className={`rv-item ${picked?.id === one.id ? 'on' : ''} ${one.active ? '' : 'off'}`}
                  onClick={() => setPickedId(one.id)}>
                  {one.image
                    ? <img src={one.image} alt="" loading="lazy" />
                    : <span className="rv-noimg"><Icon name="image" size={15} /></span>}
                  <span className="rv-name">
                    <b>{plain(one.langs.cz?.caption ?? '') || 'Bez popisku'}</b>
                    <small className="desc">
                      {one.langs.cz?.name ? `${one.langs.cz.name} · ` : ''}
                      {one.langs.cz?.review ? 's recenzí' : 'jen popisek'}
                      {one.active ? '' : ' · vypnutá'}
                    </small>
                  </span>
                  {missing.length > 0 && <span className="rv-tag todo">chybí {missing.join(', ')}</span>}
                  <span className="rv-order">
                    {/* Šipka nahoru je tatáž ikona otočená — jedna sada ikon, jedno pravidlo */}
                    <span className="icon-btn rv-up" role="button" title="Nahoru"
                      onClick={e => { e.stopPropagation(); void move(one.id, -1); }}>
                      <Icon name="chevDown" size={13} />
                    </span>
                    <span className="icon-btn" role="button" title="Dolů"
                      onClick={e => { e.stopPropagation(); void move(one.id, 1); }}>
                      <Icon name="chevDown" size={13} />
                    </span>
                  </span>
                  <span className="desc rv-num">{index + 1}</span>
                </button>
              );
            })}
          </div>

          <div className="rv-detail">
            {!shown ? (
              <div className="empty-state" style={{ padding: '40px 14px' }}>
                <div className="big">📷</div>
                <p>Vyber recenzi vlevo, nebo přidej novou.</p>
              </div>
            ) : (
              <>
                <div className="rv-head">
                  {shown.image
                    ? <img src={shown.image} alt="" />
                    : <span className="rv-noimg big"><Icon name="image" size={22} /></span>}
                  <div className="rv-head-fields">
                    <div className="rv-row">
                      <button className="btn ghost" onClick={() => uploadPhoto(shown)} disabled={!!busy}>
                        {busy ? <><span className="spinner-inline" /> {busy}</>
                          : <><Icon name="upload" size={14} /> Fotka z počítače</>}
                      </button>
                      <label className="pt-check">
                        <input type="checkbox" checked={shown.active}
                          onChange={e => patch(shown, { active: e.target.checked })} />
                        <span>Ukazovat na webu</span>
                      </label>
                      <span style={{ flex: 1 }} />
                      <button className="btn ghost" onClick={() => remove(shown)} disabled={!!busy}>
                        <Icon name="trash" size={14} /> Smazat
                      </button>
                    </div>
                    {/* Adresa se obvykle vkládá ze schránky, ale dá se i psát —
                        ukládat po písmenech by znamenalo totéž poskakování */}
                    <input value={shown.image} placeholder="https://…cdn-upgates.com/… (adresa fotky)"
                      onChange={e => patchSoon(shown, { image: e.target.value.trim() })} />
                    <p className="desc">
                      Fotka se převede do WebP a nahraje do souborů na e-shopu; adresa se doplní
                      sama. {shown.width > 0
                        ? `Rozměr ${shown.width}×${shown.height} px — zeď ho dává do stránky, aby při načítání neposkakovala.`
                        : 'Rozměr se doplní po nahrání fotky.'}
                    </p>
                  </div>
                </div>

                <div className="rv-langs">
                  {LANGS.map(lang => {
                    const text = shown.langs[lang.code] ?? blank();
                    return (
                      <section key={lang.code} className="rv-lang">
                        <div className="rv-lang-head">
                          <h3>{lang.label}</h3>
                          {lang.code === 'cz' ? (
                            <button className="btn ghost" onClick={() => translate(shown)} disabled={!!busy}>
                              <Icon name="globe" size={13} /> Přeložit do SK a EN
                            </button>
                          ) : (
                            <small className="desc">
                              {text.caption ? 'přeloženo' : 'zatím nepřeloženo'}
                            </small>
                          )}
                        </div>

                        {/*
                          * Schválně `div`, ne `label`.
                          *
                          * Popisek se píše do `contenteditable`, což prohlížeč jako ovládací
                          * prvek nebere — v `label` se proto kliknutí přeposílalo prvnímu
                          * tlačítku uvnitř, tedy „Tučně". Kliknutí do textu tak zapnulo tučné
                          * písmo, zaměření skočilo na tlačítko a psát to nešlo vůbec.
                          */}
                        <div className="rv-field">
                          <span>Popisek pod fotkou</span>
                          <HtmlField value={text.caption} rows={3}
                            onChange={html => patchLang(shown, lang.code, { caption: html })} />
                          <small className="desc">
                            Odkaz se přidá označením slov a tlačítkem s řetězem. Při překladu se
                            adresa vymění za tu na daném trhu — aplikace ji najde sama.
                          </small>
                        </div>

                        <label className="rv-field">
                          <span>Recenze zákazníka</span>
                          <textarea rows={3} value={text.review}
                            placeholder="Nepovinné — bez ní zůstane pod fotkou jen popisek"
                            onChange={e => patchLang(shown, lang.code, { review: e.target.value })} />
                        </label>

                        <label className="rv-field">
                          <span>Podpis</span>
                          <input value={text.name} placeholder="Jméno zákazníka"
                            onChange={e => patchLang(shown, lang.code, { name: e.target.value })} />
                          {!!text.review && !text.name && (
                            <small className="rv-warn">
                              Bez podpisu se recenze na webu nevykreslí — je u ní vidět, kdo ji napsal.
                            </small>
                          )}
                        </label>
                      </section>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showScript && state && (
        <ScriptDialog script={state.script} publicUrl={state.config.publicUrl}
          onClose={() => setShowScript(false)} />
      )}

      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onDone={next => { setState(next); setShowImport(false); }} />
      )}
    </div>
  );
}

/**
 * Převzetí recenzí z původního skriptu.
 *
 * Je to jednorázová věc, a přesto si zaslouží vlastní okno: sedmadvacet
 * recenzí ve třech jazycích se ručně přepisovat nebude. Vloží se celý
 * dosavadní skript, aplikace si z něj vezme pole s daty a zbytek zahodí.
 * Co už tu je (pozná se podle adresy fotky), se nepřepisuje — po převzetí
 * se recenze upravují tady.
 */
function ImportDialog({ onClose, onDone }: {
  onClose: () => void; onDone: (state: ReviewsState) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const out = await api.reviews.importLegacy(text);
      toast(out.added > 0
        ? `Převzato ${out.added} recenzí${out.skipped ? `, ${out.skipped} už tu bylo` : ''}.`
        : 'Nic nového — všechny recenze ze skriptu už v aplikaci jsou.');
      onDone(out.state);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal rv-script">
        <div className="modal-head">
          <span className="modal-title"><Icon name="download" size={15} /> Převzít původní recenze</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} disabled={busy}><Icon name="x" size={16} /></button>
        </div>
        <p className="desc rv-script-note">
          Vlož sem celý dosavadní skript s recenzemi z e-shopu. Aplikace si z něj vezme pole
          <code> GALLERY_DATA</code> se všemi jazyky; recenze, které tu už jsou, nechá být.
        </p>
        <div className="modal-body">
          <textarea className="rv-script-text" value={text} spellCheck={false}
            placeholder="Sem vlož obsah původního &lt;script&gt;…"
            onChange={e => setText(e.target.value)} />
        </div>
        <div className="modal-foot">
          <span className="desc">{text.trim() ? `${text.length} znaků` : 'Zatím prázdné'}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Zrušit</button>
          <button className="btn primary" onClick={run} disabled={busy || !text.trim()}>
            {busy ? <><span className="spinner-inline" /> čtu…</> : <><Icon name="check" size={14} /> Převzít</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Skript k vložení do e-shopu.
 *
 * Vkládá se jednou. Uvnitř je adresa, ze které si zeď recenze stahuje,
 * a záložní kopie pro případ výpadku — proto se vyplatí ho po větší změně
 * vložit znovu, i když to není nutné.
 */
function ScriptDialog({ script, publicUrl, onClose }: {
  script: string; publicUrl: string; onClose: () => void;
}) {
  const toast = useToast();
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal rv-script">
        <div className="modal-head">
          <span className="modal-title"><Icon name="fileText" size={15} /> Skript pro e-shop</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost"
            onClick={() => {
              navigator.clipboard.writeText(script)
                .then(() => toast('Skript je ve schránce.'))
                .catch(() => toast('Zkopírovat se nepovedlo — označ text a zkopíruj ručně.', 'error'));
            }}>
            <Icon name="copy" size={14} /> Kopírovat
          </button>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <p className="desc rv-script-note">
          Vlož do šablony e-shopu na místo dosavadní zdi s recenzemi. Data si stahuje
          z {publicUrl || 'Supabase'}; kopie uvnitř skriptu je jen záloha pro případ výpadku.
        </p>
        <div className="modal-body">
          <textarea className="rv-script-text" readOnly value={script} spellCheck={false} />
        </div>
      </div>
    </div>
  );
}
