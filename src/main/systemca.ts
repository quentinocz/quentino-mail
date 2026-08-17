import tls from 'tls';
import { execFileSync } from 'child_process';

/**
 * Node.js si nese vlastní vestavěný seznam kořenových certifikátů a do
 * systémového úložiště se nedívá. Na počítačích, kde HTTPS provoz rozbaluje
 * antivirus („SSL scanning") nebo firemní proxy, přijde certifikát podepsaný
 * jejich vlastní kořenovou autoritou. Ta bývá nainstalovaná v Keychainu macOS,
 * takže Safari i Chrome fungují bez problému, ale IMAP, SMTP a volání API
 * z aplikace spadnou na „unable to verify the first certificate".
 *
 * Proto se při startu poskládají dohromady vestavěné kořeny, kořeny ze
 * systémového úložiště a případné NODE_EXTRA_CA_CERTS a nastaví se jako
 * výchozí pro celý proces. Od té chvíle to platí i pro `fetch`, ImapFlow
 * a nodemailer, které si vlastní `ca` nepředávají.
 */

let caCerts: string[] | undefined;

type CaSource = 'default' | 'system' | 'bundled' | 'extra';

/** Node ≥ 22.15 / 24 umí systémové úložiště přečíst sám. */
function readFromNode(source: CaSource): string[] {
  const read = (tls as unknown as { getCACertificates?: (s?: string) => string[] }).getCACertificates;
  if (typeof read !== 'function') return [];
  try {
    return read(source) ?? [];
  } catch {
    return []; // platforma daný zdroj nezná
  }
}

function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

function securityFind(args: string[]): string[] {
  try {
    const pem = execFileSync('/usr/bin/security', ['find-certificate', '-a', '-p', ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20_000
    });
    return splitPem(pem);
  } catch {
    return []; // keychain nemusí existovat nebo být odemčený
  }
}

/** Záložní cesta pro macOS, kdyby Node systémové úložiště přečíst neuměl. */
function readFromKeychain(): string[] {
  if (process.platform !== 'darwin') return [];
  return [
    ...securityFind(['/System/Library/Keychains/SystemRootCertificates.keychain']),
    ...securityFind(['/Library/Keychains/System.keychain']),
    // kořeny přidané uživatelem — sem si antivirus obvykle uloží ten svůj
    ...securityFind([])
  ];
}

/**
 * Poskládá seznam důvěryhodných kořenů a nastaví ho jako výchozí pro Node TLS.
 * Volá se jednou při startu aplikace, opakované volání už nic nedělá.
 */
export function installSystemCa(): void {
  if (caCerts) return;

  const bundled = readFromNode('bundled');
  if (!bundled.length) bundled.push(...tls.rootCertificates);

  const system = readFromNode('system');
  const extra = readFromNode('extra');
  // Když Node ze systémového úložiště nic nevrátí, zkusíme ho přečíst přes
  // `security`. Vestavěné kořeny přitom zůstávají, ať se nepřijde o důvěru
  // k běžným veřejným certifikátům.
  const keychain = system.length ? [] : readFromKeychain();

  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of [...bundled, ...system, ...extra, ...keychain]) {
    const pem = raw.replace(/\r\n/g, '\n').trim();
    if (!pem || seen.has(pem)) continue;
    seen.add(pem);
    list.push(pem);
  }
  if (!list.length) return; // nic jsme nenašli, necháme Node na jeho výchozím chování

  caCerts = list;

  const setDefault = (tls as unknown as { setDefaultCACertificates?: (c: string[]) => void })
    .setDefaultCACertificates;
  if (typeof setDefault === 'function') {
    try {
      setDefault(list);
    } catch (e) {
      console.error('[systemca] výchozí kořeny se nepodařilo nastavit', e);
    }
  }

  const fromSystem = system.length + keychain.length;
  console.log(`[systemca] důvěryhodných kořenů: ${list.length} (vestavěných ${bundled.length}, systémových ${fromSystem}, z NODE_EXTRA_CA_CERTS ${extra.length})`);
}

/**
 * Kořeny pro knihovny, které si TLS spojení otevírají samy (ImapFlow,
 * nodemailer). `undefined` znamená „nech výchozí chování Node".
 */
export function getCaCertificates(): string[] | undefined {
  return caCerts;
}
