import type { MailLang, ProductHit, ProductCardStyle } from '@shared/types';
import { escapeHtml } from './signature';

export const PRODUCT_BTN_LABEL: Record<MailLang, string> = {
  cz: 'Zobrazit produkt',
  sk: 'Zobraziť produkt',
  en: 'View product'
};

export const CARD_STYLE_LABEL: Record<ProductCardStyle, string> = {
  card: 'Karta s tlačítkem',
  compact: 'Řádek (úsporný)',
  image: 'Velký obrázek'
};

/** Atribut, podle kterého editor pozná vloženou produktovou kartu. */
export const PRODUCT_BLOCK_ATTR = 'data-product-code';

function pick(prod: ProductHit, field: 'title' | 'url' | 'price', lang: MailLang): string {
  return prod[field][lang] || prod[field].cz || prod[field].en || prod[field].sk || '';
}

/**
 * Produktový blok do e-mailu — vše e-mail-safe (tabulka + inline styly) a responzivní:
 * tabulka je 100 % šířky s max-width, takže se na mobilu smrskne, ale nikdy nepřeteče.
 */
export function productCardHtml(
  prod: ProductHit,
  lang: MailLang,
  accent: string,
  style: ProductCardStyle = 'card'
): string {
  const url = pick(prod, 'url', lang);
  const title = escapeHtml(pick(prod, 'title', lang));
  const price = pick(prod, 'price', lang);
  const href = url ? `href="${url}"` : '';

  if (style === 'image') {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;max-width:320px;font-family:Arial,Helvetica,sans-serif;margin:14px 0">
<tr><td style="padding:0 0 10px">${prod.image ? `<a ${href} style="text-decoration:none"><img src="${prod.image}" width="320" style="display:block;width:100%;max-width:320px;height:auto;border:0;border-radius:12px" alt="${title}"></a>` : ''}</td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif"><a ${href} style="font-weight:bold;font-size:15px;color:#222222;text-decoration:none">${title}</a>${price ? `<div style="color:#777777;font-size:13px;padding-top:4px">${escapeHtml(price)}</div>` : ''}</td></tr>
</table>`;
  }

  if (style === 'compact') {
    const thumb = prod.image
      ? `<td width="64" style="width:64px;padding:8px 12px 8px 8px;vertical-align:middle" valign="middle"><a ${href} style="text-decoration:none"><img src="${prod.image}" width="56" style="display:block;width:56px;max-width:56px;height:auto;border:0;border-radius:8px" alt="${title}"></a></td>`
      : '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;max-width:440px;font-family:Arial,Helvetica,sans-serif;margin:8px 0;border:1px solid #e6e2ee;border-radius:10px">
<tr>${thumb}<td style="padding:10px 14px 10px ${prod.image ? '0' : '14px'};vertical-align:middle;word-break:normal;overflow-wrap:break-word" valign="middle">
<a ${href} style="font-weight:bold;font-size:13.5px;color:#222222;text-decoration:none">${title}</a>
${price ? `<div style="color:#777777;font-size:12.5px;padding-top:3px">${escapeHtml(price)}</div>` : ''}
</td></tr></table>`;
  }

  const img = prod.image
    ? `<td width="116" style="width:116px;padding:12px;vertical-align:middle" valign="middle"><a ${href} style="text-decoration:none"><img src="${prod.image}" width="104" style="display:block;width:104px;max-width:104px;height:auto;border:0;border-radius:8px" alt="${title}"></a></td>`
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #e6e2ee;border-radius:12px;font-family:Arial,Helvetica,sans-serif;margin:12px 0;max-width:440px;width:100%"><tr>${img}<td style="padding:14px 16px 14px ${prod.image ? '4px' : '16px'};vertical-align:middle;word-break:normal;overflow-wrap:break-word" valign="middle">
<a ${href} style="font-weight:bold;font-size:14px;color:#222222;text-decoration:none">${title}</a>
${price ? `<div style="color:#777777;font-size:13px;padding:4px 0 10px">${escapeHtml(price)}</div>` : '<div style="padding:5px 0"></div>'}
<a ${href} style="display:inline-block;background:${accent};color:#ffffff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:13px;white-space:nowrap">${PRODUCT_BTN_LABEL[lang]}</a>
</td></tr></table>`;
}

/**
 * Obalí kartu tak, aby se v editoru chovala jako jeden nedělitelný blok
 * (nejde do ní psát, dá se smazat křížkem). Obal se před odesláním odstraní.
 */
export function productBlockForEditor(
  prod: ProductHit,
  lang: MailLang,
  accent: string,
  style: ProductCardStyle
): string {
  return `<div class="ins-product" ${PRODUCT_BLOCK_ATTR}="${escapeHtml(prod.code)}" data-product-style="${style}" contenteditable="false">` +
    `<span class="ins-product-tools" data-editor-only="1" contenteditable="false">` +
    `<button type="button" class="ins-product-del" data-action="remove-product" title="Odebrat produkt">×</button>` +
    `</span>${productCardHtml(prod, lang, accent, style)}</div>`;
}

/**
 * Očistí HTML z editoru pro odeslání: zahodí pomocné ovládací prvky a atributy,
 * které mají smysl jen v aplikaci, a obal karty rozbalí na čistou tabulku.
 * Zároveň dolepí obrázkům max-width, aby nepřetékaly na mobilu.
 */
export function cleanEditorHtml(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;

  root.querySelectorAll('[data-editor-only]').forEach(el => el.remove());

  root.querySelectorAll('.ins-product').forEach(el => {
    const wrap = document.createElement('div');
    wrap.setAttribute('style', 'margin:0');
    while (el.firstChild) wrap.appendChild(el.firstChild);
    el.replaceWith(wrap);
  });

  root.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));

  // Obrázky vložené uživatelem (screenshoty, fotky) na mobilu jinak přetečou
  root.querySelectorAll('img').forEach(img => {
    const style = img.getAttribute('style') ?? '';
    if (!/max-width/i.test(style)) {
      img.setAttribute('style', `${style ? `${style};` : ''}max-width:100%;height:auto`);
    }
  });

  return root.innerHTML;
}
