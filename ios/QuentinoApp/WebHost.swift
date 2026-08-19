import SwiftUI
import WebKit

/**
 Hostitel webového rozhraní.

 Stránka se nenačítá přes `file://` — ten má v `WKWebView` omezený přístup
 k vlastním souborům a rozbil by načítání modulů. Používá se vlastní schéma
 `quentino://`, které obsluhuje `AppSchemeHandler` a servíruje soubory
 z balíčku aplikace. Prohlížeč se tak chová, jako by šlo o běžný web.
 */
struct WebHost: UIViewRepresentable {
    let bridge: Bridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: "quentino")

        // Most do nativní části: rozhraní volá `window.api.invoke(kanál, …)`
        // úplně stejně jako na počítači.
        let controller = WKUserContentController()
        controller.add(bridge, name: "quentino")
        controller.addUserScript(WKUserScript(
            source: Bridge.shim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.bounces = false
        webView.scrollView.keyboardDismissMode = .interactive
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        bridge.attach(webView: webView)
        webView.load(URLRequest(url: URL(string: "quentino://app/index.html")!))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) { }
}

/**
 Servíruje sestavené rozhraní z balíčku aplikace.

 Soubory leží v `Resources/renderer` — tam je do balíčku zkopíruje sestavení
 (stejný výstup, jaký na počítači načítá Electron).
 */
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "ico": "image/x-icon",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "map": "application/json; charset=utf-8"
    ]

    /// Kořen se hledá dvakrát: podle toho, jestli se rozhraní do balíčku
    /// dostalo jako složka `renderer`, nebo se soubory rozsypaly do kořene.
    private static let root: URL = {
        if let folder = Bundle.main.url(forResource: "renderer", withExtension: nil),
           FileManager.default.fileExists(atPath: folder.appendingPathComponent("index.html").path) {
            return folder
        }
        return Bundle.main.bundleURL
    }()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }

        var relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        if relative.hasSuffix("/") { relative += "index.html" }
        relative = relative.removingPercentEncoding ?? relative

        // Cesty se skládají po komponentách; `URL(string:relativeTo:)` by
        // u kořene bez lomítka poslední komponentu nahradilo místo připojení.
        var file = Self.root
        for part in relative.split(separator: "/") where part != ".." {
            file.appendPathComponent(String(part))
        }

        guard let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let type = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        // Odpověď musí nést hlavičku Content-Type. Bez ní WKWebView u vlastního
        // schématu obsah nepozná a HTML ukáže jako obyčejný text.
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": type,
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }
}
