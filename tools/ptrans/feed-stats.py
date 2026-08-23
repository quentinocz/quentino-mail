# Přehled hodnot v Google metaklíčích feedu — podklad pro mapování barev
# a pro rozpoznání setů.  Spouští se ručně:  python3 tools/ptrans/feed-stats.py <feed.xml>
import re, sys, collections

path = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/feed.xml'
x = open(path, encoding='utf8').read()


def meta_values(key, lang='cz'):
    c = collections.Counter()
    pattern = r'<META_KEY>' + key + r'</META_KEY>\s*<META_VALUES>([\s\S]*?)</META_VALUES>'
    for m in re.finditer(pattern, x):
        v = re.search(r'<META_VALUE language="' + lang + r'">([\s\S]*?)</META_VALUE>', m.group(1))
        c[(v.group(1).strip() if v else '')] += 1
    return c


for key in ['is_bundle_google_merchant', 'color_google_merchant', 'gender_google_merchant',
            'identifier_exists_google_merchant', 'yn_google_merchant', 'age_group_google_merchant']:
    print(key + ':')
    for value, n in meta_values(key).most_common(14):
        print('   %-44s %d' % ((value[:42] or '(prazdne)'), n))
    print()

# Hodnoty parametru Barva — z nich se bude odvozovat základní barva pro Google
colors = collections.Counter()
for part in re.finditer(r'<PARAMETER>[\s\S]*?</PARAMETER>', x):
    body = part.group(0)
    if '<NAME language="cz">Barva</NAME>' not in body:
        continue
    v = re.search(r'<VALUE language="cz">([\s\S]*?)</VALUE>', body)
    if v:
        colors[v.group(1).strip()] += 1
print('Parametr Barva — %d různých hodnot:' % len(colors))
for value, n in colors.most_common(40):
    print('   %-44s %d' % (value[:42], n))

# Kolik produktů má v názvu slovo naznačující set
sets = collections.Counter()
for block in re.finditer(r'<PRODUCT>[\s\S]*?</PRODUCT>', x):
    body = block.group(0)
    t = re.search(r'<TITLE language="cz">([\s\S]*?)</TITLE>', body)
    if not t:
        continue
    title = t.group(1).lower()
    for word in ['set', 'sada', ' a ', 'duo', 'balíček']:
        if word in title:
            sets[word] += 1
print('\nNázvy naznačující set:', dict(sets))
