import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountPublic, ComposeDraft, Person, ProductHit, MailLang, ProductCardStyle } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import { Sheet, SheetActions } from './Sheet';
import { useIsPhone } from '../mobile';
import VoucherDialog from './VoucherDialog';
import AddressInput from './AddressInput';
import ProductBrowser from './ProductBrowser';
import { buildBrandSignature } from '../signature';
import { productBlockForEditor, cleanEditorHtml } from '../productcard';

export interface ComposerInit {
  mode: 'new' | 'reply' | 'forward';
  accountId: number;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
  replyToDbId?: number;
  quotedText?: string;
  attachmentPaths?: string[];
  originalLang?: string | null;
  /** Předvyplněné tělo — prostý text (AI návrh) nebo HTML (obnova po „Zpět") */
  body?: string;
}

export interface UndoInfo {
  outboxId: number;
  reopen: ComposerInit;
}

const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'angličtina' },
  { code: 'de', label: 'němčina' },
  { code: 'sk', label: 'slovenština' },
  { code: 'pl', label: 'polština' },
  { code: 'fr', label: 'francouzština' },
  { code: 'es', label: 'španělština' },
  { code: 'it', label: 'italština' },
  { code: 'nl', label: 'nizozemština' },
  { code: 'hu', label: 'maďarština' },
  { code: 'uk', label: 'ukrajinština' }
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Zapamatovaná velikost okna kompozeru */
const COMPOSER_SIZE_KEY = 'quentino:composerSize';
const MIN_COMPOSER = { w: 560, h: 420 };

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(par => `<p>${escapeHtml(par).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const MAIL_LANGS: { code: MailLang; label: string; iso: string }[] = [
  { code: 'cz', label: 'CZ', iso: 'cs' },
  { code: 'sk', label: 'SK', iso: 'sk' },
  { code: 'en', label: 'EN', iso: 'en' }
];

/**
 * Blok osoby: kulatá fotka s barevným lemem + jméno + pozice dle jazyka e-mailu.
 * E-mail-safe: tabulka, inline styly, pevné rozměry fotky.
 */
function personBlock(person: Person, lang: MailLang, accent: string): string {
  const position = person.positions[lang] || person.positions.cz;
  const photo = person.photoPath
    ? `<td style="padding-right:14px;vertical-align:middle;width:74px"><img src="cid:sig-person" width="60" height="60" style="display:block;width:60px;height:60px;border-radius:50%;object-fit:cover;border:2px solid ${accent}" alt="${escapeHtml(person.name)}"></td>`
    : '';
  return `<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif"><tr>${photo}<td style="vertical-align:middle"><div style="font-weight:bold;font-size:15px;color:#1c1c1c">${escapeHtml(person.name)}</div>${position ? `<div style="color:${accent};font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.8px;padding-top:3px">${escapeHtml(position)}</div>` : ''}</td></tr></table>
<div style="height:1px;background:#ececf2;margin:12px 0;max-width:340px"></div>`;
}

/** Odstraní CID obrázky, ke kterým chybí zdrojový soubor — jinak by příjemce viděl rozbitý obrázek. */
function stripMissingCids(html: string, hasLogo: boolean, hasPhoto: boolean): string {
  let out = html;
  if (!hasLogo) out = out.replace(/<img[^>]*cid:sig-logo[^>]*>/gi, '');
  if (!hasPhoto) out = out.replace(/<img[^>]*cid:sig-person[^>]*>/gi, '');
  return out;
}

/** Jednoduchý rich-text editor (tučně, kurzíva, odkazy, seznamy, obrázky, produktové karty). */
function RichEditor(p: {
  initialHtml: string;
  onChange: (html: string) => void;
  editorRef: React.RefObject<HTMLDivElement>;
  /** Zapamatuje si pozici kurzoru, aby se produkt vložil tam, kde uživatel psal */
  onCaret: () => void;
  onInsertProduct: () => void;
}) {
  useEffect(() => {
    if (p.editorRef.current) p.editorRef.current.innerHTML = p.initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const emitChange = () => { if (p.editorRef.current) p.onChange(p.editorRef.current.innerHTML); };
  const cmd = (c: string, v?: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.execCommand(c, false, v);
    emitChange();
  };
  const addLink = (e: React.MouseEvent) => {
    e.preventDefault();
    const url = prompt('Adresa odkazu (https://…):');
    if (url) { document.execCommand('createLink', false, url.startsWith('http') ? url : `https://${url}`); emitChange(); }
  };
  const addImage = async (e: React.MouseEvent) => {
    e.preventDefault();
    const file = await api.files.pickImage();
    if (!file) return;
    try {
      const dataUrl = await api.files.readAsDataUrl(file);
      p.editorRef.current?.focus();
      document.execCommand('insertImage', false, dataUrl);
      emitChange();
    } catch { /* velký obrázek apod. */ }
  };
  return (
    <div className="rt-wrap">
      <div className="rt-toolbar">
        <button data-tip="Tučně" onMouseDown={cmd('bold')}><Icon name="bold" size={13} /></button>
        <button data-tip="Kurzíva" onMouseDown={cmd('italic')}><Icon name="italic" size={13} /></button>
        <button data-tip="Podtržení" onMouseDown={cmd('underline')}><Icon name="underline" size={13} /></button>
        <span className="rt-sep" />
        <button data-tip="Odrážkový seznam" onMouseDown={cmd('insertUnorderedList')}><Icon name="list" size={13} /></button>
        <button data-tip="Vložit odkaz" onMouseDown={addLink}><Icon name="link" size={13} /></button>
        <button data-tip="Vložit obrázek do textu (odešle se jako součást zprávy)" onMouseDown={e => { void addImage(e); }}><Icon name="image" size={13} /></button>
        <span className="rt-sep" />
        <button data-tip="Odebrat formátování" onMouseDown={cmd('removeFormat')}><Icon name="eraser" size={13} /></button>
        <span className="rt-sep" />
        <button data-tip="Vložit produkt na pozici kurzoru"
          onMouseDown={e => { e.preventDefault(); p.onCaret(); p.onInsertProduct(); }}>
          <Icon name="bag" size={13} />
        </button>
      </div>
      <div
        ref={p.editorRef}
        className="rt-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={emitChange}
        onKeyUp={p.onCaret}
        onMouseUp={p.onCaret}
        onBlur={p.onCaret}
        onClick={e => {
          // Křížek na produktové kartě ji celou odebere
          const btn = (e.target as HTMLElement).closest('[data-action="remove-product"]');
          if (!btn) return;
          e.preventDefault();
          btn.closest('.ins-product')?.remove();
          emitChange();
        }}
        data-placeholder="Napiš zprávu…"
      />
    </div>
  );
}

interface Props {
  init: ComposerInit;
  accounts: AccountPublic[];
  onClose: () => void;
  onSent: (undo?: UndoInfo) => void;
}

export default function Composer(p: Props) {
  const toast = useToast();
  const [accountId, setAccountId] = useState(p.init.accountId);
  const [to, setTo] = useState(p.init.to ?? '');
  const [cc, setCc] = useState(p.init.cc ?? '');
  const [bcc, setBcc] = useState(p.init.bcc ?? '');
  const [showCc, setShowCc] = useState(!!(p.init.cc || p.init.bcc));
  const [subject, setSubject] = useState(p.init.subject ?? '');
  // Tělo zprávy jako HTML (rich-text editor); init.body může být text i HTML
  const initialBodyHtml = p.init.body
    ? (p.init.body.trim().startsWith('<') ? p.init.body : textToHtml(p.init.body))
    : p.init.mode === 'forward' && p.init.quotedText ? textToHtml(`\n\n${p.init.quotedText}`) : '';
  const [body, setBody] = useState(initialBodyHtml);
  const editorRef = useRef<HTMLDivElement>(null);
  /** Nastaví tělo programově (AI výstupy) — do stavu i do DOM editoru. */
  const setBodyHtml = (html: string) => {
    setBody(html);
    if (editorRef.current) editorRef.current.innerHTML = html;
  };
  /** Prostý text těla pro AI operace. */
  const plainBody = () => {
    const el = document.createElement('div');
    el.innerHTML = body;
    return el.innerText.trim();
  };
  const [attachments, setAttachments] = useState<string[]>(p.init.attachmentPaths ?? []);
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const phone = useIsPhone();
  // Šest nástrojů se do lišty na telefonu nevejde — schovají se za jedno tlačítko
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Panel s překladem — na telefonu je řádek s výběrem jazyka trvale v cestě */
  const [translateOpen, setTranslateOpen] = useState(false);
  /**
   * Hlavička (komu, předmět, podepsán) rozbalená?
   *
   * U nové zprávy je potřeba hned — není co jiného vyplňovat. U odpovědi je
   * všechno předvyplněné, takže na telefonu stačí jeden řádek se souhrnem
   * a zbytek obrazovky patří textu. Klepnutím se rozbalí.
   */
  const [headOpen, setHeadOpen] = useState(p.init.mode === 'new');
  /** Podpis na telefonu: ukazuje se na vyžádání, ne pořád (a hlavně celý) */
  const [sigOpen, setSigOpen] = useState(false);
  const [sendAt, setSendAt] = useState('');
  const [translateOut, setTranslateOut] = useState(false);
  const [targetLang, setTargetLang] = useState('');

  // Jazyk e-mailu (řídí produktové odkazy CZ/SK/EN a jazyk AI odpovědí)
  const [mailLang, setMailLang] = useState<MailLang>(
    p.init.originalLang === 'sk' ? 'sk' : p.init.originalLang === 'en' ? 'en' : 'cz'
  );

  // Produkty — prohlížeč katalogu a košík vybraných položek (drží se i po zavření modalu)
  const [browserOpen, setBrowserOpen] = useState(false);
  const [basket, setBasket] = useState<ProductHit[]>([]);
  const [cardStyle, setCardStyle] = useState<ProductCardStyle>('card');
  /** Poslední známá pozice kurzoru v editoru — produkt se vloží přesně tam */
  const savedRange = useRef<Range | null>(null);

  // Velikost okna kompozeru — uživatel si ji roztáhne a aplikace si ji pamatuje
  const composerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    try {
      const raw = localStorage.getItem(COMPOSER_SIZE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return v && v.w > 0 && v.h > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const [maximized, setMaximized] = useState(false);

  /**
   * Tažení za pravý dolní roh. Okno je vycentrované, takže při posunu myši o dx
   * naroste na obě strany — šířka se proto mění o dvojnásobek a roh drží pod kurzorem.
   */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = composerRef.current;
    if (!el) return;
    setMaximized(false);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;
    let last = { w: startW, h: startH };
    const move = (ev: MouseEvent) => {
      last = {
        w: Math.round(Math.max(MIN_COMPOSER.w, Math.min(window.innerWidth * 0.98, startW + (ev.clientX - startX) * 2))),
        h: Math.round(Math.max(MIN_COMPOSER.h, Math.min(window.innerHeight * 0.96, startH + (ev.clientY - startY) * 2)))
      };
      setSize(last);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      try { localStorage.setItem(COMPOSER_SIZE_KEY, JSON.stringify(last)); } catch { /* bez zapamatování */ }
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  /** Dvojklik na roh vrátí výchozí velikost. */
  const resetSize = () => {
    setSize(null);
    setMaximized(false);
    try { localStorage.removeItem(COMPOSER_SIZE_KEY); } catch { /* nevadí */ }
  };

  const composerStyle: React.CSSProperties = maximized
    ? { width: '98vw', height: '96vh', maxWidth: '98vw', maxHeight: '96vh' }
    : size
      ? { width: size.w, height: size.h, maxWidth: '98vw', maxHeight: '96vh' }
      : {};

  // Osoby a podpis
  const [persons, setPersons] = useState<Person[]>([]);
  const [personId, setPersonId] = useState<number>(0);
  const [sigHtml, setSigHtml] = useState('');
  const [sigEdit, setSigEdit] = useState(false);
  const [sigPreview, setSigPreview] = useState('');

  const account = useMemo(() => p.accounts.find(a => a.id === accountId), [p.accounts, accountId]);
  const person = useMemo(() => persons.find(x => x.id === personId) ?? null, [persons, personId]);

  /** Zobrazované jméno odesílatele — dle podepsané osoby a jazyka mailu (např. „Petra z Quentino"). */
  const senderName = useMemo(() => {
    if (!person) return account?.name ?? '';
    const explicit = person.displayNames[mailLang] || person.displayNames.cz;
    if (explicit) return explicit;
    const first = person.name.split(' ')[0];
    const brand = account?.sigConfig?.names?.[mailLang] || account?.sigConfig?.names?.cz || account?.name || 'Quentino';
    return mailLang === 'en' ? `${first} from ${brand}` : `${first} z ${brand}`;
  }, [person, mailLang, account]);
  const foreignLang = p.init.originalLang && !['cs', 'sk', ''].includes(p.init.originalLang) ? p.init.originalLang : null;

  // Osoby + výchozí osoba z nastavení
  useEffect(() => {
    (async () => {
      try {
        const [list, settings] = await Promise.all([api.persons.list(), api.settings.get()]);
        setPersons(list);
        if (settings.defaultPersonId && list.some(x => x.id === settings.defaultPersonId)) {
          setPersonId(settings.defaultPersonId);
        }
      } catch { /* */ }
    })();
  }, []);

  /** Uloží aktuální výběr v editoru, aby přežil otevření modalu s produkty. */
  const rememberCaret = () => {
    const ed = editorRef.current;
    const sel = window.getSelection();
    if (!ed || !sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (ed.contains(r.commonAncestorContainer)) savedRange.current = r.cloneRange();
  };

  /**
   * Vloží produktové bloky do textu za odstavec, ve kterém stojí kurzor.
   * Za každý blok se přidá prázdný odstavec, aby šlo mezi produkty rovnou psát.
   */
  const insertProducts = (list: ProductHit[], style: ProductCardStyle) => {
    const ed = editorRef.current;
    if (!ed || list.length === 0) return;

    const html = list
      .map(pr => `${productBlockForEditor(pr, mailLang, account?.color ?? '#7c5cff', style)}<p><br></p>`)
      .join('');

    // Blok nejvyšší úrovně, ve kterém je kurzor — za něj se vloží karta
    let anchor: Node | null = null;
    const r = savedRange.current;
    if (r && ed.contains(r.commonAncestorContainer)) {
      let n: Node | null = r.startContainer;
      while (n && n.parentNode && n.parentNode !== ed) n = n.parentNode;
      if (n && n.parentNode === ed) anchor = n;
    }

    const holder = document.createElement('div');
    holder.innerHTML = html;
    const nodes = Array.from(holder.childNodes);
    let ref: Node | null = anchor;
    for (const node of nodes) {
      if (ref) { ed.insertBefore(node, ref.nextSibling); ref = node; }
      else ed.appendChild(node);
    }

    // Kurzor do prázdného odstavce za poslední kartou
    const last = nodes[nodes.length - 1];
    if (last && last.nodeType === 1) {
      const range = document.createRange();
      range.setStart(last, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      savedRange.current = range.cloneRange();
      ed.focus();
    }

    setBody(ed.innerHTML);
    toast(list.length === 1 ? 'Produkt vložen do textu.' : `${list.length} produktů vloženo do textu.`);
  };

  /** Přepnutí jazyka e-mailu — nabídne překlad rozepsaného textu. */
  const switchLang = async (lang: MailLang) => {
    if (lang === mailLang) return;
    const prev = mailLang;
    setMailLang(lang);
    if (plainBody().length > 20) {
      const iso = MAIL_LANGS.find(l => l.code === lang)!.iso;
      const label = MAIL_LANGS.find(l => l.code === lang)!.label;
      if (confirm(`Přeložit rozepsaný text do jazyka ${label}? (Zrušit = ponechat původní text)`)) {
        setBusy('langswitch');
        try {
          setBodyHtml(textToHtml(await api.ai.translateText(plainBody(), iso)));
          toast(`Text přeložen (${label}).`);
        } catch (e: any) {
          toast(e.message, 'error');
          setMailLang(prev);
        } finally {
          setBusy(null);
        }
      }
    }
  };

  // Výchozí podpis = blok osoby (dle jazyka) + podpis značky v jazyce mailu
  // (slogan, doména quentino.cz/sk/wearquentino.com, e-mail, telefon); CID bez zdroje se odstraní
  useEffect(() => {
    const accent = account?.color ?? '#7c5cff';
    const base = account?.sigConfig?.names?.cz
      ? buildBrandSignature(account.sigConfig, mailLang, accent, !!account.logoPath)
      : account?.signatureHtml ?? '';
    const combined = person ? `${personBlock(person, mailLang, accent)}${base}` : base;
    setSigHtml(stripMissingCids(combined, !!account?.logoPath, !!person?.photoPath));
  }, [account, person, mailLang]);

  // Náhled podpisu: CID obrázky nahradíme data-URI
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let html = sigHtml;
      try {
        if (account?.logoPath && html.includes('cid:sig-logo')) {
          html = html.split('cid:sig-logo').join(await api.files.readAsDataUrl(account.logoPath));
        }
        if (person?.photoPath && html.includes('cid:sig-person')) {
          html = html.split('cid:sig-person').join(await api.files.readAsDataUrl(person.photoPath));
        }
      } catch { /* náhled bez obrázku */ }
      if (!cancelled) setSigPreview(html);
    })();
    return () => { cancelled = true; };
  }, [sigHtml, account, person]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };

  const generateReply = () => run('gen', async () => {
    if (!p.init.replyToDbId) return;
    const text = await api.ai.reply({
      messageDbId: p.init.replyToDbId,
      note: aiNote,
      language: MAIL_LANGS.find(l => l.code === mailLang)!.iso
    });
    setBodyHtml(textToHtml(text));
  });

  const improve = (mode: 'improve' | 'grammar') => run(mode, async () => {
    const text = plainBody();
    if (!text) { toast('Nejdřív něco napiš.'); return; }
    setBodyHtml(textToHtml(await api.ai.improve(text, mode)));
  });

  const translateBody = () => run('translate', async () => {
    if (!targetLang) { toast('Vyber cílový jazyk.'); return; }
    const text = plainBody();
    if (!text) { toast('Nejdřív něco napiš.'); return; }
    setBodyHtml(textToHtml(await api.ai.translateText(text, targetLang)));
    toast(`Přeloženo (${targetLang}).`);
  });

  /** Obrázky vložené do editoru (data URI) převede na CID přílohy — spolehlivé u všech příjemců. */
  const withEditorImages = async (html: string): Promise<{ html: string; images: { cid: string; path: string }[] }> => {
    const images: { cid: string; path: string }[] = [];
    const re = /src="data:image\/([a-z+]+);base64,([^"]+)"/gi;
    let out = html;
    let m: RegExpExecArray | null;
    let i = 0;
    const done = new Set<string>();
    while ((m = re.exec(html))) {
      if (done.has(m[0])) continue;
      done.add(m[0]);
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1].replace('+xml', '');
      const cid = `img-${Date.now()}-${i++}`;
      try {
        const filePath = await api.files.saveTempImage(`${cid}.${ext}`, m[2]);
        images.push({ cid, path: filePath });
        out = out.split(m[0]).join(`src="cid:${cid}"`);
      } catch { /* obrázek zůstane jako data URI */ }
    }
    return { html: out, images };
  };

  const buildDraft = async (): Promise<ComposeDraft> => {
    const quoted =
      p.init.mode === 'reply' && p.init.quotedText
        ? `<blockquote style="border-left:3px solid #ccc;margin:12px 0 0;padding:6px 12px;color:#666">${escapeHtml(p.init.quotedText).replace(/\n/g, '<br>')}</blockquote>`
        : '';
    const sig = sigHtml ? `<div style="margin-top:16px">${sigHtml}</div>` : '';
    const bodyProcessed = await withEditorImages(cleanEditorHtml(body));
    const inlineImages = [...bodyProcessed.images];
    if (account?.logoPath && sigHtml.includes('cid:sig-logo')) inlineImages.push({ cid: 'sig-logo', path: account.logoPath });
    if (person?.photoPath && sigHtml.includes('cid:sig-person')) inlineImages.push({ cid: 'sig-person', path: person.photoPath });
    return {
      accountId,
      to, cc, bcc,
      subject,
      // max-width + text-size-adjust: aby zpráva vypadala stejně na mobilu i na desktopu
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;max-width:640px;word-break:normal;overflow-wrap:break-word;-webkit-text-size-adjust:100%">${bodyProcessed.html}${sig}${quoted}</div>`,
      attachmentPaths: attachments,
      inlineImages,
      inReplyTo: p.init.inReplyTo,
      references: p.init.references,
      replyToDbId: p.init.replyToDbId ?? null,
      translateTo: translateOut && foreignLang ? foreignLang : null,
      sendAt: scheduleOpen && sendAt ? new Date(sendAt).toISOString() : null,
      fromName: person ? senderName : null
    };
  };

  /** Stav kompozeru pro obnovení po „Zpět". */
  const reopenInit = (): ComposerInit => ({
    mode: p.init.mode,
    accountId,
    to, cc, bcc,
    subject,
    inReplyTo: p.init.inReplyTo,
    references: p.init.references,
    replyToDbId: p.init.replyToDbId,
    quotedText: p.init.quotedText,
    attachmentPaths: attachments,
    originalLang: p.init.originalLang,
    body
  });

  const send = () => run('send', async () => {
    if (!to.trim()) { toast('Vyplň příjemce.', 'error'); return; }
    const draft = await buildDraft();
    if (draft.sendAt) {
      await api.send.schedule(draft);
      toast(`Odeslání naplánováno na ${new Date(draft.sendAt).toLocaleString('cs-CZ')}.`);
      p.onSent();
    } else {
      // Undo send: zpráva se zařadí s 11s odkladem, mezitím jde vzít zpět
      const outboxId = await api.send.schedule({ ...draft, sendAt: new Date(Date.now() + 11_000).toISOString() });
      p.onSent({ outboxId, reopen: reopenInit() });
    }
  });

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      {voucherOpen && (
        <VoucherDialog
          recipient={to}
          lang={mailLang}
          onClose={() => setVoucherOpen(false)}
          onCreated={files => setAttachments(prev => [...prev, ...files])}
        />
      )}
      {browserOpen && (
        <ProductBrowser
          lang={mailLang}
          accent={account?.color ?? '#7c5cff'}
          initialSelected={basket}
          initialStyle={cardStyle}
          onClose={() => setBrowserOpen(false)}
          onSelectionChange={(list, style) => { setBasket(list); setCardStyle(style); }}
          onInsert={(list, style) => {
            insertProducts(list, style);
            setBrowserOpen(false);
          }}
        />
      )}
      <div className="composer" ref={composerRef} style={composerStyle}>
        <div className="composer-head">
          <span>{p.init.mode === 'reply' ? 'Odpověď' : p.init.mode === 'forward' ? 'Přeposlat' : 'Nová zpráva'}</span>
          <div className="composer-head-tools" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {/* Velikost okna se mění jen na počítači — na telefonu je zpráva vždy přes celou obrazovku */}
            {!phone && (size || maximized) && (
              <button className="icon-btn" data-tip="Vrátit výchozí velikost okna" onClick={resetSize}>
                <Icon name="refresh" size={14} />
              </button>
            )}
            {!phone && (
              <button className="icon-btn"
                data-tip={maximized ? 'Zmenšit okno' : 'Roztáhnout okno přes celou plochu'}
                onClick={() => setMaximized(v => !v)}>
                <Icon name="expand" size={14} style={maximized ? { transform: 'rotate(180deg)' } : undefined} />
              </button>
            )}
            <button className="icon-btn" data-tip="Zavřít bez odeslání" onClick={p.onClose}><Icon name="x" size={15} /></button>
          </div>
        </div>

        <div className="composer-body">
          {/* Na telefonu zabírala hlavička třetinu obrazovky, i když u odpovědi
              není co měnit. Sbalená drží to podstatné na očích — komu to jde
              a v jakém jazyce — a text má konečně místo. */}
          {phone && !headOpen && (
            <button className="compose-summary" onClick={() => setHeadOpen(true)}>
              <span className="compose-summary-lines">
                <span><b>Komu</b> {to || 'nikomu zatím'}</span>
                <span className="compose-summary-subject">{subject || 'bez předmětu'}</span>
              </span>
              <span className="compose-summary-lang">{mailLang.toUpperCase()}</span>
              <Icon name="chevDown" size={15} />
            </button>
          )}
          {(!phone || headOpen) && (<>
          {p.accounts.length > 1 && (
            <div className="compose-row">
              <label>Od</label>
              <select value={accountId} onChange={e => setAccountId(Number(e.target.value))}>
                {p.accounts.map(a => <option key={a.id} value={a.id}>{a.name} — {a.email}</option>)}
              </select>
            </div>
          )}
          <div className="compose-row">
            <label>Komu</label>
            <AddressInput value={to} onChange={setTo} placeholder="prijemce@example.com" />
            <button className="btn ghost" style={{ padding: '6px 10px' }} onClick={() => setShowCc(v => !v)}>Cc/Bcc</button>
          </div>
          {showCc && (
            <>
              <div className="compose-row"><label>Cc</label><AddressInput value={cc} onChange={setCc} /></div>
              <div className="compose-row"><label>Bcc</label><AddressInput value={bcc} onChange={setBcc} /></div>
            </>
          )}
          <div className="compose-row">
            <label>Předmět</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} />
            <div className="lang-switch" data-tip="Jazyk e-mailu — řídí produktové odkazy (CZ/SK/EN) a jazyk AI odpovědí">
              {MAIL_LANGS.map(l => (
                <button key={l.code}
                  className={`lang-btn ${mailLang === l.code ? 'active' : ''}`}
                  disabled={busy === 'langswitch'}
                  onClick={() => switchLang(l.code)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          {persons.length > 0 && (
            <div className="compose-row">
              <label>Podepsán</label>
              <select value={personId} onChange={e => setPersonId(Number(e.target.value))}>
                <option value={0}>— bez osoby (jen podpis značky) —</option>
                {persons.map(x => {
                  const pos = x.positions[mailLang] || x.positions.cz;
                  return <option key={x.id} value={x.id}>{x.name}{pos ? ` · ${pos}` : ''}</option>;
                })}
              </select>
              <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: phone ? 'normal' : 'nowrap' }}>
                odesílatel: <b style={{ color: 'var(--text-2)' }}>{senderName}</b>
              </span>
            </div>
          )}

          {phone && (
            <button className="compose-collapse" onClick={() => setHeadOpen(false)}>
              <Icon name="chevDown" size={14} /> Sbalit hlavičku
            </button>
          )}
          </>)}

          {p.init.mode === 'reply' && (
            <div className="ai-note-box">
              <div className="hint"><Icon name="sparkles" size={13} /> Napiš jen stručně, co chceš sdělit — AI z toho vytvoří slušnou odpověď v duchu Quentina.</div>
              <div className="ai-note-row">
                <input
                  value={aiNote}
                  onChange={e => setAiNote(e.target.value)}
                  placeholder='např. „ok, pošleme zítra, omluva za zpoždění"'
                  onKeyDown={e => { if (e.key === 'Enter') generateReply(); }}
                />
                <button className="btn primary" disabled={busy === 'gen'} onClick={generateReply}>
                  {busy === 'gen' ? <span className="spinner-inline" /> : 'Vygenerovat odpověď'}
                </button>
              </div>
            </div>
          )}

          <RichEditor
            initialHtml={initialBodyHtml}
            onChange={setBody}
            editorRef={editorRef}
            onCaret={rememberCaret}
            onInsertProduct={() => setBrowserOpen(true)}
          />

          {/* Na telefonu se podpis dřív ukazoval pořád a ještě uříznutý v půlce
              — vlastní rolování uvnitř rolující stránky. Teď je z něj jeden
              řádek, a když se rozbalí, je vidět celý. */}
          {sigPreview && !sigEdit && phone && (
            <div className="sig-row">
              <Icon name="pen" size={13} />
              <span>Podpis se přidá při odeslání</span>
              <button className="linkish" onClick={() => setSigOpen(v => !v)}>
                {sigOpen ? 'Skrýt' : 'Zobrazit'}
              </button>
              <button className="linkish" onClick={() => setSigEdit(true)}>Upravit</button>
            </div>
          )}
          {sigPreview && !sigEdit && (!phone || sigOpen) && (
            <div className="signature-preview" style={{ position: 'relative' }}>
              <div dangerouslySetInnerHTML={{ __html: sigPreview }} />
              {!phone && (
                <button className="btn ghost" style={{ position: 'absolute', top: 4, right: 4, padding: '3px 9px', fontSize: 12 }}
                  onClick={() => setSigEdit(true)}>
                  <Icon name="pen" size={12} /> Upravit podpis
                </button>
              )}
            </div>
          )}
          {sigEdit && (
            <div className="field">
              <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>Podpis pro tuto zprávu (HTML)</label>
              <textarea rows={5} value={sigHtml} onChange={e => setSigHtml(e.target.value)} />
              <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSigEdit(false)}>Hotovo</button>
            </div>
          )}

          {basket.length > 0 && (
            <div className="basket-strip">
              <Icon name="layers" size={13} />
              <span>Ve výběru {basket.length} {basket.length === 1 ? 'produkt' : basket.length < 5 ? 'produkty' : 'produktů'}</span>
              <button className="linkish" onClick={() => { rememberCaret(); setBrowserOpen(true); }}>Otevřít prohlížeč</button>
              <button className="linkish" onClick={() => insertProducts(basket, cardStyle)}>Vložit do textu</button>
              <button className="linkish danger" onClick={() => setBasket([])}>Zrušit výběr</button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="attachments-row" style={{ borderTop: 'none', padding: 0 }}>
              {/* Klik otevře přílohu k prohlédnutí, křížek ji odebere — u poukazů
                  je kontrola před odesláním to hlavní, co člověk potřebuje */}
              {attachments.map(a => (
                <span key={a} className="attachment-chip">
                  <button className="att-open" data-tip="Otevřít a zkontrolovat"
                    onClick={() => api.files.openAttachment(a).catch((e: any) => toast(e.message, 'error'))}>
                    <Icon name="paperclip" size={13} /> {a.split(/[/\\]/).pop()}
                  </button>
                  <button className="att-remove" data-tip="Odebrat přílohu"
                    onClick={() => setAttachments(prev => prev.filter(x => x !== a))}>
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {!phone && (
          <div className="compose-row compose-translate" style={{ gap: 8 }}>
            <label style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="globe" size={14} /> Přeložit do
            </label>
            <select value={targetLang} onChange={e => setTargetLang(e.target.value)}
              style={phone ? { flex: 1, minWidth: 0 } : { flex: 'none', width: 170 }}>
              <option value="">— vyber jazyk —</option>
              {LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <button className="btn ghost" disabled={busy === 'translate'} onClick={translateBody}>
              {busy === 'translate' ? <span className="spinner-inline" /> : 'Přeložit text'}
            </button>
          </div>
          )}

          {foreignLang && (
            <label className="check-row">
              <input type="checkbox" checked={translateOut} onChange={e => setTranslateOut(e.target.checked)} />
              Před odesláním automaticky přeložit do jazyka příjemce ({foreignLang})
            </label>
          )}

          {scheduleOpen && (
            <div className="schedule-box">
              <Icon name="clock" size={14} /> Odeslat:
              <input type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} />
              <button className="btn ghost" onClick={() => { setScheduleOpen(false); setSendAt(''); }}>Zrušit plán</button>
            </div>
          )}
        </div>

        <div className="composer-foot">
          {phone && (
            <button className="btn ghost" onClick={() => setToolsOpen(true)}>
              <Icon name="sliders" size={14} /> Nástroje{basket.length > 0 ? ` (${basket.length})` : ''}
            </button>
          )}
          <div className="ai-tools">
            <button className="toolbar-btn ai" disabled={busy === 'improve'} onClick={() => improve('improve')}>
              {busy === 'improve' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />} Vylepšit
            </button>
            <button className="toolbar-btn ai" disabled={busy === 'grammar'} onClick={() => improve('grammar')}>
              {busy === 'grammar' ? <span className="spinner-inline" /> : <Icon name="check" size={14} />} Gramatika
            </button>
            <button className="toolbar-btn" data-tip="Procházet katalog a vložit produkty do textu"
              onClick={() => { rememberCaret(); setBrowserOpen(true); }}>
              <Icon name="bag" size={14} /> Produkty{basket.length > 0 ? ` (${basket.length})` : ''}
            </button>
            <button className="toolbar-btn" onClick={() => setVoucherOpen(true)}
              data-tip="Vytvořit dárkový poukaz a přiložit ho jako PDF">
              <Icon name="card" size={14} /> Poukaz
            </button>
            <button className="toolbar-btn" onClick={() => api.files.pickAttachments().then(ps => setAttachments(prev => [...prev, ...ps]))}>
              <Icon name="paperclip" size={14} /> Příloha
            </button>
            <button className="toolbar-btn" onClick={() => setScheduleOpen(v => !v)}>
              <Icon name="clock" size={14} /> Naplánovat
            </button>
          </div>
          <span className="toolbar-spacer" />
          <button className="btn ghost" onClick={p.onClose}>Zavřít</button>
          <button className="btn primary" disabled={busy === 'send'} onClick={send}>
            {busy === 'send' ? <span className="spinner-inline" /> : scheduleOpen && sendAt ? 'Naplánovat odeslání' : 'Odeslat'}
          </button>
        </div>

        {toolsOpen && (
          <Sheet title="Nástroje" onClose={() => setToolsOpen(false)}>
            <SheetActions
              onDone={() => setToolsOpen(false)}
              actions={[
                { icon: 'sparkles', label: 'Vylepšit text', hint: 'AI uhladí formulace podle značky',
                  busy: busy === 'improve', onClick: () => improve('improve') },
                { icon: 'check', label: 'Opravit gramatiku', busy: busy === 'grammar',
                  onClick: () => improve('grammar') },
                { icon: 'bag', label: basket.length > 0 ? `Produkty (${basket.length})` : 'Vložit produkty',
                  onClick: () => { rememberCaret(); setBrowserOpen(true); } },
                { icon: 'card', label: 'Dárkový poukaz', hint: 'Vytvoří PDF a přiloží ho',
                  onClick: () => setVoucherOpen(true) },
                { icon: 'paperclip', label: 'Přidat přílohu',
                  onClick: () => { api.files.pickAttachments().then(ps => setAttachments(prev => [...prev, ...ps])); } },
                { icon: 'globe', label: 'Přeložit text', hint: 'Přepíše rozepsanou zprávu do jiného jazyka',
                  onClick: () => setTranslateOpen(true) },
                { icon: 'clock', label: scheduleOpen ? 'Zrušit plán odeslání' : 'Naplánovat odeslání',
                  active: scheduleOpen, onClick: () => setScheduleOpen(v => !v) }
              ]}
            />
          </Sheet>
        )}

        {/* Překlad měl na telefonu vlastní řádek pod textem a držel si místo
            i ve chvílích, kdy se nepřekládá — což je skoro pořád */}
        {translateOpen && (
          <Sheet title="Přeložit text" onClose={() => setTranslateOpen(false)}>
            <div className="field">
              <label>Do jazyka</label>
              <select value={targetLang} onChange={e => setTargetLang(e.target.value)}>
                <option value="">— vyber jazyk —</option>
                {LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
              <span className="desc">Přepíše se rozepsaný text, podpis zůstane.</span>
            </div>
            <button className="btn primary" style={{ width: '100%' }}
              disabled={!targetLang || busy === 'translate'}
              onClick={async () => { await translateBody(); setTranslateOpen(false); }}>
              {busy === 'translate' ? <span className="spinner-inline" /> : 'Přeložit'}
            </button>
          </Sheet>
        )}

        <div className="composer-grip"
          onMouseDown={startResize}
          onDoubleClick={resetSize}
          data-tip="Táhni pro změnu velikosti, dvojklik vrátí výchozí" />
      </div>
    </div>
  );
}
