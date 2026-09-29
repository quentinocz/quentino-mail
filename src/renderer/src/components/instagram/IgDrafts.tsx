import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IgAlert, IgOverview, IgPost } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { useFilePreview, marketColor } from './IgShared';

/**
 * Rozdělané příspěvky.
 *
 * ## Proč to vypadá jako příspěvek
 *
 * Seznam byl dřív řádek textu na příspěvek — a podle řádku textu se nedá
 * poznat, jestli je práce hotová. Chybějící fotka, nepřeložený trh nebo
 * termín zítra vypadaly úplně stejně jako hotový příspěvek. Karta proto
 * ukazuje to, co uvidí zákazník: fotky, text a datum. Co chybí, je vidět
 * na první pohled, ne až ve chvíli, kdy to mělo vyjít.
 *
 * ## Proč se schvaluje
 *
 * Mezi „je to hotové" a „může to ven" je krok, který dělá hlava. Bez něj
 * by naplánovaná publikace odešla i s překlepem, kterého si nikdo
 * nevšiml, protože se na příspěvek od zařazení do plánu nikdo nepodíval.
 * Schválení navíc **spadne při každé změně** textu nebo médií — jinak by
 * se dalo odsouhlasit prázdné a dopsat cokoli.
 *
 * ## Proč tažení prohazuje termíny
 *
 * Pořadí v plánu je termín. Kdo si přetáhne příspěvek na čtvrtek, chce ho
 * ve čtvrtek — ne posunout celý zbytek měsíce o den. Proto se prohodí jen
 * ty dva termíny, kterých se to týká.
 */

const DRUHY: Record<string, string> = {
  bestseller: 'prodává se',
  lezak: 'leží skladem',
  sezona: 'sezóna',
  zakulisi: 'zákulisí'
};

/** Kdy vyjde, lidsky. Datum je na kartě to, podle čeho se řadí práce. */
function kdy(at: string): { den: string; cas: string; za: string; pozde: boolean } {
  if (!at) return { den: 'bez termínu', cas: '', za: '', pozde: false };
  const d = new Date(at.replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return { den: at, cas: '', za: '', pozde: false };
  const den = d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
  const dow = d.toLocaleDateString('cs-CZ', { weekday: 'short' });
  const cas = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const rozdil = d.getTime() - Date.now();
  const dny = Math.round(rozdil / 86_400_000);
  const za = rozdil < 0
    ? 'termín už minul'
    : dny <= 0 ? 'dnes' : dny === 1 ? 'zítra' : `za ${dny} dní`;
  return { den: `${dow} ${den}`, cas, za, pozde: rozdil < 0 };
}

function Nahled({ file, video }: { file: string; video: boolean }) {
  const preview = useFilePreview(video ? null : file);
  return (
    <div className="igd-thumb">
      {preview
        ? <img src={preview} alt="" />
        : <span className="igd-thumb-ph"><Icon name={video ? 'zap' : 'image'} size={16} /></span>}
      {video && <span className="igd-thumb-tag">video</span>}
    </div>
  );
}

export default function IgDrafts({ overview, onOpenPost }: {
  overview: IgOverview;
  onOpenPost: (id: number) => void;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<IgPost[]>([]);
  const [alerts, setAlerts] = useState<IgAlert[]>([]);
  const [busy, setBusy] = useState('');
  const [wish, setWish] = useState('');
  const [openWish, setOpenWish] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  /*
   * Jazyk náhledu. Texty vznikají překladem z češtiny a zkontrolovat se
   * musí i ostatní trhy — dokud šel vidět jen první, poznalo se prázdné
   * německé znění až ve frontě.
   */
  const [lang, setLang] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, al] = await Promise.all([api.ig.drafts(), api.ig.alerts()]);
      setDrafts(list);
      setAlerts(al);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => api.on('ig:changed', () => { void load(); }), [load]);

  /** Trhy, ve kterých má smysl přepínat — ty, které v příspěvcích opravdu jsou */
  const jazyky = useMemo(() => {
    const set = new Set<string>();
    for (const one of drafts) for (const c of one.captions) set.add(c.lang);
    return [...set].sort();
  }, [drafts]);

  const potiz = (post: IgPost) => alerts.find(a => a.postId === post.id) ?? null;

  const navrhni = async () => {
    setBusy('navrh');
    try {
      const one = await api.ig.proposeOne(wish);
      const id = await api.ig.acceptOne(one);
      setWish('');
      setOpenWish(false);
      await load();
      toast('Návrh je mezi rozdělanými — dodělej fotky a text.');
      onOpenPost(id);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const schval = async (post: IgPost, on: boolean) => {
    try {
      await api.ig.approve(post.id, on);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const smaz = async (post: IgPost) => {
    const nazev = (post.brief || post.planIdea || 'příspěvek').slice(0, 40);
    if (!window.confirm(`Smazat „${nazev}"? Texty i připravené fotky k němu zmizí.`)) return;
    try {
      await api.ig.deletePost(post.id);
      await load();
      toast('Smazáno.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /* Tažení: prohodí termíny dvou příspěvků, zbytek plánu zůstane */
  const pust = async (cil: IgPost) => {
    const zdroj = drag;
    setDrag(null);
    setOver(null);
    if (zdroj == null || zdroj === cil.id) return;
    try {
      await api.ig.planSwap(zdroj, cil.id);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="ig-page igd">
      <div className="ig-plan-head">
        <div>
          <h2>Rozdělané příspěvky</h2>
          <p className="desc">
            Co je rozepsané, čeká na fotky nebo na odsouhlasení. <b>Bez fotky a bez
            schválení nic neodejde</b> — naplánovaná publikace se o to nepokusí.
          </p>
        </div>
        <div className="ig-plan-actions">
          <button className="btn ghost" onClick={() => setOpenWish(one => !one)}>
            <Icon name="sparkles" size={14} /> Navrhnout příspěvek
          </button>
        </div>
      </div>

      {/*
        * Jeden příspěvek na vyžádání. Plán na měsíc je pro rozvahu dopředu,
        * tohle pro chvíli, kdy je důvod hned teď — přišly nové vzory nebo
        * je hezké světlo. Přání je nepovinné.
        */}
      {openWish && (
        <div className="igd-wish">
          <input
            value={wish}
            placeholder={'Na co? Třeba „červená kravata" nebo „nové vzory hedvábných"… (nepovinné)'}
            onChange={e => setWish(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) void navrhni(); }}
          />
          <button className="btn primary" disabled={busy === 'navrh'} onClick={() => void navrhni()}>
            {busy === 'navrh'
              ? <><span className="spinner-inline" /> Přemýšlím…</>
              : <><Icon name="sparkles" size={14} /> Navrhnout</>}
          </button>
          <p className="desc">
            Bez přání vybere téma sám — podle toho, co se prodávalo a co leží skladem.
            Návrh se uloží mezi rozdělané <b>bez termínu</b>: dodělat fotky a poslat ho jde hned.
          </p>
        </div>
      )}

      {jazyky.length > 1 && (
        <div className="igd-langs">
          <span className="desc">Ukázat text:</span>
          <button className={`tab ${lang === '' ? 'active' : ''}`} onClick={() => setLang('')}>
            první trh
          </button>
          {jazyky.map(one => (
            <button key={one} className={`tab ${lang === one ? 'active' : ''}`}
              onClick={() => setLang(one)}
              style={lang === one ? { borderColor: marketColor(overview.markets, one) } : undefined}>
              {one}
            </button>
          ))}
        </div>
      )}

      {drafts.length === 0 && (
        <p className="desc">
          Zatím tu nic není. Tlačítkem <b>Navrhnout příspěvek</b> vznikne jeden na teď,
          nebo si nech v „Plánu na měsíc" rozvrhnout celý měsíc dopředu.
        </p>
      )}

      <div className="igd-list">
        {drafts.map(one => {
          const t = kdy(one.planAt);
          const problem = potiz(one);
          const caption = (lang && one.captions.find(c => c.lang === lang)) || one.captions[0] || null;
          const text = (caption?.text || one.brief || '').trim();
          const bezMedii = one.media.length === 0;
          const prazdne = one.captions.every(c => !c.text.trim());
          return (
            <article
              key={one.id}
              className={`igd-card ${drag === one.id ? 'drag' : ''} ${over === one.id ? 'over' : ''}`
                + `${one.approved ? ' ok' : ''}`}
              draggable={!!one.planAt}
              onDragStart={() => setDrag(one.id)}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onDragOver={e => { if (drag != null && one.planAt) { e.preventDefault(); setOver(one.id); } }}
              onDragLeave={() => setOver(o => (o === one.id ? null : o))}
              onDrop={e => { e.preventDefault(); void pust(one); }}
            >
              {/* Datum je to první, podle čeho se práce řadí — proto je velké */}
              <div className={`igd-when ${t.pozde ? 'late' : ''}`}>
                <b>{t.den}</b>
                <span>{t.cas}</span>
                <small>{t.za}</small>
                {one.planKind && <em>{DRUHY[one.planKind] ?? one.planKind}</em>}
              </div>

              <div className="igd-body">
                <div className="igd-media">
                  {one.media.slice(0, 4).map((m, i) => (
                    <Nahled key={`${m.path}-${i}`} file={m.path} video={m.isVideo} />
                  ))}
                  {bezMedii && (
                    <div className="igd-nomedia">
                      <Icon name="image" size={16} />
                      <span>{one.planIdea ? one.planIdea.slice(0, 90) : 'Chybí fotka'}</span>
                    </div>
                  )}
                  {one.media.length > 4 && <span className="igd-more">+{one.media.length - 4}</span>}
                </div>

                <p className="igd-text">{text ? text.slice(0, 260) : 'Zatím bez textu'}</p>

                <div className="igd-langs-mini">
                  {one.captions.map(c => (
                    <span key={c.id}
                      className={`igd-lang ${c.text.trim() ? '' : 'empty'} ${c.status === 'published' ? 'out' : ''}`}
                      style={{ borderColor: marketColor(overview.markets, c.lang) }}
                      data-tip={c.status === 'published'
                        ? `${c.lang}: už vyšlo`
                        : c.text.trim() ? `${c.lang}: text hotový` : `${c.lang}: text chybí`}>
                      {c.lang}
                    </span>
                  ))}
                </div>
              </div>

              <div className="igd-side">
                {problem && (
                  <div className={`igd-warn ${problem.kind}`}>
                    <Icon name="alert" size={13} />
                    {problem.kind === 'media' && 'Chybí fotka a termín se blíží'}
                    {problem.kind === 'approve' && 'Zítra má vyjít — chybí schválení'}
                    {problem.kind === 'late' && 'Termín minul, příspěvek nevyšel'}
                  </div>
                )}
                <label className="igd-approve" data-tip={bezMedii
                  ? 'Bez fotky to síť nepřijme — schválit nejde'
                  : 'Odsouhlasené smí odejít; každá změna textu nebo fotek schválení zruší'}>
                  <input type="checkbox" checked={one.approved}
                    disabled={bezMedii || prazdne}
                    onChange={e => void schval(one, e.target.checked)} />
                  Schváleno k publikaci
                </label>
                <div className="igd-btns">
                  <button className="btn ghost" onClick={() => onOpenPost(one.id)}>
                    <Icon name="pen" size={13} /> Otevřít
                  </button>
                  <button className="icon-btn danger" onClick={() => void smaz(one)}
                    data-tip="Smazat příspěvek" aria-label="Smazat příspěvek">
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {drafts.some(one => one.planAt) && (
        <p className="desc">
          Příspěvky s termínem se dají <b>přetáhnout</b> jeden na druhý — prohodí si termíny.
          Zbytek plánu zůstane, jak byl.
        </p>
      )}
    </div>
  );
}
