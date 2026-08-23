import { useCallback, useEffect, useRef, useState } from 'react';
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
  run: (exec: (cmd: string, value?: string) => void) => void;
}

const COMMANDS: Command[] = [
  { id: 'bold', icon: 'bold', tip: 'Tučně', run: exec => exec('bold') },
  { id: 'italic', icon: 'italic', tip: 'Kurzíva', run: exec => exec('italic') },
  { id: 'underline', icon: 'underline', tip: 'Podtrženě', run: exec => exec('underline') },
  { id: 'list', icon: 'list', tip: 'Odrážky', run: exec => exec('insertUnorderedList') },
  {
    id: 'link',
    icon: 'link',
    tip: 'Odkaz',
    run: exec => {
      const url = window.prompt('Adresa odkazu');
      if (url) exec('createLink', url);
    }
  },
  { id: 'eraser', icon: 'eraser', tip: 'Odstranit formátování z výběru', run: exec => exec('removeFormat') }
];

export default function HtmlField({ value, onChange, onSave, rows = 12, readOnly }: {
  value: string;
  onChange: (html: string) => void;
  /** Uložení klávesou Cmd/Ctrl+S */
  onSave?: () => void;
  rows?: number;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<'rich' | 'source'>('rich');
  const box = useRef<HTMLDivElement>(null);
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

  const exec = useCallback((command: string, argument?: string) => {
    document.execCommand(command, false, argument);
    if (box.current) {
      lastPushed.current = box.current.innerHTML;
      onChange(box.current.innerHTML);
    }
  }, [onChange]);

  const onInput = () => {
    if (!box.current) return;
    lastPushed.current = box.current.innerHTML;
    onChange(box.current.innerHTML);
  };

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
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
    }
  };

  const height = `${Math.max(6, rows) * 22}px`;

  return (
    <div className={`html-field ${readOnly ? 'ro' : ''}`}>
      <div className="html-bar">
        {mode === 'rich' && !readOnly && COMMANDS.map(command => (
          <button key={command.id} className="icon-btn" data-tip={command.tip}
            // Bez tohohle by tlačítko sebralo zaměření a výběr textu by zmizel
            onMouseDown={e => e.preventDefault()}
            onClick={() => command.run(exec)}>
            <Icon name={command.icon} size={14} />
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <div className="ig-seg html-mode">
          <button className={mode === 'rich' ? 'active' : ''} onClick={() => setMode('rich')}>Náhled</button>
          <button className={mode === 'source' ? 'active' : ''} onClick={() => setMode('source')}>HTML</button>
        </div>
      </div>

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
}
