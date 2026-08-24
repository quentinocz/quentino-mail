import Foundation

/**
 Rozbor zprávy podle MIME.

 Na počítači to dělá knihovna `mailparser`; tady je vlastní čtečka, protože
 potřebujeme jen to, co aplikace ukazuje: hlavičky, text a HTML, přílohy
 a obrázky vložené do textu.

 Hlavičky umí být zakódované (`=?utf-8?B?…?=`), tělo zase v base64 nebo
 quoted-printable a v libovolné znakové sadě — všechno se převádí do Swiftu
 hned při rozboru, aby zbytek aplikace pracoval s obyčejnými řetězci.
 */
enum Mime {
    struct Address {
        let name: String
        let address: String
    }

    struct Attachment {
        let filename: String
        let mime: String
        let data: Data
        let contentId: String?
        let isInline: Bool
    }

    struct Message {
        var headers: [String: String] = [:]
        var subject = ""
        var from: Address?
        var to: [Address] = []
        var cc: [Address] = []
        /// Kam odesílatel chce odpověď, když ne na svou adresu
        var replyTo: [Address] = []
        var date: Date?
        var messageId = ""
        var inReplyTo = ""
        var references = ""
        var html: String?
        var text: String?
        var attachments: [Attachment] = []
    }

    // MARK: - Hlavní vstup

    static func parse(_ raw: Data) -> Message {
        let (headerText, body) = split(raw)
        let headers = parseHeaders(headerText)

        var message = Message(headers: headers)
        message.subject = decodeWords(headers["subject"] ?? "")
        message.from = addresses(headers["from"] ?? "").first
        message.to = addresses(headers["to"] ?? "")
        message.cc = addresses(headers["cc"] ?? "")
        message.replyTo = addresses(headers["reply-to"] ?? "")
        message.date = parseDate(headers["date"] ?? "")
        message.messageId = clean(headers["message-id"] ?? "")
        message.inReplyTo = clean(headers["in-reply-to"] ?? "")
        message.references = headers["references"] ?? ""

        walk(headers: headers, body: body, into: &message)
        return message
    }

    /// Jen hlavičky — používá se při stahování seznamu zpráv.
    static func parseHeadersOnly(_ raw: Data) -> Message {
        let (headerText, _) = split(raw)
        let headers = parseHeaders(headerText)
        var message = Message(headers: headers)
        message.subject = decodeWords(headers["subject"] ?? "")
        message.from = addresses(headers["from"] ?? "").first
        message.to = addresses(headers["to"] ?? "")
        message.cc = addresses(headers["cc"] ?? "")
        message.replyTo = addresses(headers["reply-to"] ?? "")
        message.date = parseDate(headers["date"] ?? "")
        message.messageId = clean(headers["message-id"] ?? "")
        message.inReplyTo = clean(headers["in-reply-to"] ?? "")
        message.references = headers["references"] ?? ""
        return message
    }

    private static func split(_ raw: Data) -> (String, Data) {
        let separators: [[UInt8]] = [[0x0D, 0x0A, 0x0D, 0x0A], [0x0A, 0x0A]]
        for separator in separators {
            if let range = raw.range(of: Data(separator)) {
                let head = String(decoding: raw[raw.startIndex..<range.lowerBound], as: UTF8.self)
                return (head, Data(raw[range.upperBound...]))
            }
        }
        return (String(decoding: raw, as: UTF8.self), Data())
    }

    /// Hlavičky se skládají zpátky z pokračovacích řádků a klíče se sjednotí na malá písmena.
    static func parseHeaders(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        var key = ""
        var value = ""

        func store() {
            guard !key.isEmpty else { return }
            let name = key.lowercased()
            // Received a podobné se opakují; první výskyt stačí
            if out[name] == nil { out[name] = value.trimmingCharacters(in: .whitespaces) }
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            if line.first == " " || line.first == "\t" {
                value += " " + line.trimmingCharacters(in: .whitespaces)
                continue
            }
            store()
            if let colon = line.firstIndex(of: ":") {
                key = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
                value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            } else {
                key = ""
                value = ""
            }
        }
        store()
        return out
    }

    // MARK: - Tělo

    private static func walk(headers: [String: String], body: Data, into message: inout Message) {
        let contentType = headers["content-type"] ?? "text/plain"
        let type = contentType.split(separator: ";").first.map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        } ?? "text/plain"
        let encoding = (headers["content-transfer-encoding"] ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let disposition = (headers["content-disposition"] ?? "").lowercased()

        if type.hasPrefix("multipart/") {
            guard let boundary = parameter(contentType, "boundary") else { return }
            for part in parts(body, boundary: boundary) {
                let (partHeaderText, partBody) = split(part)
                let partHeaders = parseHeaders(partHeaderText)
                // Alternativy se procházejí obě; HTML má přednost, text se hodí pro náhled
                walk(headers: partHeaders, body: partBody, into: &message)
            }
            return
        }

        let decoded = decodeBody(body, encoding: encoding)
        let filename = parameter(headers["content-disposition"] ?? "", "filename")
            ?? parameter(contentType, "name")

        let isAttachment = disposition.hasPrefix("attachment")
            || (filename != nil && !type.hasPrefix("text/"))
            || (type.hasPrefix("image/") && headers["content-id"] != nil)

        if isAttachment || (!type.hasPrefix("text/") && !type.hasPrefix("message/")) {
            let name = filename.map(decodeWords) ?? suggestedName(for: type)
            message.attachments.append(Attachment(
                filename: name,
                mime: type,
                data: decoded,
                contentId: headers["content-id"].map { clean($0) },
                isInline: disposition.hasPrefix("inline") || headers["content-id"] != nil
            ))
            return
        }

        let charset = parameter(contentType, "charset") ?? "utf-8"
        let content = string(decoded, charset: charset)
        if type == "text/html" {
            message.html = (message.html ?? "") + content
        } else if type == "text/plain" {
            message.text = (message.text ?? "") + content
        }
    }

    private static func suggestedName(for type: String) -> String {
        let extensions = ["image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf"]
        return "priloha.\(extensions[type] ?? "bin")"
    }

    /// Rozdělení těla podle hraničního řetězce.
    private static func parts(_ body: Data, boundary: String) -> [Data] {
        let marker = Data("--\(boundary)".utf8)
        var out: [Data] = []
        var index = body.startIndex
        var contentStart: Data.Index?

        while index < body.endIndex, let range = body.range(of: marker, in: index..<body.endIndex) {
            if let start = contentStart {
                var slice = body[start..<range.lowerBound]
                // Před hranicí je vždy konec řádku, který k obsahu nepatří
                while let last = slice.last, last == 0x0A || last == 0x0D { slice = slice.dropLast() }
                out.append(Data(slice))
            }
            // Konec seznamu poznáme podle `--boundary--`
            let after = range.upperBound
            if after < body.endIndex, body[after] == 0x2D { break }
            // Obsah začíná až za koncem řádku, na kterém hranice stojí
            guard let newline = body.range(of: Data([0x0A]), in: after..<body.endIndex) else { break }
            contentStart = newline.upperBound
            index = newline.upperBound
        }
        return out
    }

    // MARK: - Dekódování

    static func decodeBody(_ data: Data, encoding: String) -> Data {
        switch encoding {
        case "base64":
            let text = String(decoding: data, as: UTF8.self)
                .components(separatedBy: .whitespacesAndNewlines).joined()
            return Data(base64Encoded: text, options: [.ignoreUnknownCharacters]) ?? data
        case "quoted-printable":
            return decodeQuotedPrintable(data)
        default:
            return data
        }
    }

    static func decodeQuotedPrintable(_ data: Data) -> Data {
        var out = Data()
        var index = data.startIndex
        while index < data.endIndex {
            let byte = data[index]
            if byte == 0x3D, data.distance(from: index, to: data.endIndex) >= 3 {
                let first = data[data.index(after: index)]
                let second = data[data.index(index, offsetBy: 2)]
                if first == 0x0D || first == 0x0A {
                    // Měkké zalomení řádku — zmizí
                    index = data.index(index, offsetBy: first == 0x0D ? 3 : 2)
                    continue
                }
                if let value = UInt8(String(decoding: [first, second], as: UTF8.self), radix: 16) {
                    out.append(value)
                    index = data.index(index, offsetBy: 3)
                    continue
                }
            }
            out.append(byte)
            index = data.index(after: index)
        }
        return out
    }

    /// Převod bajtů na text podle znakové sady uvedené v hlavičce.
    static func string(_ data: Data, charset: String) -> String {
        let name = charset.trimmingCharacters(in: CharacterSet(charactersIn: "\" ")).lowercased()
        if name == "utf-8" || name == "utf8" || name.isEmpty {
            return String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        }
        let raw = CFStringConvertIANACharSetNameToEncoding(name as CFString)
        if raw != kCFStringEncodingInvalidId {
            let encoding = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(raw))
            if let text = String(data: data, encoding: encoding) { return text }
        }
        return String(data: data, encoding: .isoLatin1) ?? String(decoding: data, as: UTF8.self)
    }

    /// Hlavičky zakódované podle RFC 2047: `=?utf-8?B?…?=` i `?Q?`.
    static func decodeWords(_ text: String) -> String {
        guard text.contains("=?") else { return text }
        let pattern = "=\\?([^?]+)\\?([BbQq])\\?([^?]*)\\?="
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }

        var out = ""
        var cursor = text.startIndex
        var previousWasWord = false

        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text),
                  let charsetRange = Range(match.range(at: 1), in: text),
                  let kindRange = Range(match.range(at: 2), in: text),
                  let payloadRange = Range(match.range(at: 3), in: text) else { continue }

            var between = String(text[cursor..<range.lowerBound])
            // Mezera mezi dvěma zakódovanými úseky se podle normy zahazuje
            if previousWasWord, between.trimmingCharacters(in: .whitespaces).isEmpty { between = "" }
            out += between

            let charset = String(text[charsetRange])
            let payload = String(text[payloadRange])
            let bytes: Data
            if text[kindRange].lowercased() == "b" {
                bytes = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters]) ?? Data()
            } else {
                bytes = decodeQuotedPrintable(Data(payload.replacingOccurrences(of: "_", with: " ").utf8))
            }
            out += string(bytes, charset: charset)
            cursor = range.upperBound
            previousWasWord = true
        }
        out += String(text[cursor...])
        return out
    }

    // MARK: - Drobnosti

    static func parameter(_ header: String, _ name: String) -> String? {
        for piece in header.split(separator: ";").dropFirst() {
            let part = piece.trimmingCharacters(in: .whitespaces)
            let lower = part.lowercased()
            // `filename*=utf-8''…` je rozšířený zápis podle RFC 2231
            if lower.hasPrefix("\(name)*=") {
                let value = String(part.dropFirst(name.count + 2))
                let pieces = value.components(separatedBy: "'")
                let encoded = pieces.count >= 3 ? pieces[2...].joined(separator: "'") : value
                return encoded.removingPercentEncoding ?? encoded
            }
            if lower.hasPrefix("\(name)=") {
                var value = String(part.dropFirst(name.count + 1))
                if value.hasPrefix("\"") { value = String(value.dropFirst()) }
                if value.hasSuffix("\"") { value = String(value.dropLast()) }
                return value
            }
        }
        return nil
    }

    static func addresses(_ header: String) -> [Address] {
        guard !header.isEmpty else { return [] }
        var out: [Address] = []
        var current = ""
        var inQuotes = false
        var pieces: [String] = []

        for character in header {
            if character == "\"" { inQuotes.toggle() }
            if character == ",", !inQuotes {
                pieces.append(current)
                current = ""
                continue
            }
            current.append(character)
        }
        pieces.append(current)

        for piece in pieces {
            let text = piece.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { continue }
            if let open = text.lastIndex(of: "<"), let close = text.lastIndex(of: ">"), open < close {
                let mail = String(text[text.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
                var name = String(text[text.startIndex..<open]).trimmingCharacters(in: .whitespaces)
                if name.hasPrefix("\"") { name = String(name.dropFirst()) }
                if name.hasSuffix("\"") { name = String(name.dropLast()) }
                out.append(Address(name: decodeWords(name), address: mail))
            } else {
                out.append(Address(name: "", address: text))
            }
        }
        return out
    }

    static func clean(_ text: String) -> String {
        text.trimmingCharacters(in: CharacterSet(charactersIn: "<> \t"))
    }

    private static let dateFormats = [
        "EEE, d MMM yyyy HH:mm:ss Z",
        "d MMM yyyy HH:mm:ss Z",
        "EEE, d MMM yyyy HH:mm:ss",
        "d MMM yyyy HH:mm:ss"
    ]

    static func parseDate(_ text: String) -> Date? {
        // Popisky pásem („+0100 (CET)") formátovač neumí, ořízne se
        var value = text.trimmingCharacters(in: .whitespaces)
        if let bracket = value.firstIndex(of: "(") {
            value = String(value[value.startIndex..<bracket]).trimmingCharacters(in: .whitespaces)
        }
        for format in dateFormats {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = format
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }

    /// Prostý text pro náhled v seznamu — z HTML se vytáhne jen to podstatné.
    static func snippet(html: String?, text: String?, limit: Int = 220) -> String {
        if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return condense(text, limit: limit)
        }
        guard let html else { return "" }
        let stripped = html
            .replacingOccurrences(of: "<(script|style)[^>]*>[\\s\\S]*?</\\1>", with: " ",
                                  options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<[^>]+>", with: " ", options: [.regularExpression])
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
        return condense(stripped, limit: limit)
    }

    private static func condense(_ text: String, limit: Int) -> String {
        let single = text.replacingOccurrences(of: "\\s+", with: " ", options: [.regularExpression])
            .trimmingCharacters(in: .whitespaces)
        return String(single.prefix(limit))
    }
}
