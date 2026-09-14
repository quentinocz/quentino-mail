import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Icon from './Icon';

/**
 * Úprava HTML pole s náhledem.
 *
 * Popisy produktů jsou HTML s inline styly. V holém `textarea` se v nich nedá
 * číst a při ruční opravě se snadno rozbije značka — a rozbitá značka se
 * neprojeví tady, ale až na e-shopu.
 *
 * Editor proto pracuje **nad vykresleným textem** (`contenteditable`), takže
 * se upravuje to, co je vidět, a struktura zůstane, jak byla. Prohlížeč sám
 * hlídá, aby značky zůstaly správně uzavřené — psát vlastní opravář HTML by
 * bylo mnohem víc chyb než užitku.
 *
 * Zdrojový režim zůstává pro případy, kdy je opravdu potřeba sáhnout do kódu.
 * Přepnutí zpátky do náhledu projde HTML prohlížečem, takže se případná
 * rozbitá značka spraví hned a je vidět, co z toho vzniklo.
 */

interface Command {
  id: string;
  icon: string;
  tip: string;
  command: string;
}

const COMMANDS: Command[] = [
  { id: 'bold', icon: 'bold', tip: 'Tučně', command: 'bold' },
  { id: 'italic', icon: 'italic', tip: 'Kurzíva', command: 'italic' },
  { id: 'underline', icon: 'underline', tip: 'Podtrženě', command: 'underline' },
  { id: 'list', icon: 'list', tip: 'Odrážky', command: 'insertUnorderedList' },
  { id: 'eraser', icon: 'eraser', tip: 'Odstranit formátování z výběru', command: 'removeFormat' }
];

/**
 * Co umí editor navenek.
 *
 * Přepis části textu modelem potřebuje vědět, co je označené, a umět to
 * vyměnit. Dělat to porovnáváním řetězců nad HTML nefunguje: výběr je
 * **čistý text**, kdežto v poli je HTML se značkami a entitami, takže se
 * označená věta v jeho zdroji prostě nenajde.
 */
export interface HtmlFieldHandle {
  /** Označený text, nebo prázdno */
  selection(): string;
  /** Vymění označené za nový text. Vrací `false`, když výběr už neplatí. */
  replaceSelection(text: string): boolean;
  /** Text bez značek — kontext pro model */
  plain(): string;
  /**
   * Text okolo výběru.
   *
   * Skládá se ze **stejného výběru**, ne z `innerText`: ten zalamuje a slučuje
   * mezery jinak než `Range.toString()`, takže se označená věta v něm nenašla
   * a přepis končil hláškou „text se v poli nenašel".
   */
  context(): { before: string; selection: string; after: string };
}

const HtmlField = forwardRef<HtmlFieldHandle, {
  value: string;
  onChange: (html: string) => void;
  /** Uložení klávesou Cmd/Ctrl+S */
  onSave?: () => void;
  rows?: number;
  readOnly?: boolean;
  /** Ozve se, když se v poli změní výběr — podle toho se nabízí přepis */
  onSelect?: (text: string) => void;
}>(function HtmlField({ value, onChange, onSave, rows = 12, readOnly, onSelect }, handle) {
  const [mode, setMode] = useState<'rich' | 'source'>('rich');
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  /*
   * Odkaz se dává na označená slova. Bez označení nemá co dělat — a tlačítko,
   * které po kliknutí mlčky nic neudělá, vypadá jako rozbité.
   */
  const [picked, setPicked] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /**
   * Poslední výběr uvnitř pole.
   *
   * Drží se jako `Range`, ne jako text: jakmile se klikne na tlačítko, výběr
   * se v prohlížeči zruší, a než se model ozve, uplyne pár vteřin. Range
   * ukazuje pořád na tatáž místa v textu, takže se dá obnovit.
   */
  const range = useRef<Range | null>(null);
  // Text se do editoru zapisuje jen zvenčí. Kdyby se přepisoval při každém
  // úhozu, kurzor by po každém písmenu skočil na začátek.
  const lastPushed = useRef(value);

  useEffect(() => {
    if (mode !== 'rich' || !box.current) return;
    if (value === lastPushed.current) return;
    box.current.innerHTML = value;
    lastPushed.current = value;
  }, [value, mode]);

  useEffect(() => {
    if (mode === 'rich' && box.current) {
      box.current.innerHTML = value;
      lastPushed.current = value;
    }
    // Jen při přepnutí režimu — jinak by se přepisovalo za běhu psaní
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const publish = useCallback(() => {
    if (!box.current) return;
    lastPushed.current = box.current.innerHTML;
    onChange(box.current.innerHTML);
  }, [onChange]);

  /** Zapamatuje si výběr, dokud je uvnitř tohohle pole. */
  const remember = useCallback(() => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !box.current) return;
    const live = sel.getRangeAt(0);
    if (!box.current.contains(live.commonAncestorContainer)) return;
    range.current = live.cloneRange();
    setPicked(!!sel.toString().trim());
    onSelect?.(sel.toString());
  }, [onSelect]);

  useEffect(() => {
    document.addEventListener('selectionchange', remember);
    return () => document.removeEventListener('selectionchange', remember);
  }, [remember]);

  /** Obnoví zapamatovaný výběr a vrátí, jestli se to povedlo. */
  const restore = useCallback((): boolean => {
    const saved = range.current;
    const el = box.current;
    if (!saved || !el || !el.contains(saved.commonAncestorContainer)) return false;
    el.focus();
    const sel = document.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(saved);
    return true;
  }, []);

  const exec = useCallback((command: string, argument?: string) => {
    restore();
    document.execCommand(command, false, argument);
    publish();
    remember();
  }, [publish, remember, restore]);

  useImperativeHandle(handle, () => ({
    selection: () => range.current?.toString() ?? '',
    plain: () => box.current?.innerText ?? '',
    replaceSelection: (text: string) => {
      if (!restore()) return false;
      document.execCommand('insertText', false, text);
      publish();
      return true;
    },
    context: () => {
      const saved = range.current;
      const el = box.current;
      if (!saved || !el || !el.contains(saved.commonAncestorContainer)) {
        return { before: '', selection: '', after: '' };
      }
      const before = document.createRange();
      before.selectNodeContents(el);
      before.setEnd(saved.startContainer, saved.startOffset);
      const after = document.createRange();
      after.selectNodeContents(el);
      after.setStart(saved.endContainer, saved.endOffset);
      return { before: before.toString(), selection: saved.toString(), after: after.toString() };
    }
  }), [publish, restore]);

  const onInput = () => publish();

  /**
   * Vložení zvenčí vždycky jako čistý text.
   *
   * Zkopírovaný odstavec z prohlížeče s sebou nese cizí styly a třídy, které
   * by se dostaly do e-shopu a rozbily vzhled produktu. Formátování si člověk
   * přidá tlačítky.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    publish();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
    }
  };

  /** Adresa odkazu se ptá vlastním políčkem — `window.prompt` Electron nemá. */
  const openLink = () => {
    const picked = range.current?.toString() ?? '';
    if (!picked.trim()) return;
    const inside = range.current?.commonAncestorContainer;
    const anchor = inside instanceof Element
      ? inside.closest('a')
      : inside?.parentElement?.closest('a');
    setUrl(anchor?.getAttribute('href') ?? '');
    setLinking(true);
  };

  const applyLink = () => {
    const clean = url.trim();
    setLinking(false);
    if (!clean) { exec('unlink'); return; }
    exec('createLink', /^https?:\/\//i.test(clean) ? clean : `https://${clean}`);
  };

  const height = `${Math.max(6, rows) * 22}px`;

  return (
    <div className={`html-field ${readOnly ? 'ro' : ''}`}>
      <div className="html-bar">
        {mode === 'rich' && !readOnly && COMMANDS.map(one => (
          <button key={one.id} className="icon-btn" data-tip={one.tip}
            // Bez tohohle by tlačítko sebralo zaměření a výběr textu by zmizel
            onMouseDown={e => e.preventDefault()}
            onClick={() => exec(one.command)}>
            <Icon name={one.icon} size={14} />
          </button>
        ))}
        {mode === 'rich' && !readOnly && (
          <button className="icon-btn" disabled={!picked}
            data-tip={picked ? 'Odkaz na označených slovech' : 'Nejdřív označ slova, na která odkaz patří'}
            onMouseDown={e => e.preventDefault()} onClick={openLink}>
            <Icon name="link" size={14} />
          </button>
        )}
        <span style={{ flex: 1 }} />
        <div className="ig-seg html-mode">
          <button className={mode === 'rich' ? 'active' : ''} onClick={() => setMode('rich')}>Náhled</button>
          <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>HTML</button>
        </div>
      </div>

      {linking && (
        <div className="html-link">
          <input autoFocus value={url} placeholder="https://www.quentino.cz/…"
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
              if (e.key === 'Escape') { e.preventDefault(); setLinking(false); }
            }} />
          <button className="btn primary" onMouseDown={e => e.preventDefault()} onClick={applyLink}>
            {url.trim() ? 'Vložit' : 'Zrušit odkaz'}
          </button>
          <button className="icon-btn" data-tip="Zavřít" onClick={() => setLinking(false)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {mode === 'rich' ? (
        <div
          ref={box}
          className="html-rich"
          style={{ height }}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          onInput={onInput}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onMouseUp={remember}
          onKeyUp={remember}
        />
      ) : (
        <textarea
          className="html-source"
          style={{ height }}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          onChange={e => { lastPushed.current = e.target.value; onChange(e.target.value); }}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
});

export default HtmlField;
