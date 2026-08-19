import UIKit
import WebKit

/**
 Tisk zprávy do PDF.

 Rozhraní pošle hotové HTML (stejné, jaké vidí na obrazovce) a čeká cestu
 k souboru. Na počítači to udělá Electron, tady se stránka vysází ve skrytém
 `WKWebView` a rozstránkuje na A4 — dlouhá zpráva tak nevyjede na jednu
 nekonečnou stránku.
 */
enum MailPdf {
    private static let a4 = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)

    @MainActor
    static func export(name: String, html: String) async throws -> String {
        let webView = WKWebView(frame: a4)
        let waiter = LoadWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(html, baseURL: nil)
        await waiter.wait()
        // Obrázky a písma se dokreslují ještě chvíli po načtení
        _ = try? await webView.evaluateJavaScript(
            "new Promise(r => { const t = setTimeout(r, 1500);"
            + " document.fonts.ready.then(() => { clearTimeout(t); setTimeout(r, 60); }); })"
        )

        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        // Okraje 30 × 40 bodů, aby text nekončil u kraje papíru
        renderer.setValue(a4, forKey: "paperRect")
        renderer.setValue(a4.insetBy(dx: 30, dy: 40), forKey: "printableRect")

        let output = NSMutableData()
        UIGraphicsBeginPDFContextToData(output, a4, nil)
        let pages = max(1, renderer.numberOfPages)
        for page in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        withExtendedLifetime(waiter) { }

        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == " " }
            .trimmingCharacters(in: .whitespaces)
        let file = Files.scratch.appendingPathComponent("\(safe.isEmpty ? "zprava" : safe).pdf")
        try (output as Data).write(to: file, options: .atomic)
        return file.path
    }
}
