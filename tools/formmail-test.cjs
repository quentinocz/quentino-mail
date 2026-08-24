/**
 * Komu se odpoví u zpráv z formuláře na webu.
 *
 * E-shop posílá dotazy ze své adresy, takže „odpovědět odesílateli" skončí
 * u poskytovatele e-shopu. Tahle zkouška hlídá, že se skutečná adresa
 * zákazníka najde v textu — a hlavně že se **nenajde** tam, kde by to byl
 * omyl (adresa e-shopu v patičce, odkaz na produkt, běžná zpráva).
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/formmail-test.cjs
 */
const path = require('path');
const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
const form = require(path.join(DIST, 'formmail.js'));

/** Skutečná zpráva z Upgates, jen s vymyšlenými údaji. */
const RYCHLY_KONTAKT = `Eshop: www.quentino.cz
Stránka: https://www.quentino.cz/p/svetle-modry-pansky-motylek-matny
Email: tuckovaterez@gmail.com
Čas: 22.08.2026 10:36:28
------------------------------------------------------------------

Formulář: Rychlý kontakt

Mám zájem o 1 ks produktu níže.
Pro rychlejší komunikaci můžete napsat i své telefonní číslo: 733573771


https://www.quentino.cz/p/svetle-modry-pansky-motylek-matny`;

const CASES = [
  {
    name: 'rychlý kontakt z Upgates',
    message: { fromAddr: 'system@upgates.com', subject: 'Rychlý kontakt - www.quentino.cz', bodyText: RYCHLY_KONTAKT },
    email: 'tuckovaterez@gmail.com',
    phone: '+420733573771',
    source: 'formulář'
  },
  {
    name: 'formulář bez telefonu',
    message: {
      fromAddr: 'noreply@upgates.com', subject: 'Dotaz na produkt',
      bodyText: 'Formulář: Dotaz\nJméno: Jan Novák\nEmail: jan.novak@seznam.cz\nDotaz: Máte to skladem?'
    },
    email: 'jan.novak@seznam.cz',
    phone: '',
    name_: 'Jan Novák',
    source: 'formulář'
  },
  {
    name: 'formulář v HTML',
    message: {
      fromAddr: 'system@upgates.com', subject: 'Kontakt',
      bodyHtml: '<table><tr><td><b>Email:</b></td><td>petra@example.cz</td></tr>'
        + '<tr><td><b>Telefon:</b></td><td>+420 605 112 233</td></tr></table>'
    },
    email: 'petra@example.cz',
    phone: '+420605112233',
    source: 'formulář'
  },
  {
    name: 'telefon s předvolbou bez plus',
    message: {
      fromAddr: 'system@upgates.com', subject: 'Kontakt',
      bodyText: 'Email: karel@example.cz\nTelefon: 420733573771'
    },
    email: 'karel@example.cz',
    phone: '+420733573771',
    source: 'formulář'
  },
  {
    name: 'běžná zpráva od zákazníka — nesahat na ni',
    message: { fromAddr: 'zakaznik@seznam.cz', subject: 'Dotaz', bodyText: 'Dobrý den, kdy dorazí zásilka?' },
    email: 'zakaznik@seznam.cz',
    source: 'odesílatel'
  },
  {
    name: 'Reply-To má přednost před textem',
    message: {
      fromAddr: 'system@upgates.com', replyTo: 'kontakt@example.cz',
      subject: 'Kontakt', bodyText: RYCHLY_KONTAKT
    },
    email: 'kontakt@example.cz',
    source: 'reply-to'
  },
  {
    name: 'zpráva od e-shopu bez popisky s adresou',
    message: {
      fromAddr: 'system@upgates.com', subject: 'Upozornění',
      bodyText: 'Dobrý den, váš e-shop www.quentino.cz má nové sdělení.\nOdkaz: https://admin.upgates.com'
    },
    email: 'system@upgates.com',
    source: 'odesílatel'
  },
  {
    name: 'adresa e-shopu v popisce se nesmí vzít jako zákazník',
    message: {
      fromAddr: 'system@upgates.com', subject: 'Kontakt',
      bodyText: 'Email: system@upgates.com\nZpráva: test'
    },
    email: 'system@upgates.com',
    source: 'odesílatel'
  }
];

let bad = 0;
console.log('komu se odpoví:\n');
for (const item of CASES) {
  const target = form.replyAddress(item.message);
  const contact = form.formContact(item.message);
  const phone = contact?.phone ?? '';

  const okEmail = target.address === item.email;
  const okSource = target.source === item.source;
  const okPhone = item.phone === undefined || phone === item.phone;
  const okName = item.name_ === undefined || (contact?.name ?? '') === item.name_;
  const ok = okEmail && okSource && okPhone && okName;
  if (!ok) bad++;

  console.log(`  ${ok ? '✓' : '✗'} ${item.name}`);
  console.log(`        → ${target.address}  (${target.source})${phone ? `  tel. ${phone}` : ''}`);
  if (!okEmail) console.log(`        ✗ čekal adresu ${item.email}`);
  if (!okSource) console.log(`        ✗ čekal zdroj ${item.source}`);
  if (!okPhone) console.log(`        ✗ čekal telefon „${item.phone}"`);
  if (!okName) console.log(`        ✗ čekal jméno „${item.name_}", dostal „${contact?.name ?? ''}"`);
}

console.log(bad ? `\n${bad} případů nesedí` : '\nvšechny případy sedí');
process.exit(bad ? 1 : 0);
