# Náhledy rozhraní bez zařízení

`preview-phone.mjs` pustí **sestavené** rozhraní v headless Chromiu v rozměrech
iPhonu, proklikne hlavní obrazovky a uloží obrázky do `tools/shots/`. Nativní
most nahrazuje `stub.js`, takže není potřeba ani telefon, ani běžící aplikace.

Vzniklo to poté, co se ukázalo, že kolo „uprav CSS → sestav v CI → nainstaluj
→ vyfoť" trvá dvacet minut a odhalí jednu chybu. Tohle jich najde pět za minutu.

```bash
npm run build:renderer          # musí být čerstvé dist/renderer
npm i -D playwright             # jednorázově
node tools/preview-phone.mjs
```

U každé obrazovky vypíše, jestli je spodní přepínač dostupný, jestli něco
nepřetéká do stran a co překrývá co. Chyby v konzoli hlásí taky.

**Není to náhrada za zkoušku na zařízení** — bezpečné zóny, klávesnice ani
chování WKWebView se takhle neověří. Chytí ale všechno, co je jen o CSS
a rozvržení.
