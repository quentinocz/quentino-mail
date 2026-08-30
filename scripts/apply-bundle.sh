#!/bin/sh
# Nasazení balíčku (git bundle) do tohohle repozitáře.
#
# Ruční postup se opakoval tolikrát, že se z něj vyplatilo udělat skript —
# a hlavně proto, že se v něm dvakrát ztratila práce: commit selhal kvůli
# kudrnatým uvozovkám a následný `git reset --hard` zahodil rozdělané změny.
# Skript proto po každém kroku ověřuje, jestli opravdu dopadl, a když ne,
# skončí dřív, než se dá něco pokazit.
#
#   sh scripts/apply-bundle.sh ~/Downloads/nazev.bundle "Popis verze"
#
# Po doběhnutí zbývá jen `git push origin main` a značka.
set -e

BUNDLE="$1"
ZPRAVA="${2:-Nova davka zmen}"

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "Chybí cesta k balíčku. Použití: sh scripts/apply-bundle.sh ~/Downloads/nazev.bundle \"Popis\""
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Pracovní strom není čistý. Nejdřív commitni nebo zahoď rozdělané změny:"
  git status --short
  exit 1
fi

ZALOHA="zaloha-$(git rev-parse --short HEAD)"
git branch -f "$ZALOHA"
echo "· záloha současného stavu ve větvi $ZALOHA"

git fetch "$BUNDLE" HEAD:prichozi-balicek -f
echo "· balíček načten"

# Při konfliktu vyhrává balíček; zbylé rozdíly se pak přebijí natvrdo, protože
# merge umí u některých souborů nechat starou verzi a typecheck to odhalí až
# na konci — to je přesně ta situace, kvůli které vznikl tenhle skript.
git merge -X theirs --no-edit prichozi-balicek
# Po jedné cestě, ne najednou: kdyby některá v balíčku nebyla, `checkout`
# skončí chybou a nepřepíše ani ty ostatní.
for CESTA in src tools scripts ios package.json package-lock.json; do
  git checkout prichozi-balicek -- "$CESTA" 2>/dev/null || true
done
echo "· sloučeno"

# Balíček může přinést novou závislost. Dokud se nedoinstaluje, typecheck
# spadne na „Cannot find module" a vypadá to jako chyba v kódu — přitom
# jen chybí složka v node_modules. Instaluje se proto vždy, když se seznam
# závislostí od minula pohnul.
# Porovnává se se zálohou proti pracovnímu stromu, ne proti HEAD:
# vynucený `checkout` výš přepíše soubory ještě před commitem.
if ! git diff --quiet "$ZALOHA" -- package.json package-lock.json; then
  echo "· přibyla nebo se změnila závislost, instaluji"
  npm install
fi

npm run typecheck

git add -A
if git diff --cached --quiet; then
  echo "· není co commitnout, strom už odpovídá balíčku"
else
  git commit -m "$ZPRAVA"
fi

echo
echo "Hotovo. HEAD je teď:"
git log --oneline -1
echo
echo "Zbývá:  git push origin main   a pak značka, třeba:"
echo "        git tag v4.1.0 && git push origin v4.1.0"
echo "Kdyby něco nesedělo:  git reset --hard $ZALOHA"
