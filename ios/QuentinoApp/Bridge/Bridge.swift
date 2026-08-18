import Foundation
import WebKit

/**
 Most mezi rozhraním a nativní částí.

 Na počítači běží rozhraní v Electronu a volá `window.api.invoke(kanál, …)`,
 což preload převede na IPC. Tady se drží úplně stejná dohoda: rozhraní volá
 tytéž kanály se stejnými parametry a dostane zpátky `{ ok, data | error }`.
 Díky tomu se React kód nemusí pro iOS nijak upravovat — jen se pod ním
 vymění to, co odpovídá.

 Kanály, které iOS zatím neumí, vrací srozumitelnou chybu místo ticha; podle
 ní se v rozhraní pozná, co ještě chybí.
 */
final class Bridge: NSObject, ObservableObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private var handlers: [String: Handler] = [:]

    /// Handler dostane pole argumentů z JavaScriptu a vrací cokoliv kódovatelného.
    typealias Handler = ([Any]) async throws -> Any?

    override init() {
        super.init()
        registerAll()
    }

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    // MARK: - Volání z rozhraní

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let channel = body["channel"] as? String else { return }
        let args = body["args"] as? [Any] ?? []

        Task { [weak self] in
            guard let self else { return }
            do {
                guard let handler = self.handlers[channel] else {
                    throw BridgeError.unsupported(channel)
                }
                let data = try await handler(args)
                await self.reply(id: id, ok: true, payload: data, error: nil)
            } catch {
                await self.reply(id: id, ok: false, payload: nil, error: error.readableMessage)
            }
        }
    }

    @MainActor
    private func reply(id: String, ok: Bool, payload: Any?, error: String?) {
        var result: [String: Any] = ["ok": ok]
        if let payload { result["data"] = payload }
        if let error { result["error"] = error }
        guard let json = try? JSONSerialization.data(withJSONObject: result, options: []),
              let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__quentinoResolve(\(jsString(id)), \(text))")
    }

    /// Událost směrem do rozhraní — obdoba `webContents.send` z Electronu.
    @MainActor
    func emit(_ channel: String, _ payload: [String: Any] = [:]) {
        guard let json = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__quentinoEmit(\(jsString(channel)), \(text))")
    }

    func emitAsync(_ channel: String, _ payload: [String: Any] = [:]) {
        Task { @MainActor in emit(channel, payload) }
    }

    private func jsString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    // MARK: - Odkazy zvenčí (návrat z přihlášení k Metě)

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "quentino-mail" else { return }
        Task {
            let result = (try? await Instagram.shared.handleCallback(url: url)) ?? ["error": "Přihlášení se nepodařilo dokončit."]
            await emit("ig:connected", result)
        }
    }

    // MARK: - Registrace kanálů

    func register(_ channel: String, _ handler: @escaping Handler) {
        handlers[channel] = handler
    }

    private func registerAll() {
        registerSettingsChannels()
        registerMailChannels()
        registerAiChannels()
        registerChatChannels()
        registerInstagramChannels()
        registerShopChannels()
        registerFileChannels()
    }
}

enum BridgeError: LocalizedError {
    case unsupported(String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .unsupported(let channel):
            return "Tahle funkce zatím na iPhonu a iPadu není (\(channel))."
        case .message(let text):
            return text
        }
    }
}

extension Error {
    /// Chyby ze sítě a systému mají anglické hlášky; do rozhraní patří česká věta.
    var readableMessage: String {
        if let bridge = self as? BridgeError { return bridge.errorDescription ?? "Neznámá chyba." }
        if let local = self as? LocalizedError, let text = local.errorDescription { return text }
        return (self as NSError).localizedDescription
    }
}
