import Foundation

/**
 Úložiště médií a práce se soubory.

 Instagram si obrázek stahuje z veřejné adresy, takže soubor z telefonu je
 nutné někam nahrát. Výchozí je Supabase Storage — jeden veřejný „bucket",
 nahrání je jedno HTTP volání a nepotřebuje žádný vlastní server. Rozhraní je
 záměrně úzké (`upload`, `remove`), aby šlo úložiště vyměnit za vlastní
 hosting nebo S3.

 Po úspěšném zveřejnění se soubor z úložiště maže — Instagram už kopii má
 a bezplatný tarif zůstává skoro prázdný.
 */
enum IgMedia {
    struct Uploaded {
        let publicUrl: String
        let key: String
    }

    private static func storage() throws -> IgStore.Connection {
        let secrets = IgStore.secrets()
        guard !secrets.storageUrl.isEmpty, !secrets.storageKey.isEmpty else {
            throw BridgeError.message("Není nastavené úložiště médií (Social → Účty → Úložiště médií).")
        }
        return secrets
    }

    static func storageConfigured() -> Bool {
        let secrets = IgStore.secrets()
        return !secrets.storageUrl.isEmpty && !secrets.storageKey.isEmpty
    }

    private static func headers(_ secrets: IgStore.Connection, _ extra: [String: String] = [:]) -> [String: String] {
        var all = ["apikey": secrets.storageKey, "Authorization": "Bearer \(secrets.storageKey)"]
        for (key, value) in extra { all[key] = value }
        return all
    }

    /// Založí veřejný bucket, pokud ještě není. Volá se před prvním nahráním.
    static func ensureBucket() async throws {
        let secrets = try storage()
        let name = IgGraph.encode(secrets.storageBucket)
        if (try? await Http.request("\(secrets.storageUrl)/storage/v1/bucket/\(name)",
                                    headers: headers(secrets))) != nil { return }
        do {
            _ = try await Http.request(
                "\(secrets.storageUrl)/storage/v1/bucket",
                method: "POST",
                headers: headers(secrets, ["Content-Type": "application/json"]),
                body: try JSONSerialization.data(withJSONObject: [
                    "id": secrets.storageBucket, "name": secrets.storageBucket, "public": true
                ])
            )
        } catch let failure as Http.Failure {
            // Souběžné založení dvěma cestami není chyba
            guard failure.body.range(of: "already exists|Duplicate", options: [.regularExpression, .caseInsensitive]) != nil else {
                throw BridgeError.message("Úložiště se nepodařilo připravit: \(failure.body.prefix(200))")
            }
        }
    }

    static func upload(_ data: Data, key: String, mime: String) async throws -> Uploaded {
        let secrets = try storage()
        try await ensureBucket()
        let bucket = IgGraph.encode(secrets.storageBucket)
        let address = "\(secrets.storageUrl)/storage/v1/object/\(bucket)/\(key)"
        guard let url = URL(string: address) else {
            throw BridgeError.message("Neplatná adresa úložiště.")
        }

        var request = URLRequest(url: url, timeoutInterval: 600)
        request.httpMethod = "POST"
        for (name, value) in headers(secrets, [
            "Content-Type": mime.isEmpty ? "application/octet-stream" : mime,
            "x-upsert": "true"
        ]) { request.setValue(value, forHTTPHeaderField: name) }

        let (body, response) = try await URLSession.shared.upload(for: request, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        if status == 413 {
            throw BridgeError.message(
                "Soubor má \(data.count / 1024 / 1024) MB a úložiště víc nedovolí. "
                + "Supabase má ve výchozím stavu limit 50 MB na soubor — zvedni ho v Settings → Storage, "
                + "nebo video zkrať."
            )
        }
        guard (200..<300).contains(status) else {
            let detail = String(data: body, encoding: .utf8) ?? ""
            throw BridgeError.message("Nahrání média selhalo: \(detail.prefix(200))")
        }
        return Uploaded(
            publicUrl: "\(secrets.storageUrl)/storage/v1/object/public/\(bucket)/\(key)",
            key: key
        )
    }

    static func remove(key: String) async {
        guard let secrets = try? storage() else { return }
        let bucket = IgGraph.encode(secrets.storageBucket)
        // Úklid nesmí shodit publikaci, proto se chyba jen spolkne
        _ = try? await Http.request("\(secrets.storageUrl)/storage/v1/object/\(bucket)/\(key)",
                                    method: "DELETE", headers: headers(secrets))
    }

    /// Zkušební nahrání a smazání — ověří adresu, klíč i veřejnost bucketu.
    static func testStorage() async throws -> String {
        let probe = Data("quentino".utf8)
        let uploaded = try await upload(probe, key: "test/\(Int(Date().timeIntervalSince1970)).txt", mime: "text/plain")
        let readable = (try? await Http.request(uploaded.publicUrl)).map {
            String(data: $0, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "quentino"
        } ?? false
        await remove(key: uploaded.key)
        guard readable else {
            throw BridgeError.message("Soubor se nahrál, ale není veřejně čitelný — bucket musí být „public\".")
        }
        return "Úložiště funguje, soubory jsou veřejně dostupné."
    }

    // MARK: - Stránka pro návrat z přihlášení

    private static let callbackHtml = """
    <!doctype html>
    <html lang="cs"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Quentino App — připojení účtu</title>
    <style>
     body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#201d29;
          background:#f6f5f8;margin:0;display:grid;place-items:center;height:100vh;text-align:center}
     .box{background:#fff;padding:34px 38px;border-radius:14px;box-shadow:0 8px 40px rgba(32,29,41,.12);max-width:420px}
     h1{font-size:17px;margin:0 0 10px}
     p{color:#6b6579;margin:0 0 16px}
     a.btn{display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600}
     code{display:block;word-break:break-all;background:#f6f5f8;padding:10px;border-radius:8px;font-size:12px;margin-top:14px;color:#201d29}
    </style></head>
    <body><div class="box">
     <h1>Účet je ověřený</h1>
     <p>Vrať se do Quentino App — okno se za chvíli zavře samo.</p>
     <a class="btn" id="open" href="#">Otevřít Quentino App</a>
     <code id="fallback" hidden></code>
    </div>
    <script>
     var q = location.search.slice(1);
     var deep = 'quentino-mail://ig-oauth?' + q;
     document.getElementById('open').href = deep;
     document.getElementById('fallback').textContent = deep;
     try { location.replace(deep); } catch (e) {}
     setTimeout(function () { document.getElementById('fallback').hidden = false; }, 2500);
     setTimeout(function () { window.close(); }, 1800);
    </script></body></html>
    """

    /**
     Nahraje návratovou stránku do úložiště a vrátí její adresu. Tu pak stačí
     vložit do Meta aplikace jako „Valid OAuth Redirect URI".

     Charset je uvedený výslovně: bez něj některá úložiště pošlou stránku jako
     čistý text a prohlížeč zobrazí zdrojový kód místo stránky.
     */
    static func installCallbackPage() async throws -> String {
        let uploaded = try await upload(Data(callbackHtml.utf8),
                                        key: "oauth/callback.html",
                                        mime: "text/html; charset=utf-8")
        return uploaded.publicUrl
    }

    // MARK: - Soubory

    private static let mimeByExtension: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic",
        "webp": "image/webp", "mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v"
    ]

    static func mime(for path: String) -> String {
        mimeByExtension[(path as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
    }

    static func isVideo(_ path: String) -> Bool {
        mime(for: path).hasPrefix("video/")
    }

    /// Složka, do které se kopírují média vybraná z fotek — z původního
    /// umístění by se po zavření výběru už nedala číst.
    static var mediaDirectory: URL {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Quentino/ig-media", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func read(_ path: String) throws -> Data {
        let url = URL(fileURLWithPath: path)
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        guard size <= 300 * 1024 * 1024 else {
            throw BridgeError.message("Soubor je větší než 300 MB.")
        }
        return try Data(contentsOf: url)
    }

    static func download(_ address: String) async throws -> Data {
        do {
            return try await Http.request(address, timeout: 300)
        } catch {
            throw BridgeError.message("Médium se nepodařilo stáhnout: \(error.readableMessage)")
        }
    }

    /// Rozměry obrázku z hlavičky souboru — bez knihovny, jen JPEG, PNG a WebP.
    static func imageSize(_ data: Data) -> (width: Int, height: Int)? {
        let bytes = [UInt8](data)
        func be16(_ index: Int) -> Int { Int(bytes[index]) << 8 | Int(bytes[index + 1]) }
        func be32(_ index: Int) -> Int {
            Int(bytes[index]) << 24 | Int(bytes[index + 1]) << 16 | Int(bytes[index + 2]) << 8 | Int(bytes[index + 3])
        }
        func le16(_ index: Int) -> Int { Int(bytes[index]) | Int(bytes[index + 1]) << 8 }
        func le32(_ index: Int) -> Int {
            Int(bytes[index]) | Int(bytes[index + 1]) << 8 | Int(bytes[index + 2]) << 16 | Int(bytes[index + 3]) << 24
        }
        func ascii(_ from: Int, _ to: Int) -> String {
            String(bytes: bytes[from..<to], encoding: .ascii) ?? ""
        }

        // PNG
        if bytes.count > 24, be32(0) == 0x8950_4E47 {
            return (be32(16), be32(20))
        }
        // WebP
        if bytes.count > 30, ascii(0, 4) == "RIFF", ascii(8, 12) == "WEBP" {
            switch ascii(12, 16) {
            case "VP8X":
                return ((Int(bytes[24]) | Int(bytes[25]) << 8 | Int(bytes[26]) << 16) + 1,
                        (Int(bytes[27]) | Int(bytes[28]) << 8 | Int(bytes[29]) << 16) + 1)
            case "VP8 ":
                return (le16(26) & 0x3FFF, le16(28) & 0x3FFF)
            case "VP8L":
                let value = le32(21)
                return ((value & 0x3FFF) + 1, ((value >> 14) & 0x3FFF) + 1)
            default: break
            }
        }
        // JPEG — projít značky až k SOFn
        if bytes.count > 4, bytes[0] == 0xFF, bytes[1] == 0xD8 {
            var index = 2
            while index < bytes.count - 9 {
                if bytes[index] != 0xFF { index += 1; continue }
                let marker = bytes[index + 1]
                let length = be16(index + 2)
                if marker >= 0xC0, marker <= 0xCF, marker != 0xC4, marker != 0xC8, marker != 0xCC {
                    return (be16(index + 7), be16(index + 5))
                }
                if length <= 0 { break }
                index += 2 + length
            }
        }
        return nil
    }

    /// Poměr stran, který Instagram u příspěvků přijímá (4:5 až 1.91:1).
    static func aspectWarning(width: Int, height: Int) -> String? {
        guard width > 0, height > 0 else { return nil }
        let ratio = Double(width) / Double(height)
        let text = String(format: "%.2f", ratio)
        if ratio < 0.8 { return "Poměr stran \(text):1 je na výšku víc než 4:5 — Instagram obrázek ořízne." }
        if ratio > 1.91 { return "Poměr stran \(text):1 je širší než 1.91:1 — Instagram obrázek ořízne." }
        return nil
    }
}
