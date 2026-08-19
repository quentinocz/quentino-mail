import Foundation

/**
 IMAP klient.

 Píše se ručně, protože iOS žádné rozhraní pro poštu nemá a knihovna třetí
 strany by přibalila víc, než je potřeba. Umí přesně to, co aplikace používá:
 přihlášení, seznam složek, stažení hlaviček a celých zpráv, změnu příznaků,
 přesun a mazání.

 Odpovědi serveru se čtou po řádcích. Když řádek končí literálem (`{123}`),
 přečte se přesný počet bajtů a pokračuje se dalším řádkem — tak přijdou
 hlavičky i celé zprávy.
 */
final class IMAP {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Jedna odpověď serveru: text s literály nahrazenými značkou a jejich obsah.
    struct Line {
        let text: String
        let literals: [Data]
    }

    struct Folder {
        let path: String
        let name: String
        let flags: [String]
    }

    struct Header {
        let uid: Int
        let flags: [String]
        let size: Int
        let raw: Data
    }

    private let socket: MailSocket
    private var counter = 0
    private(set) var capabilities: Set<String> = []
    private(set) var selected: String?

    init(host: String, port: Int) {
        socket = MailSocket(host: host, port: port)
    }

    // MARK: - Spojení

    func connect(secure: Bool) throws {
        try socket.open(tls: secure)
        _ = try socket.readLine()   // uvítání serveru
        if !secure {
            // Port 143 se nejdřív povýší na šifrovaný; nešifrovaně se hesla neposílají
            _ = try command("STARTTLS")
            try socket.upgradeToTLS()
        }
    }

    func login(user: String, password: String) throws {
        do {
            _ = try command("LOGIN \(quoted(user)) \(quoted(password))")
        } catch let failure as Failure {
            throw Failure(message: "Přihlášení k poště selhalo: \(failure.message)")
        }
        if let response = try? command("CAPABILITY") {
            for line in response where line.text.hasPrefix("* CAPABILITY") {
                capabilities = Set(line.text.dropFirst("* CAPABILITY".count)
                    .split(separator: " ").map { $0.uppercased() })
            }
        }
    }

    func logout() {
        _ = try? command("LOGOUT")
        socket.close()
    }

    func disconnect() {
        socket.close()
    }

    // MARK: - Příkazy

    @discardableResult
    func command(_ text: String) throws -> [Line] {
        counter += 1
        let tag = String(format: "q%03d", counter)
        try socket.write("\(tag) \(text)\r\n")
        return try readUntil(tag: tag)
    }

    private func readUntil(tag: String) throws -> [Line] {
        var lines: [Line] = []
        while true {
            let line = try readLogicalLine()
            if line.text.hasPrefix("\(tag) ") {
                let rest = String(line.text.dropFirst(tag.count + 1))
                if rest.uppercased().hasPrefix("OK") { return lines }
                throw Failure(message: cleanup(rest))
            }
            lines.append(line)
        }
    }

    /// Řádek i s literály, které za ním následují.
    private func readLogicalLine() throws -> Line {
        var text = try socket.readLine()
        var literals: [Data] = []

        while let size = literalSize(text) {
            literals.append(try socket.read(count: size))
            let next = try socket.readLine()
            text = trimLiteralMarker(text) + "«literál»" + next
        }
        return Line(text: text, literals: literals)
    }

    private func literalSize(_ text: String) -> Int? {
        guard text.hasSuffix("}"), let open = text.lastIndex(of: "{") else { return nil }
        let inside = text[text.index(after: open)..<text.index(before: text.endIndex)]
        // `{123+}` je nevyžádaný literál (LITERAL+), číslo je stejné
        return Int(inside.replacingOccurrences(of: "+", with: ""))
    }

    private func trimLiteralMarker(_ text: String) -> String {
        guard let open = text.lastIndex(of: "{") else { return text }
        return String(text[text.startIndex..<open])
    }

    private func cleanup(_ text: String) -> String {
        text.replacingOccurrences(of: "^(NO|BAD)\\s*", with: "", options: [.regularExpression])
    }

    private func quoted(_ text: String) -> String {
        "\"\(text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
    }

    // MARK: - Složky

    func folders() throws -> [Folder] {
        let response = try command("LIST \"\" \"*\"")
        var out: [Folder] = []
        for line in response where line.text.hasPrefix("* LIST") {
            guard let parsed = parseList(line) else { continue }
            if parsed.flags.contains(where: { $0.caseInsensitiveCompare("\\Noselect") == .orderedSame }) { continue }
            out.append(parsed)
        }
        return out
    }

    private func parseList(_ line: Line) -> Folder? {
        let text = line.text
        guard let flagsStart = text.firstIndex(of: "("), let flagsEnd = text.firstIndex(of: ")") else { return nil }
        let flags = text[text.index(after: flagsStart)..<flagsEnd]
            .split(separator: " ").map(String.init)

        var rest = String(text[text.index(after: flagsEnd)...]).trimmingCharacters(in: .whitespaces)
        // Oddělovač: "/" nebo NIL
        if rest.hasPrefix("\"") {
            guard let end = rest.dropFirst().firstIndex(of: "\"") else { return nil }
            rest = String(rest[rest.index(after: end)...]).trimmingCharacters(in: .whitespaces)
        } else if let space = rest.firstIndex(of: " ") {
            rest = String(rest[rest.index(after: space)...]).trimmingCharacters(in: .whitespaces)
        }

        var path: String
        if rest.hasPrefix("\"") {
            path = String(rest.dropFirst())
            if let end = path.lastIndex(of: "\"") { path = String(path[path.startIndex..<end]) }
        } else if rest.contains("«literál»"), let data = line.literals.last {
            path = String(data: data, encoding: .utf8) ?? ""
        } else {
            path = rest
        }
        path = path.replacingOccurrences(of: "\\\"", with: "\"")
        guard !path.isEmpty else { return nil }

        let decoded = ModifiedUTF7.decode(path)
        let name = decoded.split(whereSeparator: { $0 == "/" || $0 == "." }).last.map(String.init) ?? decoded
        return Folder(path: path, name: name, flags: flags)
    }

    struct Status {
        let messages: Int
        let unseen: Int
        let uidNext: Int
    }

    func status(_ folder: String) throws -> Status {
        let response = try command("STATUS \(quoted(folder)) (MESSAGES UNSEEN UIDNEXT)")
        for line in response where line.text.contains("STATUS") {
            func value(_ key: String) -> Int {
                guard let range = line.text.range(of: "\(key) ") else { return 0 }
                let rest = line.text[range.upperBound...].prefix { $0.isNumber }
                return Int(rest) ?? 0
            }
            return Status(messages: value("MESSAGES"), unseen: value("UNSEEN"), uidNext: value("UIDNEXT"))
        }
        return Status(messages: 0, unseen: 0, uidNext: 0)
    }

    @discardableResult
    func select(_ folder: String, readOnly: Bool = false) throws -> Int {
        let response = try command("\(readOnly ? "EXAMINE" : "SELECT") \(quoted(folder))")
        selected = folder
        for line in response where line.text.hasSuffix("EXISTS") {
            let number = line.text.dropFirst(2).prefix { $0.isNumber }
            return Int(number) ?? 0
        }
        return 0
    }

    // MARK: - Zprávy

    private static let headerFields =
        "SUBJECT FROM TO CC DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE"

    /// Hlavičky posledních zpráv ve složce (rozsah podle pořadí, ne UID).
    func headers(from sequence: Int) throws -> [Header] {
        let response = try command(
            "FETCH \(sequence):* (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (\(Self.headerFields))])"
        )
        return response.compactMap(parseFetch)
    }

    /// Celá zpráva včetně příloh.
    func body(uid: Int) throws -> Data {
        let response = try command("UID FETCH \(uid) (BODY.PEEK[])")
        for line in response where line.text.contains("FETCH") {
            if let data = line.literals.first { return data }
        }
        throw Failure(message: "Server tělo zprávy nevrátil.")
    }

    private func parseFetch(_ line: Line) -> Header? {
        guard line.text.contains("FETCH"), let raw = line.literals.first else { return nil }
        func number(_ key: String) -> Int {
            guard let range = line.text.range(of: "\(key) ") else { return 0 }
            return Int(line.text[range.upperBound...].prefix { $0.isNumber }) ?? 0
        }
        var flags: [String] = []
        if let start = line.text.range(of: "FLAGS (")?.upperBound,
           let end = line.text[start...].firstIndex(of: ")") {
            flags = line.text[start..<end].split(separator: " ").map(String.init)
        }
        let uid = number("UID")
        guard uid > 0 else { return nil }
        return Header(uid: uid, flags: flags, size: number("RFC822.SIZE"), raw: raw)
    }

    // MARK: - Změny

    func store(uid: Int, flag: String, value: Bool) throws {
        try command("UID STORE \(uid) \(value ? "+" : "-")FLAGS (\(flag))")
    }

    func copy(uid: Int, to folder: String) throws {
        try command("UID COPY \(uid) \(quoted(folder))")
    }

    /// Přesun: `UID MOVE` když ho server umí, jinak kopie a smazání.
    func move(uid: Int, to folder: String) throws {
        if capabilities.contains("MOVE") {
            try command("UID MOVE \(uid) \(quoted(folder))")
            return
        }
        try copy(uid: uid, to: folder)
        try store(uid: uid, flag: "\\Deleted", value: true)
        try command("EXPUNGE")
    }

    func delete(uid: Int, trash: String?) throws {
        if let trash, trash != selected {
            try move(uid: uid, to: trash)
            return
        }
        try store(uid: uid, flag: "\\Deleted", value: true)
        try command("EXPUNGE")
    }

    /**
     Kopie odeslané zprávy do složky na serveru.

     Nejde přes `command`, protože server nejdřív odpoví výzvou `+` a teprve
     pak čeká na samotná data.
     */
    func append(folder: String, message: Data) throws {
        counter += 1
        let tag = String(format: "q%03d", counter)
        try socket.write("\(tag) APPEND \(quoted(folder)) (\\Seen) {\(message.count)}\r\n")
        let answer = try socket.readLine()
        guard answer.hasPrefix("+") else {
            throw Failure(message: "Server kopii do odeslané pošty odmítl: \(answer)")
        }
        try socket.write(message)
        try socket.write("\r\n")
        _ = try readUntil(tag: tag)
    }

    func emptyTrash(_ folder: String) throws -> Int {
        let total = try select(folder)
        guard total > 0 else { return 0 }
        try command("STORE 1:* +FLAGS (\\Deleted)")
        try command("EXPUNGE")
        return total
    }

    /// Obsazení schránky, pokud ho server hlásí (rozšíření QUOTA).
    func quota() -> (used: Int, limit: Int)? {
        guard let response = try? command("GETQUOTAROOT \"INBOX\"") else { return nil }
        for line in response where line.text.contains("QUOTA ") && line.text.contains("STORAGE") {
            guard let start = line.text.range(of: "STORAGE ")?.upperBound else { continue }
            let numbers = line.text[start...]
                .split(whereSeparator: { !$0.isNumber })
                .compactMap { Int($0) }
            if numbers.count >= 2 { return (numbers[0] * 1024, numbers[1] * 1024) }
        }
        return nil
    }
}

/**
 Kódování názvů složek podle IMAP (modifikované UTF-7).

 Bez něj by se „Odeslaná pošta" ukázala jako `Odeslan&AOE- po&AWE-ta`.
 */
enum ModifiedUTF7 {
    static func decode(_ text: String) -> String {
        guard text.contains("&") else { return text }
        var out = ""
        var buffer = ""
        var inShift = false

        for character in text {
            if !inShift {
                if character == "&" { inShift = true; buffer = "" } else { out.append(character) }
                continue
            }
            if character == "-" {
                out += buffer.isEmpty ? "&" : (base64ToText(buffer) ?? "")
                inShift = false
                continue
            }
            buffer.append(character)
        }
        if inShift, !buffer.isEmpty { out += base64ToText(buffer) ?? "" }
        return out
    }

    static func encode(_ text: String) -> String {
        guard text.contains(where: { !$0.isASCII }) else { return text }
        var out = ""
        var run: [UInt16] = []

        func flush() {
            guard !run.isEmpty else { return }
            var bytes = Data()
            for unit in run {
                bytes.append(UInt8(unit >> 8))
                bytes.append(UInt8(unit & 0xFF))
            }
            let base64 = bytes.base64EncodedString()
                .replacingOccurrences(of: "/", with: ",")
                .replacingOccurrences(of: "=", with: "")
            out += "&\(base64)-"
            run.removeAll()
        }

        for character in text {
            if character.isASCII {
                flush()
                if character == "&" { out += "&-" } else { out.append(character) }
            } else {
                run.append(contentsOf: Array(String(character).utf16))
            }
        }
        flush()
        return out
    }

    private static func base64ToText(_ chunk: String) -> String? {
        var normalized = chunk.replacingOccurrences(of: ",", with: "/")
        while normalized.count % 4 != 0 { normalized += "=" }
        guard let data = Data(base64Encoded: normalized) else { return nil }
        var units: [UInt16] = []
        var index = 0
        while index + 1 < data.count {
            units.append(UInt16(data[data.startIndex + index]) << 8 | UInt16(data[data.startIndex + index + 1]))
            index += 2
        }
        return String(decoding: units, as: UTF16.self)
    }
}
