import Foundation

/**
 Instagram a Facebook — vnější rozhraní modulu.

 Odpovídá tomu, co na počítači dělá `src/main/instagram/index.ts`: skládá
 dohromady účty (`InstagramStore`), Graph API (`InstagramGraph`), úložiště
 (`InstagramMedia`), texty (`InstagramCaptions`) a frontu (`InstagramPublish`).
 Most volá jen odsud.

 Připojení účtu je aktér, protože si mezi dvěma voláními pamatuje rozdělané
 přihlášení — a to nesmí přepsat druhé volání z jiného vlákna.
 */
actor Instagram {
    static let shared = Instagram()

    private var pendingLang = ""
    private var pendingNonce = ""
    private var discovered: [IgGraph.Discovered] = []

    // MARK: - Připojení účtu

    func startConnect(lang: String) throws -> String {
        let code = lang.trimmingCharacters(in: .whitespaces).uppercased()
        guard !code.isEmpty else { throw BridgeError.message("Vyber trh, ke kterému účet patří.") }

        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(24)
        pendingLang = code
        pendingNonce = String(nonce)
        discovered = []

        let payload = ["lang": code, "n": pendingNonce]
        let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        return try IgGraph.authUrl(state: base64url(data))
    }

    /// Vynucené nové přihlášení: zahodí uložený přístup a vrátí adresu k otevření.
    func relogin(lang: String) throws -> String {
        IgStore.clearUserToken()
        return try startConnect(lang: lang)
    }

    /// Zpracuje odkaz `quentino-mail://ig-oauth?code=…` z prohlížeče.
    func handleCallback(url: URL) async throws -> [String: Any] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

        if let error = value("error_description") ?? value("error") {
            throw BridgeError.message("Přihlášení se nedokončilo: \(error)")
        }
        guard let code = value("code") else {
            throw BridgeError.message("Meta nevrátila přihlašovací kód.")
        }

        var lang = pendingLang
        if let state = value("state"), let data = fromBase64url(state),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if !pendingNonce.isEmpty, let nonce = parsed["n"] as? String, nonce != pendingNonce {
                throw BridgeError.message("Přihlášení nesouhlasí s tím, které aplikace začala.")
            }
            lang = parsed["lang"] as? String ?? lang
        }
        guard !lang.isEmpty else {
            throw BridgeError.message("Přihlášení nelze přiřadit k trhu — zkus to znovu z aplikace.")
        }

        let token = try await IgGraph.exchangeCode(code)
        return try await chooseAccount(lang: lang, token: token)
    }

    /// Náhradní cesta: uživatel vloží adresu z řádku prohlížeče ručně.
    func pasteCallback(_ raw: String) async throws -> [String: Any] {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text) else { throw BridgeError.message("Tohle nevypadá jako adresa.") }
        return try await handleCallback(url: url)
    }

    /// Ruční cesta: dlouhodobý token z Graph API Exploreru.
    func connectWithToken(lang: String, token: String) async throws -> [String: Any] {
        let code = lang.trimmingCharacters(in: .whitespaces).uppercased()
        guard !code.isEmpty else { throw BridgeError.message("Vyber trh, ke kterému účet patří.") }
        let raw = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { throw BridgeError.message("Vlož token.") }

        // Když se výměna nepovede (chybí App Secret), zkusíme token použít rovnou
        let longLived = (try? await IgGraph.exchangeLongLived(raw)) ?? raw
        _ = try await IgGraph.verifyToken(longLived)
        return try await chooseAccount(lang: code, token: longLived)
    }

    /**
     Přidání dalšího trhu bez nového přihlášení — použije uložený uživatelský
     token. `needsLogin` znamená, že žádný použitelný není.
     */
    func addMarket(lang: String) async throws -> [String: Any] {
        let code = lang.trimmingCharacters(in: .whitespaces).uppercased()
        guard !code.isEmpty else { throw BridgeError.message("Vyber trh, ke kterému účet patří.") }
        guard let token = IgStore.userToken() else { return ["needsLogin": true] }

        // Token vydaný před rozšířením oprávnění by se tvářil jako platný a selhal
        // by až při publikování na stránku — proto se rovnou zahodí.
        let missing = await IgGraph.missingScopes(token: token)
        if !missing.isEmpty {
            IgStore.clearUserToken()
            return ["needsLogin": true]
        }
        do {
            return try await chooseAccount(lang: code, token: token)
        } catch {
            if IgGraph.isTokenError(error) {
                IgStore.clearUserToken()
                return ["needsLogin": true]
            }
            throw error
        }
    }

    func finishConnect(igUserId: String) throws -> [String: Any] {
        guard !discovered.isEmpty else {
            throw BridgeError.message("Není co dokončovat — začni připojení znovu.")
        }
        guard let found = discovered.first(where: { $0.igUserId == igUserId }) else {
            throw BridgeError.message("Vybraný účet už není v nabídce.")
        }
        return save(lang: pendingLang, found)
    }

    private func chooseAccount(lang: String, token: String) async throws -> [String: Any] {
        let accounts = try await IgGraph.discoverAccounts(userToken: token)
        guard !accounts.isEmpty else {
            throw BridgeError.message(
                "Na žádné z tvých stránek není napojený Instagram účet typu Business nebo Creator."
            )
        }
        // Přístup si pamatujeme, aby další trh nepotřeboval znovu projít přihlášením
        IgStore.setUserToken(token, expires: Date().addingTimeInterval(Formats.days(59)))
        pendingLang = lang
        discovered = accounts

        if accounts.count == 1 { return ["saved": save(lang: lang, accounts[0])] }
        return ["pick": accounts.map {
            ["igUserId": $0.igUserId, "username": $0.username, "pageName": $0.pageName]
        }]
    }

    private func save(lang: String, _ account: IgGraph.Discovered) -> [String: Any] {
        let saved = IgStore.saveAccount(
            igUserId: account.igUserId,
            username: account.username.isEmpty ? account.pageName : account.username,
            lang: lang,
            token: account.pageToken,
            expires: Date().addingTimeInterval(Formats.days(59)),
            pageId: account.pageId,
            pageName: account.pageName,
            isSource: lang == "CS" && IgStore.sourceAccount() == nil
        )
        discovered = []
        Bridge.notify("ig:changed")
        return saved ?? [:]
    }

    private func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func fromBase64url(_ text: String) -> Data? {
        var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        return Data(base64Encoded: padded)
    }
}

// MARK: - Přehled, feed a příspěvky

extension Instagram {
    static func overview() -> [String: Any] {
        let accounts = IgStore.accounts()
        let jobs = IgStore.jobs(limit: 20)
        // Kolik účtů má přístup na spadnutí — obnova běží sama, ale když aplikace
        // dlouho neběžela nebo Meta obnovu odmítla, má to být vidět
        let soon = Date().addingTimeInterval(Formats.days(10))
        let expiring = accounts.filter { account in
            guard let date = Formats.date(account["tokenExpires"] as? String) else { return false }
            return date < soon
        }
        func state(_ value: String) -> Int {
            jobs.filter { ($0["state"] as? String) == value }.count
        }
        return [
            "accounts": accounts,
            "expiringSoon": expiring.count,
            "markets": IgStore.markets(),
            "brand": IgStore.brand(),
            "connection": IgStore.connectionState(),
            "storageReady": IgMedia.storageConfigured(),
            "queued": state("scheduled") + state("publishing"),
            "failed": state("failed"),
            "hasSource": IgStore.sourceAccount() != nil
        ]
    }

    static func saveConnection(_ patch: [String: Any]) -> [String: Any] {
        IgStore.saveSecrets(patch)
        return overview()
    }

    static func installCallback() async throws -> String {
        let url = try await IgMedia.installCallbackPage()
        IgStore.saveSecrets(["callbackUrl": url])
        return url
    }

    static func accountLimit(accountId: Int) async -> [String: Any]? {
        guard let account = IgStore.account(id: accountId),
              let token = try? IgStore.token(accountId: accountId) else { return nil }
        return await IgGraph.publishingLimit(igUserId: account["igUserId"] as? String ?? "", token: token)
    }

    // MARK: Náhledy

    private static var thumbDirectory: URL {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Quentino/ig-thumbs", isDirectory: true)
        _ = try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /**
     Náhled příspěvku ze zdrojového účtu. Odkazy na Instagram CDN vyprší,
     proto se první stažený náhled uloží na disk a pak už se bere odtamtud.
     */
    static func thumb(sourcePostId: Int) async -> String? {
        guard let row = IgStore.sourcePost(id: sourcePostId),
              let mediaId = row["ig_media_id"] as? String else { return nil }

        let file = thumbDirectory.appendingPathComponent("\(mediaId).jpg")
        if let cached = try? Data(contentsOf: file) {
            return "data:image/jpeg;base64,\(cached.base64EncodedString())"
        }

        guard let source = IgStore.sourceAccount(), let id = source["id"] as? Int,
              let token = try? IgStore.token(accountId: id),
              let info = try? await IgGraph.mediaUrls(igMediaId: mediaId, token: token) else { return nil }

        let children = (info["children"] as? [String: Any])?["data"] as? [[String: Any]] ?? []
        let address = info["thumbnail_url"] as? String
            ?? info["media_url"] as? String
            ?? children.first?["thumbnail_url"] as? String
            ?? children.first?["media_url"] as? String
        guard let address, let data = try? await IgMedia.download(address) else { return nil }

        _ = try? data.write(to: file)
        return "data:image/jpeg;base64,\(data.base64EncodedString())"
    }

    /// Náhled souboru vybraného do nového příspěvku.
    static func preview(path: String) -> String? {
        guard !IgMedia.isVideo(path), let data = try? IgMedia.read(path),
              data.count <= 12 * 1024 * 1024 else { return nil }
        return "data:\(IgMedia.mime(for: path));base64,\(data.base64EncodedString())"
    }

    // MARK: Příspěvky

    private static func mediaItems(_ files: [String]) -> [[String: Any]] {
        files.map { file in
            let mime = IgMedia.mime(for: file)
            let isVideo = mime.hasPrefix("video/")
            var item: [String: Any] = ["path": file, "mime": mime, "isVideo": isVideo]
            if !isVideo, let data = try? IgMedia.read(file), let size = IgMedia.imageSize(data) {
                item["width"] = size.width
                item["height"] = size.height
            }
            return item
        }
    }

    static func createDraft(files: [String], brief: String, mediaNote: String) throws -> [String: Any] {
        let postId = try IgStore.createPost(kind: "new", sourcePostId: nil, brief: brief, mediaNote: mediaNote)
        IgStore.setPostMedia(postId: postId, items: mediaItems(files))
        Bridge.notify("ig:changed")
        return IgStore.post(id: postId) ?? [:]
    }

    static func updateDraft(postId: Int, patch: [String: Any]) throws -> [String: Any] {
        IgStore.updatePost(id: postId, brief: patch["brief"] as? String, mediaNote: patch["mediaNote"] as? String)
        if let files = patch["files"] as? [String] {
            IgStore.setPostMedia(postId: postId, items: mediaItems(files))
        }
        guard let post = IgStore.post(id: postId) else { throw BridgeError.message("Příspěvek nenalezen.") }
        return post
    }

    /// Příspěvek převzatý z vlastního účtu — média zůstávají na Instagramu.
    static func createFromSource(sourcePostId: Int) throws -> [String: Any] {
        guard let row = IgStore.sourcePost(id: sourcePostId) else {
            throw BridgeError.message("Původní příspěvek nenalezen.")
        }
        if let existing = IgStore.postIdFromSource(sourcePostId), let post = IgStore.post(id: existing) {
            return post
        }

        var children: [[String: Any]] = []
        if let json = row["children_json"] as? String, let data = json.data(using: .utf8) {
            children = (try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
        }

        let items: [[String: Any]] = children.isEmpty
            ? [[
                "path": "", "mime": "",
                "isVideo": ["VIDEO", "REELS"].contains(row["media_type"] as? String ?? ""),
                "sourceUrl": "ig:\(row["ig_media_id"] as? String ?? "")"
              ]]
            : children.map { child in
                [
                    "path": "", "mime": "",
                    "isVideo": (child["media_type"] as? String) == "VIDEO",
                    "sourceUrl": "ig:\(child["id"] as? String ?? "")"
                ]
            }

        let postId = try IgStore.createPost(kind: "source", sourcePostId: sourcePostId, brief: "", mediaNote: "")
        IgStore.setPostMedia(postId: postId, items: items)
        Bridge.notify("ig:changed")
        return IgStore.post(id: postId) ?? [:]
    }

    /// Upozornění na poměr stran a formáty — ukazuje se před publikací.
    static func mediaWarnings(postId: Int) -> [String] {
        var out: [String] = []
        for item in IgStore.postMedia(postId: postId) {
            let path = item["path"] as? String ?? ""
            let name = path.isEmpty ? "médium" : (path as NSString).lastPathComponent
            if let width = item["width"] as? Int, let height = item["height"] as? Int,
               let warning = IgMedia.aspectWarning(width: width, height: height) {
                out.append("\(name): \(warning)")
            }
            let mime = item["mime"] as? String ?? ""
            if (item["is_video"] as? Int ?? 0) == 0, !mime.isEmpty,
               !["image/jpeg", "image/png"].contains(mime) {
                out.append("\(name): Instagram spolehlivě bere jen JPEG a PNG.")
            }
        }
        return out
    }

    // MARK: Generování

    /// Obrázky pro model: z disku, nebo stažené z Instagramu u převzatých příspěvků.
    private static func imagesForModel(_ post: [String: Any]) async -> [(mime: String, base64: String)] {
        var out: [(mime: String, base64: String)] = []
        let source = IgStore.sourceAccount()
        let token = (source?["id"] as? Int).flatMap { try? IgStore.token(accountId: $0) }

        for item in (post["media"] as? [[String: Any]] ?? []).prefix(3) {
            if (item["isVideo"] as? Bool ?? false) { continue }
            let path = item["path"] as? String ?? ""
            if !path.isEmpty {
                guard let data = try? IgMedia.read(path), data.count <= 4_700_000 else { continue }
                out.append((item["mime"] as? String ?? "image/jpeg", data.base64EncodedString()))
            } else if let raw = item["sourceUrl"] as? String, let token {
                let id = raw.hasPrefix("ig:") ? String(raw.dropFirst(3)) : raw
                guard let info = try? await IgGraph.mediaUrls(igMediaId: id, token: token),
                      let address = info["media_url"] as? String ?? info["thumbnail_url"] as? String,
                      let data = try? await IgMedia.download(address), data.count <= 4_700_000 else { continue }
                out.append(("image/jpeg", data.base64EncodedString()))
            }
        }
        return out
    }

    static func generate(postId: Int, langs: [String]) async throws -> [String: Any] {
        guard let post = IgStore.post(id: postId) else { throw BridgeError.message("Příspěvek nenalezen.") }
        let brand = IgStore.brand()

        let captions = try await IgCaptions.generate(IgCaptions.Input(
            mode: (post["kind"] as? String) == "source" ? "source" : "brief",
            brief: post["brief"] as? String ?? "",
            source: post["sourceCaption"] as? String ?? "",
            mediaNote: post["mediaNote"] as? String ?? "",
            langs: langs,
            variants: brand["variants"] as? Int ?? 2,
            images: await imagesForModel(post)
        ))

        IgStore.saveCaptions(postId: postId, captions: captions)
        Bridge.notify("ig:changed")
        return IgStore.post(id: postId) ?? [:]
    }

    /**
     Připraví prázdné popisky, aby se daly napsat ručně. Generování se tím
     nevylučuje — kdo si to rozmyslí, dá později Vygenerovat texty.
     */
    static func blankCaptions(postId: Int, langs: [String]) throws -> [String: Any] {
        guard !langs.isEmpty else { throw BridgeError.message("Vyber aspoň jeden trh.") }
        guard let post = IgStore.post(id: postId) else { throw BridgeError.message("Příspěvek nenalezen.") }

        let existing = Set((post["captions"] as? [[String: Any]] ?? []).compactMap { $0["lang"] as? String })
        let fresh = langs.filter { !existing.contains($0) }
        if fresh.isEmpty { return post }

        IgStore.saveCaptions(postId: postId, captions: fresh.map { (lang: $0, variants: [""]) })
        Bridge.notify("ig:changed")
        return IgStore.post(id: postId) ?? [:]
    }

    // MARK: Publikace

    /**
     Zařadí popisky příspěvku k publikaci. `force` pošle i ty, které už vyšly —
     hodí se, když se má stejný příspěvek zopakovat.
     */
    static func publishPost(postId: Int, at: String?, force: Bool, channels: String?) throws -> [String: Any] {
        guard let post = IgStore.post(id: postId) else { throw BridgeError.message("Příspěvek nenalezen.") }
        let captions = post["captions"] as? [[String: Any]] ?? []
        let published = captions.filter { ($0["status"] as? String) == "published" }.count

        if !force, published > 0, published == captions.count {
            throw BridgeError.message(
                "Příspěvek už vyšel na všech vybraných trzích. Zaškrtni „publikovat znovu\", pokud ho chceš zopakovat."
            )
        }

        var queued = 0
        var skipped: [String] = []
        for caption in captions {
            if !force, (caption["status"] as? String) == "published" { continue }
            guard let id = caption["id"] as? Int else { continue }
            do {
                try IgPublisher.schedule(captionId: id, at: at, channels: channels)
                queued += 1
            } catch {
                skipped.append("\(caption["lang"] as? String ?? ""): \(error.readableMessage)")
            }
        }
        if queued == 0, !skipped.isEmpty {
            throw BridgeError.message(skipped.joined(separator: "\n"))
        }
        return ["queued": queued, "skipped": skipped]
    }
}
