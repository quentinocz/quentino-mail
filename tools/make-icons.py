# Vygeneruje ikony aplikace ze zdrojového obrázku.
#
# Dvě různá zadání, proto dva výstupy:
#
#  * `build/icon.png` (macOS, Windows) — zaoblený tvar i průhledné rohy zůstávají,
#    electron-builder z toho udělá .icns a .ico.
#
#  * `ios/.../AppIcon-1024.png` — iOS **průhlednost nepovoluje** a rohy si zaobluje
#    sám. Kdyby se tam poslal obrázek s alfa kanálem, App Store ho odmítne, a se
#    zaoblenými rohy by vznikl dvojitý ořez a tmavý lem. Rohy se proto dolijí
#    stejným přechodem, jaký má zdroj — sáhne se pro barvy na jeho okraje, takže
#    to navazuje a nikde není vidět šev.
#
#   python3 tools/make-icons.py <zdroj.png>
import sys
from PIL import Image

src_path = sys.argv[1] if len(sys.argv) > 1 else 'letter-q.png'
src = Image.open(src_path).convert('RGBA')
side = max(src.size)
if src.size[0] != src.size[1]:
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(src, ((side - src.size[0]) // 2, (side - src.size[1]) // 2))
    src = square

# Přechod se **proloží zevnitř tvaru**, ne z jeho okraje.
#
# Na oblém okraji je barva změkčená vyhlazováním, takže vzorek odtud vyjde
# tmavší — a dolitý roh pak nesedí, na hraně je vidět šev. Proto se sbírají
# body z plochy dobře uvnitř, vynechá se bílé písmeno a přes zbytek se proloží
# přímka podle úhlopříčky. Ta se pak dá dopočítat i pro rohy, které ve zdroji
# vůbec nejsou.
probe = src.load()
samples = []
step = max(1, side // 128)
margin = side // 6
for y in range(margin, side - margin, step):
    for x in range(margin, side - margin, step):
        r, g, b, a = probe[x, y]
        if a < 250:
            continue
        # Bílé písmeno není pozadí
        if r > 200 and g > 200 and b > 200:
            continue
        samples.append(((x + y) / (2 * (side - 1)), (r, g, b)))

if len(samples) < 32:
    raise SystemExit('Ze zdroje se nepodařilo odečíst přechod — je to vůbec obrázek s pozadím?')


def fit(channel):
    """Přímka barvy podle úhlopříčky — metodou nejmenších čtverců."""
    n = len(samples)
    sx = sum(t for t, _ in samples)
    sy = sum(c[channel] for _, c in samples)
    sxx = sum(t * t for t, _ in samples)
    sxy = sum(t * c[channel] for t, c in samples)
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-9:
        return sy / n, 0.0
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    return intercept, slope


lines = [fit(channel) for channel in range(3)]
clip = lambda v: max(0, min(255, round(v)))
start = tuple(clip(intercept) for intercept, _ in lines)
end = tuple(clip(intercept + slope) for intercept, slope in lines)


def diagonal(size):
    """Plný čtverec s úhlopříčným přechodem podle proložených přímek."""
    out = Image.new('RGB', (size, size))
    pixels = out.load()
    last = 2 * (size - 1)
    for y in range(size):
        for x in range(size):
            t = (x + y) / last
            pixels[x, y] = tuple(clip(intercept + slope * t) for intercept, slope in lines)
    return out


def resize(image, size):
    return image.resize((size, size), Image.LANCZOS)


# Windows: zaoblený tvar i průhlednost zůstávají, kreslí se přes celé plátno
resize(src, 1024).save('build/icon.png')
print('build/icon.png            1024×1024 RGBA (Windows)')

# macOS: stejný tvar, ale **zmenšený do plátna**.
#
# Apple počítá s tím, že kolem ikony je průhledný okraj — systémové ikony mají
# kresbu jen na ~82 % plátna. Kdyby tahle šla od kraje ke kraji, v Docku by
# vedle ostatních vypadala nápadně větší. Proto se zmenší a vycentruje.
mac = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
art = resize(src, 824)
mac.paste(art, ((1024 - 824) // 2, (1024 - 824) // 2))
mac.save('build/icon-mac.png')
print('build/icon-mac.png        1024×1024 RGBA (macOS, s okrajem)')

# iOS: plný čtverec bez alfa kanálu.
#
# Neskládá se ze zdroje položeného na přechod — okraj zaoblení je ve zdroji
# změkčený a přes nový podklad by prosvítal jako slabý obrys. Bere se proto
# jen **bílé písmeno** a to se položí na dopočítaný přechod. Tvar zaoblení tím
# úplně zmizí, což je správně: iOS si rohy zaobluje sám.
def letter_mask(image):
    """Průhlednost bílého písmene — včetně jeho vyhlazených okrajů."""
    pixels = image.load()
    mask = Image.new('L', image.size)
    out = mask.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                out[x, y] = 0
                continue
            # Čím blíž bílé, tím víc písmene. Pozadí je sytě fialové, takže
            # nejnižší ze složek je spolehlivé měřítko.
            level = (min(r, g, b) - 120) * 255 // 135
            out[x, y] = max(0, min(255, level)) * a // 255
    return mask


big = resize(src, 1024)
flat = diagonal(1024)
flat.paste(Image.new('RGB', (1024, 1024), (255, 255, 255)), (0, 0), letter_mask(big))
flat = flat.convert('RGB')
ios_path = 'ios/QuentinoApp/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png'
flat.save(ios_path)
print(f'{ios_path}  1024×1024 RGB (bez alfy)')
print(f'přechod odečten ze zdroje: {start} → {end}')
