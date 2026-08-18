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
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "woff": "font/woff",
        "woff2": "font/woff2"
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }

        // Cesta bez počátečního lomítka; prázdná znamená index
        var relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        if relative.hasSuffix("/") { relative += "index.html" }

        guard let root = Bundle.main.url(forResource: "renderer", withExtension: nil),
              let file = URL(string: relative, relativeTo: root),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let ext = (relative as NSString).pathExtension.lowercased()
        let response = URLResponse(
            url: url,
            mimeType: Self.mimeTypes[ext] ?? "application/octet-stream",
            expectedContentLength: data.count,
            textEncodingName: nil
        )
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }
}
