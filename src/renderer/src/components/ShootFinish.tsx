import { useState } from 'react';
import type { Shoot, ShootPhoto } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/**
 * Konec focení: kde to je a co s tím dál.
 *
 * ## Proč to existuje
 *
 * Focení se ukládá samo — snímek jde rovnou do složky a do seznamu — jenže
 * to na obrazovce nikde nestálo. Bez tlačítka, které řekne „hotovo", se to
 * poznat nedá a člověk hledá „Uložit", které nikde není a být nemusí.
 * Tahle karta je ta odpověď: **ukáže, kam se uložilo, kolik toho je, a co
 * se s tím dá udělat, než se to pošle na web.**
 *
 * ## Proč je tu WebP
 *
 * Kopie ve WebP se dosud dala zapnout jen **předem**, v nastavení focení,
 * a platila od té chvíle dál. Kdo na to zapomněl, měl po focení dvacet
 * JPEGů a žádný způsob, jak je převést — přitom právě po focení je ta
 * chvíle, kdy se řeší, co půjde na e-shop. Převádí se tady, dodatečně,
 * a originály zůstávají: z JPEGu se kopie udělá znovu, z kopie originál
 * nikdy.
 */
export default function ShootFinish({ shoot, photos, onClose, onConvert, onPatch }: {
  shoot: Shoot;
  photos: ShootPhoto[];
  onClose: () => void;
  /**
   * Převod na WebP. Dělá ho okno focení, protože tam je plátno s korekcí
   * barev i kodér; sem se jen hlásí, kolikátá fotka se zrovna převádí.
   */
  onConvert: (quality: number, step: (done: number, total: number) => void) => Promise<number>;
  onPatch: (patch: Partial<Shoot>) => void;
}) {
  const [quality, setQuality] = useState(shoot.webpQuality || 82);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState('');

  const picked = photos.filter(one => one.pick).length;
  /*
   * Převést jde jen to, co umí prohlížeč otevřít. Samotný RAW ne — a
   * slibovat převod čtrnácti fotek, z nichž se čtyři převést nedají,
   * by znamenalo hlásit na konci chybu za něco, co se dalo vědět předem.
   */
  const rawOnly = (one: ShootPhoto) => !one.file || /\.(cr2|cr3|nef|arw|dng|raf|orf|rw2|pef)$/i.test(one.file);
  /*
   * „Má kopii" se pozná podle přípony, ne podle toho, že je pole vyplněné.
   * Sloupec `webp` drží **jakoukoli** kopii vedle originálu — při zapnutém
   * ořezu tam leží i oříznutý JPEG. Bez téhle kontroly by karta u série
   * s ořezem hlásila „všechno už kopii má" a WebP by nevznikl.
   */
  const isWebp = (one: ShootPhoto) => /\.webp$/i.test(one.webp || '');
  const hasWebp = photos.filter(isWebp).length;
  const todo = photos.filter(one => !isWebp(one) && !rawOnly(one)).length;
  const raws = photos.filter(one => rawOnly(one)).length;

  const convert = async () => {
    setBusy(true);
    setResult('');
    setDone(0);
    setTotal(todo);
    try {
      const made = await onConvert(quality, (at, all) => { setDone(at); setTotal(all); });
      setResult(made > 0
        ? `Hotovo — ${made} ${made === 1 ? 'fotka má' : made < 5 ? 'fotky mají' : 'fotek má'} kopii ve WebP.`
        : 'Nebylo co převádět.');
    } catch (e: any) {
      setResult(`Převod se nepovedl: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sh-big" onClick={busy ? undefined : onClose}>
      <div className="sh-finish" onClick={e => e.stopPropagation()}>
        <div className="sh-finish-head">
          <Icon name="check" size={16} />
          <b>Focení „{shoot.name}" je uložené</b>
        </div>
        <div className="sh-finish-note">
          Ukládá se průběžně — každý snímek jde rovnou do složky a do seznamu
          focení. Zavřít okno se dá kdykoli, nic se neztratí.
        </div>

        <div className="sh-finish-rows">
          <div className="sh-finish-row">
            <span>Fotek</span>
            <b>{photos.length}{picked > 0 ? ` · ${picked} vybraných pro e-shop` : ''}</b>
          </div>
          <div className="sh-finish-row">
            <span>Složka</span>
            <b className="sh-folder">{shoot.folder || 'Obrázky ▸ Quentino focení'}</b>
          </div>
          <div className="sh-finish-row">
            <span>Kopie ve WebP</span>
            <b>{hasWebp} z {photos.length}</b>
          </div>
        </div>

        <div className="sh-row">
          <button className="sh-mini" onClick={() => api.shoot.openFolder(shoot.id)}>
            <Icon name="folder" size={12} /> Otevřít složku
          </button>
        </div>

        <div className="sh-finish-head" style={{ marginTop: 14 }}>
          <Icon name="image" size={15} />
          <b>Převést na WebP</b>
        </div>
        <div className="sh-finish-note">
          Menší soubory pro web — obvykle třetina až polovina velikosti JPEGu.
          Kopie vzniká vedle originálu a je v ní i ořez a korekce barev;
          původní soubor se nepřepisuje.
        </div>

        <label className="sh-field">
          <span>Kvalita</span>
          <span className="sh-range">
            <input
              type="range" min={40} max={100} step={1}
              value={quality}
              disabled={busy}
              onChange={e => setQuality(Number(e.target.value))}
            />
            <b>{quality} %</b>
          </span>
        </label>

        <div className="sh-row">
          <button className="sh-go" onClick={convert} disabled={busy || todo === 0}>
            {busy
              ? `Převádím ${done} z ${total}…`
              : todo > 0
                ? `Převést ${todo} ${todo === 1 ? 'fotku' : todo < 5 ? 'fotky' : 'fotek'}`
                : 'Všechno už kopii má'}
          </button>
        </div>
        {raws > 0 && (
          <div className="sh-finish-note">
            {raws} {raws === 1 ? 'snímek je' : 'snímků je'} jen v RAW — ten se tady
            převést nedá, na to je potřeba vyvolat ho v Lightroomu nebo podobně.
          </div>
        )}
        {!!result && <div className="sh-ok">{result}</div>}

        <label className="sh-field sh-field-toggle" style={{ marginTop: 10 }}>
          <span>Dělat kopii rovnou u dalších snímků</span>
          <input
            type="checkbox"
            checked={shoot.webp}
            onChange={e => onPatch({ webp: e.target.checked, webpQuality: quality })}
          />
        </label>

        <div className="sh-finish-foot">
          <button className="sh-mini" onClick={onClose} disabled={busy}>Zavřít</button>
        </div>
      </div>
    </div>
  );
}
