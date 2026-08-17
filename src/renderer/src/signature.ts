import type { SigConfig, MailLang } from '@shared/types';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Text, který se nikdy nesmí zalomit uprostřed — mezery se nahradí pevnými.
 * Bez toho se telefon „+420 606 426 013" na mobilu rozpadne na dva řádky.
 */
function unbreakable(s: string): string {
  return escapeHtml(s.trim()).replace(/\s+/g, '&nbsp;');
}

export const DEFAULT_SIG_CONFIG: SigConfig = {
  phone: '',
  names: {
    cz: 'Quentino',
    sk: 'Quentino',
    en: 'Quentino'
  },
  emails: {
    cz: '',
    sk: '',
    en: ''
  },
  taglines: {
    cz: 'S láskou zabaleno 💛',
    sk: 'S láskou zabalené 💛',
    en: 'Packed with love 💛'
  },
  webs: {
    cz: 'quentino.cz',
    sk: 'quentino.sk',
    en: 'wearquentino.com'
  }
};

/** Oddělovač se lepí na předchozí položku, mezera za ním je jediné místo, kde se řádek smí zalomit. */
const SEP = '<span class="qs-sep" style="color:#d5d0e0">&nbsp;&nbsp;&middot;</span>';

/**
 * Na úzkých displejích se logo přesune nad text a kontakty se rozloží pod sebe; tečky
 * mezi nimi zmizí, jinak by zůstávaly viset na konci řádku. Barevný proužek vlevo drží
 * u obou buněk, takže na mobilu vypadá jako jedna souvislá linka.
 *
 * Klienti, kteří `<style>` ignorují (Outlook na Windows), dostanou jednořádkovou
 * variantu z inline stylů — ta taky nikde nepřeteče.
 */
function sigStyle(accent: string): string {
  return `<style type="text/css">
@media only screen and (max-width:480px){
  .qs-item{display:block !important;}
  .qs-sep{display:none !important;}
  .qs-logo{display:block !important;width:auto !important;padding:0 0 12px 16px !important;border-left:3px solid ${accent} !important;}
  .qs-text{display:block !important;width:auto !important;}
}
</style>`;
}

/**
 * Podpis značky v jazyce e-mailu: slogan, správná doména (quentino.cz / quentino.sk /
 * wearquentino.com), e-mail a telefon. E-mail-safe (tabulka + inline styly), logo přes CID.
 *
 * Layout je záměrně „fluidní": tabulka je 100 % šířky s max-width, sloupec s logem má pevnou
 * šířku a kontaktní řádek se skládá z nezlomitelných kusů, které se přelévají po celých
 * položkách. Díky tomu vypadá podpis stejně na desktopu i na 320px širokém telefonu.
 */
export function buildBrandSignature(cfg: SigConfig, lang: MailLang, accent: string, hasLogo: boolean): string {
  const name = cfg.names[lang] || cfg.names.cz;
  const email = (cfg.emails[lang] || cfg.emails.cz || '').trim();
  const tagline = cfg.taglines[lang] || cfg.taglines.cz;
  const web = (cfg.webs[lang] || cfg.webs.cz || '').trim();
  const webUrl = web ? (web.startsWith('http') ? web : `https://${web}`) : '';

  const items = [
    cfg.phone
      ? `<a href="tel:${cfg.phone.replace(/\s+/g, '')}" style="color:#8a8a8a;text-decoration:none;white-space:nowrap">${unbreakable(cfg.phone)}</a>`
      : '',
    email
      ? `<a href="mailto:${email}" style="color:#8a8a8a;text-decoration:none;white-space:nowrap">${escapeHtml(email)}</a>`
      : '',
    webUrl
      ? `<a href="${webUrl}" style="color:${accent};text-decoration:none;font-weight:bold;white-space:nowrap">${escapeHtml(web.replace(/^https?:\/\//, ''))}</a>`
      : ''
  ].filter(Boolean);

  const bits = items
    .map((html, i) => `<span class="qs-item" style="display:inline-block">${html}${i < items.length - 1 ? SEP : ''}</span>`)
    .join(' ');

  const logoCell = hasLogo
    ? `<td class="qs-logo" width="88" style="width:88px;padding:0 16px 0 0;vertical-align:middle" valign="middle">` +
      `<img src="cid:sig-logo" width="72" style="display:block;width:72px;max-width:72px;height:auto;border:0" alt="${escapeHtml(name)}"></td>`
    : '';

  // Pozor: textová buňka nesmí mít width="100%". Word (Outlook na Windows) z toho
  // spočítá nulovou šířku sousedního sloupce a logo se v podpisu vůbec nevykreslí.
  return `${sigStyle(accent)}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;max-width:480px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#3a3a3a;line-height:1.45">
<tr>${logoCell}<td class="qs-text" style="${hasLogo ? `padding-left:16px;border-left:3px solid ${accent};` : ''}vertical-align:middle;word-break:normal;overflow-wrap:break-word" valign="middle">
<div style="font-weight:bold;font-size:16px;color:${accent};letter-spacing:0.3px;line-height:1.3">${escapeHtml(name)}</div>
${tagline ? `<div style="color:#8a8a8a;font-size:12.5px;padding-top:3px">${escapeHtml(tagline)}</div>` : ''}
${bits ? `<div style="padding-top:9px;font-size:12.5px;line-height:1.75">${bits}</div>` : ''}
</td></tr></table>`;
}
