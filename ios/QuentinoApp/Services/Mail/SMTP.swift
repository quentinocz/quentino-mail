import Foundation

/**
 Odesílání pošty.

 Na počítači to obstarává nodemailer; tady se zpráva skládá i odesílá ručně.
 Podporuje obojí obvyklé nastavení: port 465 se šifruje od začátku, port 587
 se povýší příkazem STARTTLS.
 */
enum SMTP {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    struct Envelope {
        var fromName: String
        var fromAddress: String
        var to: String
        var cc: String
        var bcc: String
        var subject: String
        var html: String
        var attachments: [String]
        /// Obrázky vložené do textu: `cid` a cesta k souboru
        var inline: [(cid: String, path: String)]
        var inReplyTo: String?
        var references: String?
    }

    // MARK: - Sestavení zprávy

    static func build(_ envelope: Envelope, boundarySeed: Int = 0) -> Data {
        var html = envelope.html
        var inlineParts: [(cid: String, name: String, mime: String, data: Data)] = []

        for image in envelope.inline {
            guard html.contains("cid:\(image.cid)") else { continue }
            // Kdyby se soubor mezitím ztratil, poslala by se prázdná příloha
            // a příjemce by v podpisu viděl díru — radši obrázek ze zprávy vyřadíme.
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: image.path)), !data.isEmpty else {
                html = html.replacingOccurrences(
                    of: "<img[^>]*cid:\(image.cid)[^>]*>", with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
                continue
            }
            let name = (image.path as NSString).lastPathComponent
            inlineParts.append((image.cid, name, IgMedia.mime(for: image.path), data))
        }

        var attachmentParts: [(name: String, mime: String, data: Data)] = []
        for path in envelope.attachments {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { continue }
            attachmentParts.append(((path as NSString).lastPathComponent, IgMedia.mime(for: path), data))
        }

        let stamp = Int(Date().timeIntervalSince1970)
        let mixed = "q-mixed-\(stamp)-\(boundarySeed)"
        let related = "q-related-\(stamp)-\(boundarySeed)"
        let alternative = "q-alt-\(stamp)-\(boundarySeed)"

        var out = Data()
        func line(_ text: String = "") { out.append(Data("\(text)\r\n".utf8)) }

        // Hlavičky
        line("From: \(address(name: envelope.fromName, mail: envelope.fromAddress))")
        line("To: \(envelope.to)")
        if !envelope.cc.isEmpty { line("Cc: \(envelope.cc)") }
        line("Subject: \(encodeHeader(envelope.subject))")
        line("Date: \(rfc2822Date())")
        line("Message-ID: <\(UUID().uuidString)@\(domain(of: envelope.fromAddress))>")
        if let inReplyTo = envelope.inReplyTo, !inReplyTo.isEmpty { line("In-Reply-To: <\(inReplyTo)>") }
        if let references = envelope.references, !references.isEmpty {
            let list = references.split(whereSeparator: { $0 == " " || $0 == "\n" })
                .map { "<\($0.trimmingCharacters(in: CharacterSet(charactersIn: "<>")))>" }
                .joined(separator: " ")
            line("References: \(list)")
        }
        line("MIME-Version: 1.0")

        let hasAttachments = !attachmentParts.isEmpty
        let hasInline = !inlineParts.isEmpty

        if hasAttachments {
            line("Content-Type: multipart/mixed; boundary=\"\(mixed)\"")
            line()
            line("--\(mixed)")
        }
        if hasInline {
            line("Content-Type: multipart/related; boundary=\"\(related)\"")
            line()
            line("--\(related)")
        }

        // Text a HTML vedle sebe — poštovní klienti si vyberou
        line("Content-Type: multipart/alternative; boundary=\"\(alternative)\"")
        if !hasAttachments && !hasInline { line() }
        line()
        line("--\(alternative)")
        line("Content-Type: text/plain; charset=utf-8")
        line("Content-Transfer-Encoding: base64")
        line()
        out.append(base64Block(Data(htmlToText(html).utf8)))
        line("--\(alternative)")
        line("Content-Type: text/html; charset=utf-8")
        line("Content-Transfer-Encoding: base64")
        line()
        out.append(base64Block(Data(html.utf8)))
        line("--\(alternative)--")

        if hasInline {
            for part in inlineParts {
                line()
                line("--\(related)")
                line("Content-Type: \(part.mime); name=\"\(part.name)\"")
                line("Content-Transfer-Encoding: base64")
                line("Content-ID: <\(part.cid)>")
                line("Content-Disposition: inline; filename=\"\(part.name)\"")
                line()
                out.append(base64Block(part.data))
            }
            line("--\(related)--")
        }

        if hasAttachments {
            for part in attachmentParts {
                line()
                line("--\(mixed)")
                line("Content-Type: \(part.mime); name=\"\(encodeHeader(part.name))\"")
                line("Content-Transfer-Encoding: base64")
                line("Content-Disposition: attachment; filename=\"\(encodeHeader(part.name))\"")
                line()
                out.append(base64Block(part.data))
            }
            line("--\(mixed)--")
        }
        return out
    }

    private static func base64Block(_ data: Data) -> Data {
        var text = data.base64EncodedString(options: [.lineLength76Characters, .endLineWithCarriageReturn])
        text += "\r\n"
        return Data(text.utf8)
    }

    private static func address(name: String, mail: String) -> String {
        name.isEmpty ? mail : "\(encodeHeader(name)) <\(mail)>"
    }

    private static func domain(of mail: String) -> String {
        mail.split(separator: "@").last.map(String.init) ?? "quentino.cz"
    }

    /// Diakritika v hlavičce musí být zakódovaná (RFC 2047).
    static func encodeHeader(_ text: String) -> String {
        guard text.contains(where: { !$0.isASCII }) else { return text }
        return "=?utf-8?B?\(Data(text.utf8).base64EncodedString())?="
    }

    private static func rfc2822Date() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, d MMM yyyy HH:mm:ss Z"
        return formatter.string(from: Date())
    }

    /// Prostá verze zprávy — bez ní končí pošta častěji v nevyžádané.
    static func htmlToText(_ html: String) -> String {
        html
            .replacingOccurrences(of: "<style[\\s\\S]*?</style>", with: "",
                                  options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<script[\\s\\S]*?</script>", with: "",
                                  options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "</(p|div|li|h[1-6])>", with: "\n",
                                  options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<[^>]+>", with: "", options: [.regularExpression])
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: [.regularExpression])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Odeslání

    static func send(
        host: String, port: Int, secure: Bool, user: String, password: String,
        from: String, recipients: [String], message: Data
    ) throws {
        let socket = MailSocket(host: host, port: port)
        try socket.open(tls: secure)
        defer { socket.close() }

        try expect(socket, code: "220")
        var capabilities = try hello(socket, host: host)

        if !secure {
            // Port 587: nešifrované spojení se povýší, teprve pak se posílá heslo
            try send(socket, "STARTTLS")
            try expect(socket, code: "220")
            try socket.upgradeToTLS()
            capabilities = try hello(socket, host: host)
        }

        try authenticate(socket, capabilities: capabilities, user: user, password: password)

        try send(socket, "MAIL FROM:<\(from)>")
        try expect(socket, code: "250")
        for recipient in recipients where !recipient.isEmpty {
            try send(socket, "RCPT TO:<\(recipient)>")
            try expect(socket, code: "250")
        }
        try send(socket, "DATA")
        try expect(socket, code: "354")

        try socket.write(stuffDots(message))
        try socket.write("\r\n.\r\n")
        try expect(socket, code: "250")

        try? send(socket, "QUIT")
    }

    /// Řádek začínající tečkou by ukončil přenos, proto se zdvojuje.
    private static func stuffDots(_ message: Data) -> Data {
        var out = Data()
        var atLineStart = true
        for byte in message {
            if atLineStart, byte == 0x2E { out.append(0x2E) }
            out.append(byte)
            atLineStart = byte == 0x0A
        }
        return out
    }

    private static func hello(_ socket: MailSocket, host: String) throws -> [String] {
        try send(socket, "EHLO quentino.local")
        let lines = try collect(socket)
        guard lines.first?.hasPrefix("2") == true else {
            try send(socket, "HELO quentino.local")
            _ = try collect(socket)
            return []
        }
        return lines.map { String($0.dropFirst(4)).uppercased() }
    }

    private static func authenticate(_ socket: MailSocket, capabilities: [String], user: String, password: String) throws {
        let methods = capabilities.first { $0.hasPrefix("AUTH") } ?? "AUTH LOGIN PLAIN"
        if methods.contains("PLAIN") {
            var payload = Data([0])
            payload.append(Data(user.utf8))
            payload.append(0)
            payload.append(Data(password.utf8))
            try send(socket, "AUTH PLAIN \(payload.base64EncodedString())")
            try expect(socket, code: "235", what: "Přihlášení k odesílání pošty selhalo")
            return
        }
        try send(socket, "AUTH LOGIN")
        try expect(socket, code: "334")
        try send(socket, Data(user.utf8).base64EncodedString())
        try expect(socket, code: "334")
        try send(socket, Data(password.utf8).base64EncodedString())
        try expect(socket, code: "235", what: "Přihlášení k odesílání pošty selhalo")
    }

    private static func send(_ socket: MailSocket, _ text: String) throws {
        try socket.write("\(text)\r\n")
    }

    /// Odpověď může mít víc řádků — pokračovací mají za číslem pomlčku.
    private static func collect(_ socket: MailSocket) throws -> [String] {
        var lines: [String] = []
        while true {
            let line = try socket.readLine()
            lines.append(line)
            if line.count < 4 || line[line.index(line.startIndex, offsetBy: 3)] != "-" { return lines }
        }
    }

    private static func expect(_ socket: MailSocket, code: String, what: String = "Server odmítl požadavek") throws {
        let lines = try collect(socket)
        guard let first = lines.first, first.hasPrefix(code) else {
            throw Failure(message: "\(what): \(lines.joined(separator: " "))")
        }
    }

    /// Ověření nastavení bez odeslání zprávy.
    static func test(host: String, port: Int, secure: Bool, user: String, password: String) throws {
        let socket = MailSocket(host: host, port: port)
        try socket.open(tls: secure)
        defer { socket.close() }
        try expect(socket, code: "220")
        var capabilities = try hello(socket, host: host)
        if !secure {
            try send(socket, "STARTTLS")
            try expect(socket, code: "220")
            try socket.upgradeToTLS()
            capabilities = try hello(socket, host: host)
        }
        try authenticate(socket, capabilities: capabilities, user: user, password: password)
        try? send(socket, "QUIT")
    }
}
