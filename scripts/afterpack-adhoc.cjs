/**
 * Provizorní („ad-hoc") podpis aplikace pro macOS.
 *
 * Apple Silicon vyžaduje, aby každá arm64 binárka měla platný podpis. Když
 * electron-builder nenajde certifikát, podepisování přeskočí úplně — v jeho
 * `macPackager.js` je to natvrdo:
 *
 *     if (!options.sign && identity == null) { reportError(...); return false }
 *
 * Vznikne tedy aplikace úplně bez podpisu, kterou systém při spuštění ukončí
 * hláškou „je poškozená a nelze ji otevřít". A co je horší, tlačítko „Přesto
 * otevřít" v Nastavení s tím nic nenadělá, protože to není otázka Gatekeeperu.
 *
 * Provizorní podpis (`codesign --sign -`) tohle vyřeší. Nenahrazuje certifikát
 * od Apple: aplikace pořád není notarizovaná, takže když si ji někdo stáhne
 * z internetu, Gatekeeper ho jednou vyzve k potvrzení. Ale spustí se.
 *
 * Záměrně bez `--options runtime`. Hardened runtime má smysl jen pro
 * notarizaci a bez příslušných entitlements by Electronu zakázal JIT.
 *
 * Krok se přeskočí, když jsou k dispozici opravdové certifikáty — v tu chvíli
 * podepíše electron-builder sám, hned po tomhle kroku, a udělá to pořádně.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD) {
    console.log('  • provizorní podpis se přeskakuje, je k dispozici certifikát');
    return;
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
    console.log(`  • aplikace podepsána provizorně (ad-hoc): ${path.basename(app)}`);
  } catch (err) {
    const detail = [err?.stderr, err?.stdout]
      .map(b => (b ? b.toString().trim() : ''))
      .filter(Boolean)
      .join('\n');
    // Radši hlasitě spadnout než vydat instalátor, který se u příjemce neotevře
    throw new Error(
      `Provizorní podpis aplikace selhal.\n${detail || err?.message || err}\n`
      + 'Bez podpisu se aplikace na Apple Silicon nespustí — build proto končí.'
    );
  }
};
