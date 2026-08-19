import Foundation

/**
 Textové spojení pro IMAP a SMTP.

 iOS nemá pro poštu žádné systémové rozhraní, takže se s oběma servery mluví
 přímo. `NWConnection` by byl modernější, ale neumí povýšit už navázané
 spojení na šifrované — a přesně to potřebuje SMTP na portu 587 (STARTTLS).
 Proto jsou tu klasické `Stream`y: dají se otevřít nešifrovaně a šifrování
 zapnout až uprostřed.

 Čtení a zápis blokují, proto všechno běží na vlastním vlákně mimo hlavní.
 Aby se spojení nemohlo zaseknout navěky, nastavuje se socketu časový limit
 přímo v systému (`SO_RCVTIMEO`).
 */
final class MailSocket {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private var input: InputStream?
    private var output: OutputStream?
    private var pending = Data()
    private let host: String
    private let port: Int

    init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    // MARK: - Spojení

    func open(tls: Bool, timeout: TimeInterval = 25) throws {
        var readStream: InputStream?
        var writeStream: OutputStream?
        Stream.getStreamsToHost(withName: host, port: port, inputStream: &readStream, outputStream: &writeStream)
        guard let readStream, let writeStream else {
            throw Failure(message: "Spojení se serverem \(host) se nepodařilo navázat.")
        }
        input = readStream
        output = writeStream

        if tls { enableTLS() }
        readStream.open()
        writeStream.open()

        let deadline = Date().addingTimeInterval(timeout)
        while readStream.streamStatus == .opening || writeStream.streamStatus == .opening {
            if Date() > deadline { throw Failure(message: "Server \(host) neodpověděl včas.") }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if readStream.streamStatus == .error || writeStream.streamStatus == .error {
            throw Failure(message: readStream.streamError?.localizedDescription
                ?? "Spojení se serverem \(host) selhalo.")
        }
        applySocketTimeout(seconds: 60)
    }

    /// Zapne šifrování na už otevřeném spojení (STARTTLS).
    func upgradeToTLS() throws {
        guard input != nil, output != nil else { throw Failure(message: "Spojení není otevřené.") }
        enableTLS()
        // Po přepnutí je potřeba chvíli počkat, než proběhne dohoda o šifře
        Thread.sleep(forTimeInterval: 0.15)
        pending.removeAll()
    }

    private func enableTLS() {
        // Nastavení úrovně zabezpečení funguje před otevřením (šifrováno hned)
        // i po něm (povýšení přes STARTTLS) — proto obojí jedním způsobem.
        input?.setProperty(StreamSocketSecurityLevel.negotiatedSSL, forKey: .socketSecurityLevelKey)
        output?.setProperty(StreamSocketSecurityLevel.negotiatedSSL, forKey: .socketSecurityLevelKey)
    }

    /// Bez limitu by se čtení z mrtvého spojení nikdy nevrátilo.
    private func applySocketTimeout(seconds: Int) {
        let key = Stream.PropertyKey(kCFStreamPropertySocketNativeHandle.rawValue as String)
        guard let raw = input?.property(forKey: key) as? Data, raw.count >= 4 else { return }
        var handle: Int32 = 0
        withUnsafeMutableBytes(of: &handle) { buffer in
            raw.copyBytes(to: buffer.bindMemory(to: UInt8.self), count: 4)
        }
        guard handle > 0 else { return }
        var timeout = timeval(tv_sec: seconds, tv_usec: 0)
        setsockopt(handle, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(handle, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    }

    func close() {
        input?.close()
        output?.close()
        input = nil
        output = nil
        pending.removeAll()
    }

    // MARK: - Zápis

    func write(_ text: String) throws {
        try write(Data(text.utf8))
    }

    func write(_ data: Data) throws {
        guard let output else { throw Failure(message: "Spojení není otevřené.") }
        var sent = 0
        try data.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            while sent < data.count {
                let written = output.write(base + sent, maxLength: data.count - sent)
                if written <= 0 {
                    throw Failure(message: output.streamError?.localizedDescription
                        ?? "Odeslání dat serveru selhalo.")
                }
                sent += written
            }
        }
    }

    // MARK: - Čtení

    /// Jeden řádek bez `\r\n`.
    func readLine() throws -> String {
        while true {
            if let index = pending.firstIndex(of: 0x0A) {
                let line = pending.prefix(upTo: index)
                pending.removeSubrange(pending.startIndex...index)
                var bytes = Data(line)
                if bytes.last == 0x0D { bytes.removeLast() }
                return decode(bytes)
            }
            try fill()
        }
    }

    /// Přesný počet bajtů — IMAP takhle posílá literály (`{123}`).
    func read(count: Int) throws -> Data {
        while pending.count < count { try fill() }
        let out = Data(pending.prefix(count))
        pending.removeFirst(count)
        return out
    }

    private func fill() throws {
        guard let input else { throw Failure(message: "Spojení není otevřené.") }
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        let read = input.read(&chunk, maxLength: chunk.count)
        if read > 0 {
            pending.append(contentsOf: chunk[0..<read])
            return
        }
        if read == 0 { throw Failure(message: "Server \(host) spojení ukončil.") }
        throw Failure(message: input.streamError?.localizedDescription ?? "Čtení ze serveru selhalo.")
    }

    /// Hlavičky bývají v ASCII, ale některé servery pošlou i osmibitová data.
    private func decode(_ data: Data) -> String {
        String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin2)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
    }
}
