import UIKit
import WebKit

/**
 Dárkové poukazy jako PDF do přílohy e-mailu.

 Sazba je totožná se stolní verzí (`src/main/voucher.ts`) — stejné HTML, jen
 se místo Electronu vykresluje ve `WKWebView`. Díky tomu vypadá poukaz
 poslaný z telefonu stejně jako ten z počítače a stačí ho udržovat na jednom
 místě.

 Rozměr je široký pásek 595 × 283 bodů. Web se vykresluje v CSS pixelech
 (1 pt = 4/3 px), takže se stránka vysází ve větším měřítku a hotové PDF se
 pak zmenší zpátky — text zůstane vektorový a ostrý.
 */
enum VoucherPdf {
    private static let pageSize = CGSize(width: 595, height: 283)
    private static let pixelsPerPoint: CGFloat = 4.0 / 3.0

    // MARK: - Texty

    private static let domain: [String: String] = [
        "cz": "www.quentino.cz", "sk": "www.quentino.sk", "en": "www.wearquentino.com"
    ]

    private static let strings: [String: [String: String]] = [
        "cz": [
            "title": "Dárkový poukaz", "code": "Váš kód", "validUntil": "Poukaz je platný do",
            "tagline": "Na prémiové pánské doplňky od Quentino",
            "discount": "sleva", "shipping": "Doprava zdarma", "file": "Poukaz"
        ],
        "sk": [
            "title": "Darčekový poukaz", "code": "Váš kód", "validUntil": "Poukaz je platný do",
            "tagline": "Na prémiové pánske doplnky od Quentino",
            "discount": "zľava", "shipping": "Doprava zadarmo", "file": "Poukaz"
        ],
        "en": [
            "title": "Gift voucher", "code": "Your code", "validUntil": "Valid until",
            "tagline": "For premium men’s accessories by Quentino",
            "discount": "discount", "shipping": "Free shipping", "file": "Voucher"
        ]
    ]

    private static func text(_ lang: String, _ key: String) -> String {
        strings[lang]?[key] ?? strings["cz"]?[key] ?? ""
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// „1000" + „CZK" → „1 000 Kč"; procenta a doprava zdarma se sází zvlášť.
    static func formatValue(_ spec: [String: Any]) -> String {
        let lang = spec["lang"] as? String ?? "cz"
        let unit = spec["unit"] as? String ?? "CZK"
        if unit == "shipping" { return text(lang, "shipping") }

        let raw = String(describing: spec["value"] ?? "")
            .filter { $0.isNumber || $0 == "," || $0 == "." }
            .replacingOccurrences(of: ",", with: ".")
        let number = Double(raw) ?? 0
        if unit == "percent" { return "\(Int(number)) %" }

        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        formatter.groupingSeparator = "\u{00a0}"   // nezlomitelná mezera, ať se částka nezalomí
        let grouped = formatter.string(from: NSNumber(value: number)) ?? String(Int(number))
        return "\(grouped)\u{00a0}\(unit == "EUR" ? "€" : "Kč")"
    }

    private static func formatDate(_ iso: String, lang: String) -> String {
        guard !iso.isEmpty else { return "" }
        guard let date = Formats.date(iso) ?? DateFormatter.plainDay.date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: lang == "en" ? "en_GB" : "cs_CZ")
        formatter.dateFormat = lang == "en" ? "dd/MM/yyyy" : "dd.MM.yyyy"
        return formatter.string(from: date)
    }

    /// Logo jako data URL, aby se do PDF vysadilo bez síťového požadavku.
    private static func logoDataUrl() -> String? {
        let path = Store.setting("voucherLogo", "") ?? ""
        // Cesta v nastavení může být z předchozí instalace — viz Files.resolve
        guard let found = Files.resolve(path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: found)) else { return nil }
        let ext = (path as NSString).pathExtension.lowercased()
        let mime = ext == "svg" ? "image/svg+xml" : (ext == "jpg" || ext == "jpeg") ? "image/jpeg" : "image/png"
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }

    // MARK: - Sazba

    /**
     Černá plocha, bílá typografie, žádné efekty — poukaz se často tiskne na
     domácí tiskárně a přechody na papíře zplihnou. Hierarchii nese kontrast
     tučnosti a prostrkání: částka je tučná a bez proložení, popisky jsou
     lehké verzálky s velkými mezerami mezi písmeny.
     */
    static func html(spec: [String: Any], code: String) -> String {
        let lang = spec["lang"] as? String ?? "cz"
        let unit = spec["unit"] as? String ?? "CZK"
        let value = formatValue(spec)
        let isPercent = unit == "percent"
        // Doprava zdarma je věta, ne číslo — potřebuje menší stupeň a smí se zalomit
        let isShipping = unit == "shipping"
        let validUntil = spec["validUntil"] as? String ?? ""
        let note = spec["note"] as? String ?? ""

        let amountSize = isShipping ? "30pt" : (isPercent ? "44pt" : (value.count > 9 ? "38pt" : "44pt"))
        let logo = logoDataUrl()
        let brand = logo.map { "<img class=\"logo\" src=\"\($0)\" alt=\"\">" }
            ?? "<div class=\"wordmark\">Quentino</div>"
        let validLine = validUntil.isEmpty
            ? ""
            : "\(escape(text(lang, "validUntil"))) <b>\(escape(formatDate(validUntil, lang: lang)))</b>"
        let noteLine = note.isEmpty ? "" : "<div class=\"note\">\(escape(note))</div>"
        let discount = isPercent ? "<small>\(escape(text(lang, "discount")))</small>" : ""

        return """
        <!doctype html><html><head><meta charset="utf-8">
        <style>
        @page { size: 595pt 283pt; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { width: 595pt; height: 283pt; }
        body {
          background: #0a0a0b; color: #ffffff;
          /* Montserrat v systému není; náhrady jsou taky geometrické bezpatkové */
          font-family: 'Montserrat', 'Futura', 'Avenir Next', 'Helvetica Neue', Helvetica, sans-serif;
          font-weight: 400;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
          -webkit-text-size-adjust: none;
        }
        .sheet { width: 100%; height: 100%; padding: 26pt 34pt 24pt; display: flex; flex-direction: column; }
        .rule { height: 0.5pt; background: rgba(255,255,255,0.26); }
        .top { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 12pt; }
        .eyebrow {
          font-size: 6.5pt; font-weight: 500; letter-spacing: 0.3em;
          text-transform: uppercase; color: rgba(255,255,255,0.55);
        }
        .logo { max-height: 20pt; max-width: 110pt; filter: brightness(0) invert(1); opacity: 0.92; }
        .wordmark { font-size: 10pt; font-weight: 600; letter-spacing: 0.38em; text-transform: uppercase; }
        .middle { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 14pt 0; }
        .title {
          font-size: 13pt; font-weight: 500; letter-spacing: 0.2em;
          text-transform: uppercase; color: rgba(255,255,255,0.9);
        }
        .amount-row { display: flex; align-items: flex-end; gap: 16pt; padding-top: 8pt; }
        .amount {
          font-size: \(amountSize); font-weight: 700; line-height: \(isShipping ? "1.08" : "1");
          letter-spacing: -0.015em; \(isShipping ? "max-width: 250pt;" : "")
        }
        .amount small {
          font-size: 0.3em; font-weight: 500; letter-spacing: 0.12em;
          padding-left: 5pt; text-transform: uppercase;
        }
        .code-block { padding-bottom: 4pt; }
        .code-label {
          font-size: 6pt; font-weight: 500; letter-spacing: 0.26em;
          text-transform: uppercase; color: rgba(255,255,255,0.5); padding-bottom: 4pt;
        }
        .code {
          font-size: 12pt; font-weight: 600; letter-spacing: 0.22em;
          border: 0.5pt solid rgba(255,255,255,0.4);
          padding: 5pt 11pt 5pt 14pt; display: inline-block;
        }
        .bottom {
          display: flex; align-items: flex-end; justify-content: space-between;
          padding-top: 12pt; font-size: 6.5pt; font-weight: 400; letter-spacing: 0.05em;
          color: rgba(255,255,255,0.6);
        }
        .valid b { color: #fff; font-weight: 600; letter-spacing: 0.06em; }
        .note { padding-top: 4pt; color: rgba(255,255,255,0.38); max-width: 280pt; line-height: 1.5; }
        .site { font-weight: 500; letter-spacing: 0.16em; color: rgba(255,255,255,0.8); }
        </style></head><body>
        <div class="sheet">
          <div class="top">
            <div class="eyebrow">\(escape(text(lang, "tagline")))</div>
            \(brand)
          </div>
          <div class="rule"></div>
          <div class="middle">
            <div class="title">\(escape(text(lang, "title")))</div>
            <div class="amount-row">
              <div class="amount">\(escape(value))\(discount)</div>
              <div class="code-block">
                <div class="code-label">\(escape(text(lang, "code")))</div>
                <div class="code">\(escape(code))</div>
              </div>
            </div>
          </div>
          <div class="rule"></div>
          <div class="bottom">
            <div>
              <div class="valid">\(validLine)</div>
              \(noteLine)
            </div>
            <div class="site">\(escape(domain[lang] ?? domain["cz"]!))</div>
          </div>
        </div>
        </body></html>
        """
    }

    // MARK: - Vykreslení

    /// Vysází poukaz do PDF a vrátí cestu k souboru pro přílohu.
    @MainActor
    static func create(spec: [String: Any], code: String) async throws -> String {
        let markup = html(spec: spec, code: code)
        let frame = CGRect(x: 0, y: 0,
                           width: pageSize.width * pixelsPerPoint,
                           height: pageSize.height * pixelsPerPoint)

        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: frame, configuration: configuration)
        webView.isOpaque = false
        webView.scrollView.isScrollEnabled = false

        let waiter = LoadWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(markup, baseURL: nil)
        await waiter.wait()

        // Písmo i obrázek loga se dokreslí až po načtení; bez krátkého čekání
        // by poukaz vyjel s náhradním řezem nebo bez loga.
        _ = try? await webView.evaluateJavaScript(
            "new Promise(r => { const t = setTimeout(r, 2000);"
            + " document.fonts.ready.then(() => { clearTimeout(t); setTimeout(r, 80); }); })"
        )

        let configurationPdf = WKPDFConfiguration()
        configurationPdf.rect = CGRect(origin: .zero, size: frame.size)
        let raw = try await webView.pdf(configuration: configurationPdf)

        withExtendedLifetime(waiter) { }
        let data = downscale(raw, to: pageSize, factor: 1 / pixelsPerPoint) ?? raw
        let lang = spec["lang"] as? String ?? "cz"
        let safe = code.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let file = Files.scratch
            .appendingPathComponent("\(text(lang, "file"))-\(safe.isEmpty ? "poukaz" : safe).pdf")
        try data.write(to: file)
        return file.path
    }

    /// Několik kódů na stejnou hodnotu = několik samostatných PDF.
    @MainActor
    static func create(spec: [String: Any]) async throws -> [String] {
        let codes = (spec["codes"] as? [String] ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !codes.isEmpty else { throw BridgeError.message("Poukaz nemá žádný kód.") }

        var files: [String] = []
        for code in codes { files.append(try await create(spec: spec, code: code)) }
        return files
    }

    /// Přepočet hotového PDF na cílový rozměr; text zůstává vektorový.
    private static func downscale(_ data: Data, to size: CGSize, factor: CGFloat) -> Data? {
        guard let provider = CGDataProvider(data: data as CFData),
              let document = CGPDFDocument(provider),
              let page = document.page(at: 1) else { return nil }

        let output = NSMutableData()
        guard let consumer = CGDataConsumer(data: output as CFMutableData) else { return nil }
        var box = CGRect(origin: .zero, size: size)
        guard let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }

        context.beginPage(mediaBox: &box)
        context.scaleBy(x: factor, y: factor)
        context.drawPDFPage(page)
        context.endPage()
        context.closePDF()
        return output as Data
    }
}

/// Počká, až se stránka načte — `loadHTMLString` sám o dokončení neřekne.
final class LoadWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        if finished { return }
        await withCheckedContinuation { continuation in
            if finished { continuation.resume(); return }
            self.continuation = continuation
        }
    }

    private func done() {
        guard !finished else { return }
        finished = true
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done() }
}

extension DateFormatter {
    /// Datum ve tvaru `2026-12-31`, jak ho posílá formulář v rozhraní.
    static let plainDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()
}
