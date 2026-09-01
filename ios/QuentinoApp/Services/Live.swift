import Foundation

/**
 Živé propojení telefonu a počítače přes Supabase Realtime.

 Sesterský modul k `src/main/live.ts` — a schválně stejný do posledního
 detailu, protože obě strany si musí rozumět: stejné jméno kanálu, stejný
 tvar zprávy, stejné druhy.

 ## Proč to je

 Naskladnění se počítá u regálu s telefonem v ruce, ale do e-shopu se
 zapisuje z počítače. Dosud to putovalo sdílenou složkou: telefon zapsal
 soubor, iCloud ho nahrál, počítač si ho v některém z minutových kol
 přečetl. V součtu klidně dvě minuty — a to je u regálu věčnost.

 ## Co se tím mění a co ne

 **Sdílená složka zůstává tím, co platí.** Přežije vypnutý počítač,
 zavřenou aplikaci i výpadek sítě. Tenhle modul je jen rychlý posel: pošle
 tutéž věc hned a druhá strana ji sloučí týmž kódem, který by jinak
 spustila složka. Když posel nedoručí, nic se neztratí.

 ## Proč broadcast a ne tabulky

 Posílá se **broadcast**, ne změny v tabulkách: do databáze se nic
 neukládá, takže není co zabezpečovat ani uklízet — a anon klíč je veřejný
 (je i ve widgetu na e-shopu), takže dát mu do rukou skladová data by
 nebylo v pořádku. Jméno kanálu je zároveň heslo.
 */
enum Live {
    /// Jak dlouho čekat mezi tepy — server bez nich spojení po chvíli zavře.
    private static let heartbeatSeconds: TimeInterval = 25
    /// Po neúspěchu se čeká čím dál dýl, ale nejvýš minutu.
    private static let retryMin: TimeInterval = 2
    private static let retryMax: TimeInterval = 60

    // MARK: - Nastavení

    static func channel() -> String {
        Store.setting("liveChannel", "") ?? ""
    }

    static func isEnabled() -> Bool {
        Store.bool("liveEnabled", false) && !channel().isEmpty && !Chat.url.isEmpty
    }

    static func status() -> [String: Any] {
        [
            "enabled": Store.bool("liveEnabled", false),
            "channel": channel(),
            "connected": joined,
            "error": lastError ?? NSNull()
        ]
    }

    /**
     Nové jméno kanálu.

     Je to zároveň heslo, takže se nevymýšlí — dvacet znaků z náhodných
     bajtů je na uhodnutí příliš. Jen písmena a číslice: jméno jde do
     adresy a pomlčky ani diakritika by se tam pletly.
     */
    static func newChannel() -> String {
        let alphabet = Array("abcdefghijkmnpqrstuvwxyz23456789")
        var out = "q-"
        for _ in 0..<20 {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }

    static func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        if let value = patch["channel"] as? String {
            Store.setSetting("liveChannel", value.trimmingCharacters(in: .whitespaces))
        }
        if let value = patch["enabled"] as? Bool {
            Store.setSetting("liveEnabled", value ? "1" : "0")
        }
        stop()
        if isEnabled() { start() }
        return status()
    }

    // MARK: - Spojení

    private static var task: URLSessionWebSocketTask?
    private static var joined = false
    private static var lastError: String?
    private static var heartbeat: Timer?
    private static var retryIn: TimeInterval = retryMin
    private static var stopped = true
    private static var ref = 0

    /// Co se má stát s přijatou zprávou; nastavuje `LiveWork`.
    static var onMessage: (([String: Any]) -> Void)?

    private static func socketUrl() -> URL? {
        let base = Chat.url
        let key = Chat.anonKey
        guard !base.isEmpty, !key.isEmpty else { return nil }
        let ws = base.replacingOccurrences(of: "http", with: "ws")
        let escaped = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
        return URL(string: "\(ws)/realtime/v1/websocket?apikey=\(escaped)&vsn=1.0.0")
    }

    private static func topic() -> String { "realtime:\(channel())" }

    private static func send(_ event: String, _ payload: [String: Any], topic customTopic: String? = nil) {
        guard let task else { return }
        ref += 1
        let frame: [String: Any] = [
            "topic": customTopic ?? topic(),
            "event": event,
            "payload": payload,
            "ref": String(ref)
        ]
        guard JSONSerialization.isValidJSONObject(frame),
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    static func start() {
        stopped = false
        guard isEnabled(), task == nil, let url = socketUrl() else { return }

        let socket = URLSession.shared.webSocketTask(with: url)
        task = socket
        socket.resume()
        receive()

        /*
         Přihlášení ke kanálu. „self: false" znamená, že se vlastní zprávy
         nevrací zpátky — jinak by si telefon slučoval sám se sebou.
         */
        let config: [String: Any] = [
            "broadcast": ["self": false, "ack": false],
            "presence": ["key": ""]
        ]
        send("phx_join", ["config": config])

        DispatchQueue.main.async {
            heartbeat?.invalidate()
            heartbeat = Timer.scheduledTimer(withTimeInterval: heartbeatSeconds, repeats: true) { _ in
                send("heartbeat", [:], topic: "phoenix")
            }
        }
    }

    private static func receive() {
        guard let socket = task else { return }
        socket.receive { result in
            switch result {
            case .failure:
                joined = false
                task = nil
                DispatchQueue.main.async { heartbeat?.invalidate(); heartbeat = nil }
                scheduleRetry()
            case .success(let message):
                if case .string(let text) = message { handle(text) }
                receive()
            }
        }
    }

    private static func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let event = frame["event"] as? String ?? ""

        if event == "phx_reply", (frame["topic"] as? String) == topic() {
            let payload = frame["payload"] as? [String: Any]
            let ok = (payload?["status"] as? String) == "ok"
            joined = ok
            if ok {
                lastError = nil
                retryIn = retryMin
                // Připojení uprostřed práce: zeptat se, co je rozdělané
                _ = publish("hello", [:])
            } else {
                let response = payload?["response"] as? [String: Any]
                lastError = response?["reason"] as? String ?? "kanál nešel otevřít"
            }
            Bridge.notify("live:state", status())
            return
        }

        guard event == "broadcast",
              let payload = frame["payload"] as? [String: Any],
              let body = payload["payload"] as? [String: Any] else { return }
        // Vlastní zpráva, ta se sem vrátit neměla
        if (body["from"] as? String) == Device.id() { return }
        onMessage?(body)
    }

    private static func scheduleRetry() {
        guard !stopped, isEnabled() else { return }
        let wait = retryIn
        retryIn = min(retryMax, retryIn * 2)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { start() }
    }

    static func stop() {
        stopped = true
        joined = false
        retryIn = retryMin
        let open = task
        task = nil
        open?.cancel(with: .goingAway, reason: nil)
        DispatchQueue.main.async { heartbeat?.invalidate(); heartbeat = nil }
        Bridge.notify("live:state", status())
    }

    /**
     Pošle změnu druhé straně.

     Tiše se vzdá, když spojení není — složka to donese. Návratová hodnota
     říká, jestli se to povedlo, aby tlačítko mohlo říct pravdu.
     */
    @discardableResult
    static func publish(_ kind: String, _ data: Any) -> Bool {
        guard joined, task != nil else { return false }
        let message: [String: Any] = [
            "kind": kind,
            "from": Device.id(),
            "fromName": Device.label(),
            "data": data
        ]
        send("broadcast", ["type": "broadcast", "event": kind, "payload": message])
        return true
    }
}
