import Foundation
import Combine
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
    /// Poslední vytvořený most. Služby běžící na pozadí (fronta publikací,
    /// synchronizace) díky němu umí dát rozhraní vědět, že se něco změnilo.
    static private(set) weak var current: Bridge?

    private weak var webView: WKWebView?
    private var handlers: [String: Handler] = [:]

    /// Handler dostane pole argumentů z JavaScriptu a vrací cokoliv kódovatelného.
    typealias Handler = ([Any]) async throws -> Any?

    override init() {
        super.init()
        registerAll()
        Bridge.current = self
    }

    /// Událost do rozhraní odkudkoliv z aplikace, i mimo hlavní vlákno.
    nonisolated static func notify(_ channel: String, _ payload: [String: Any] = [:]) {
        Task { @MainActor in Bridge.current?.emit(channel, payload) }
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

    /**
     Otevření aplikace odkazem.

     Původně sem chodil jen návrat z přihlášení k Metě, takže se každý odkaz
     bral jako jeho. Teď vede stejnou cestou i klepnutí na upozornění z ntfy —
     rozlišuje se podle prvního dílu adresy. Co není pošta ani chat, jde dál
     na Metu, aby se přihlášení nerozbilo.
     */
    func handleDeepLink(_ url: URL) {
        guard url.scheme == "quentino-mail" else { return }
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = { (name: String) in
            parts?.queryItems?.first { $0.name == name }?.value
        }

        switch url.host {
        case "mail":
            openMail(messageId: query("mid") ?? "")
            return
        case "chat":
            let id = query("id") ?? ""
            Task { await emit("chat:open", ["id": id]) }
            return
        default:
            break
        }

        Task {
            let result = (try? await Instagram.shared.handleCallback(url: url)) ?? ["error": "Přihlášení se nepodařilo dokončit."]
            await emit("ig:connected", result)
        }
    }

    /**
     Zpráva se hledá podle hlavičky `Message-ID`, ne podle čísla řádku.

     Čísla řádků má každé zařízení svoje, takže odkaz vyrobený na počítači by
     v telefonu ukázal na úplně jinou zprávu. `Message-ID` je pro danou zprávu
     stejné všude.

     Upozornění posílá počítač ve chvíli, kdy zprávu stáhl **on** — v telefonu
     tedy skoro nikdy ještě není. Proto se nehlásí „nemám", ale rovnou se
     stáhne pošta a zkusí se to znovu; rozhraní zatím ukáže, že se čeká.
     */
    private func openMail(messageId: String) {
        if let found = localMessage(messageId) {
            Task { await emit("mail:open", found) }
            return
        }

        Task { await emit("mail:open", ["pending": true]) }
        Task.detached(priority: .userInitiated) { [weak self] in
            MailSync.syncAll()
            guard let self else { return }
            let found = self.localMessage(messageId) ?? ["notFound": true]
            await self.emit("mail:open", found)
        }
    }

    private func localMessage(_ messageId: String) -> [String: Any]? {
        guard !messageId.isEmpty else { return nil }
        let rows = (try? SQLite.shared.query(
            "SELECT id, account_id FROM messages WHERE message_id = ? LIMIT 1",
            [.text(messageId)]
        )) ?? []
        guard let row = rows.first, let id = row["id"] as? Int else { return nil }
        return ["id": id, "accountId": row["account_id"] as? Int ?? 0]
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
        registerVoucherChannels()
        registerSyncChannels()
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
