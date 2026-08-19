import Foundation

/**
 Meta Graph API.

 Publikace na Instagram má vždycky tři kroky: vytvoř kontejner s odkazem na
 médium, počkej, až ho Meta zpracuje, a zveřejni. Obrázek si Meta stahuje
 z veřejné adresy — přímý upload pro fotky neexistuje, proto je potřeba
 úložiště (viz `InstagramMedia.swift`). Video se naopak posílá přímo, protože
 stahování z cizí adresy Meta u videí zvládá nespolehlivě.

 Chování i hlášky se drží stolní verze (`src/main/instagram/graph.ts`), aby se
 stejná chyba na počítači i na telefonu jmenovala stejně.
 */
enum IgGraph {
    static let version = "v23.0"
    private static let base = "https://graph.facebook.com/v23.0"

    /// Jedna položka příspěvku připravená k odeslání Metě.
    struct Media {
        var publicUrl: String = ""
        var isVideo: Bool = false
        var coverOffset: Double?
        /// Bajty videa poslané Metě přímo — pro jedno video spolehlivější než adresa.
        var data: Data?
    }

    struct Failure: LocalizedError {
        let message: String
        let code: Int?
        var errorDescription: String? { message }
    }

    /**
     Chyby, po kterých nemá smysl nic zkoušet znovu — účet je potřeba připojit
     nanovo. 190 = zneplatněná session, 102 = vypršelá session, 463 = token po
     expiraci.
     */
    static func isTokenError(_ error: Error) -> Bool {
        if let failure = error as? Failure, let code = failure.code, [190, 102, 463].contains(code) { return true }
        let text = error.readableMessage
        return text.range(
            of: "access token|OAuthException|session has been invalidated|Přístup k účtu už neplatí",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    // MARK: - Volání

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    /// Kódování pro dotaz i pro tělo formuláře. `Http.escaped` tu nestačí —
    /// nechává projít `&` a `+`, což by rozbilo popisek s ampersandem.
    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    @discardableResult
    static func call(
        _ path: String,
        _ params: [String: String] = [:],
        token: String,
        method: String = "GET"
    ) async throws -> [String: Any] {
        var all = params
        // Výměna kódu za token se dělá bez přihlášení — prázdný parametr by Meta odmítla
        if !token.isEmpty { all["access_token"] = token }
        let query = all.map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&")

        let address = method == "GET" ? "\(base)/\(path)?\(query)" : "\(base)/\(path)"
        guard let url = URL(string: address) else {
            throw Failure(message: "Neplatná adresa dotazu na Metu.", code: nil)
        }
        var request = URLRequest(url: url, timeoutInterval: 180)
        request.httpMethod = method
        if method != "GET" {
            request.httpBody = query.data(using: .utf8)
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]

        if let error = object["error"] as? [String: Any] {
            let code = error["code"] as? Int
            let message = error["message"] as? String ?? "Meta požadavek odmítla."
            // Hláška od Mety je anglická a technická; u nejčastějších případů ji
            // nahradíme tím, co má uživatel udělat.
            let friendly: String
            if let code, [190, 102, 463].contains(code) {
                friendly = "Přístup k účtu už neplatí — Facebook session zneplatnil "
                    + "(typicky změna hesla nebo nově vydaný token). Připoj účet znovu."
            } else if let code {
                friendly = "\(message) (kód \(code))"
            } else {
                friendly = message
            }
            throw Failure(message: friendly, code: code)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Failure(message: "Meta odpověděla \(status).", code: status)
        }
        return object
    }

    // MARK: - Přihlášení a tokeny

    /**
     Oprávnění, bez kterých modul nefunguje celý. Poslední dvě jsou kvůli
     souběžnému sdílení na Facebook stránku — jsou v seznamu i pro toho, kdo ho
     nepoužívá, protože přidat je později znamená projít přihlášením znovu.
     */
    static let requiredScopes = [
        "instagram_basic",
        "instagram_content_publish",
        "pages_show_list",
        "business_management",
        "pages_manage_posts",
        "pages_read_engagement"
    ]

    /**
     Co tokenu chybí proti seznamu výše. Starý token vydaný před rozšířením
     oprávnění je jinak k nerozeznání od nového a pozná se to až chybou při
     publikování na stránku.
     */
    static func missingScopes(token: String) async -> [String] {
        do {
            let response = try await call("me/permissions", ["limit": "100"], token: token)
            let granted = Set(
                (response["data"] as? [[String: Any]] ?? [])
                    .filter { ($0["status"] as? String) == "granted" }
                    .compactMap { $0["permission"] as? String }
            )
            return requiredScopes.filter { !granted.contains($0) }
        } catch {
            return [] // když se to nepodaří zjistit, nebudeme uživateli stát v cestě
        }
    }

    static func authUrl(state: String) throws -> String {
        let secrets = IgStore.secrets()
        guard !secrets.appId.isEmpty else {
            throw BridgeError.message("Není vyplněné App ID Meta aplikace (Social → Účty → Připojení).")
        }
        guard !secrets.callbackUrl.isEmpty else {
            throw BridgeError.message("Není vyplněná adresa pro návrat z přihlášení.")
        }
        return "https://www.facebook.com/\(version)/dialog/oauth"
            + "?client_id=\(encode(secrets.appId))"
            + "&redirect_uri=\(encode(secrets.callbackUrl))"
            + "&scope=\(requiredScopes.joined(separator: ","))"
            + "&state=\(encode(state))&response_type=code"
    }

    /// Kód z přihlášení → krátkodobý token → dlouhodobý (60 dní).
    static func exchangeCode(_ code: String) async throws -> String {
        let secrets = IgStore.secrets()
        guard !secrets.appSecret.isEmpty else {
            throw BridgeError.message("Není vyplněný App Secret Meta aplikace.")
        }
        let short = try await call("oauth/access_token", [
            "client_id": secrets.appId,
            "client_secret": secrets.appSecret,
            "redirect_uri": secrets.callbackUrl,
            "code": code
        ], token: "")
        guard let token = short["access_token"] as? String else {
            throw BridgeError.message("Meta nevrátila přístupový token.")
        }
        return try await exchangeLongLived(token)
    }

    static func exchangeLongLived(_ token: String) async throws -> String {
        let secrets = IgStore.secrets()
        let long = try await call("oauth/access_token", [
            "grant_type": "fb_exchange_token",
            "client_id": secrets.appId,
            "client_secret": secrets.appSecret,
            "fb_exchange_token": token
        ], token: "")
        guard let next = long["access_token"] as? String else {
            throw BridgeError.message("Prodloužení přístupu se nepodařilo.")
        }
        return next
    }

    struct Discovered {
        let igUserId: String
        let username: String
        let pageId: String
        let pageName: String
        let pageToken: String
    }

    /**
     Najde všechny Instagram účty napojené na stránky, ke kterým dal uživatel
     přístup. Token stránky se používá k publikování — nevyprší dřív než ten
     uživatelský, ze kterého vznikl.
     */
    static func discoverAccounts(userToken: String) async throws -> [Discovered] {
        let response = try await call("me/accounts", [
            "fields": "id,name,access_token,instagram_business_account{id,username}",
            "limit": "100"
        ], token: userToken)

        var out: [Discovered] = []
        for page in response["data"] as? [[String: Any]] ?? [] {
            guard let linked = page["instagram_business_account"] as? [String: Any],
                  let igUserId = linked["id"] as? String,
                  let pageToken = page["access_token"] as? String else { continue }
            out.append(Discovered(
                igUserId: igUserId,
                username: linked["username"] as? String ?? "",
                pageId: page["id"] as? String ?? "",
                pageName: page["name"] as? String ?? "",
                pageToken: pageToken
            ))
        }
        return out
    }

    /// Ověření ručně vloženého tokenu — vrátí účty, ke kterým dává přístup.
    static func verifyToken(_ token: String) async throws -> [Discovered] {
        let accounts = try await discoverAccounts(userToken: token)
        guard !accounts.isEmpty else {
            throw BridgeError.message(
                "K tomuto tokenu nepatří žádná stránka s napojeným Instagram účtem typu Business nebo Creator."
            )
        }
        return accounts
    }

    // MARK: - Čtení zdrojového účtu

    private static let historyFields =
        "id,media_type,media_url,thumbnail_url,permalink,caption,timestamp,like_count,comments_count,"
        + "children{id,media_type,media_url,thumbnail_url}"

    static func fetchHistory(igUserId: String, token: String, since: String?, max: Int = 2000) async throws -> [[String: Any]] {
        var address: String? = "\(base)/\(igUserId)/media?fields=\(encode(historyFields))"
            + "&limit=50&access_token=\(encode(token))"
        var all: [[String: Any]] = []
        let limit = since.flatMap { Formats.date($0) }

        while let current = address, let url = URL(string: current) {
            let (data, _) = try await URLSession.shared.data(from: url)
            let page = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            if let error = page["error"] as? [String: Any] {
                throw Failure(message: error["message"] as? String ?? "Historii se nepodařilo načíst.",
                              code: error["code"] as? Int)
            }
            for item in page["data"] as? [[String: Any]] ?? [] {
                if let limit, let stamp = Formats.date(item["timestamp"] as? String ?? ""), stamp <= limit {
                    return all
                }
                all.append(item)
            }
            address = (page["paging"] as? [String: Any])?["next"] as? String
            if all.count >= max { break }
        }
        return all
    }

    /// Odkazy na média vyprší, proto se čtou až ve chvíli, kdy jsou potřeba.
    static func mediaUrls(igMediaId: String, token: String) async throws -> [String: Any] {
        try await call(igMediaId, [
            "fields": "media_type,media_url,thumbnail_url,children{id,media_type,media_url,thumbnail_url}"
        ], token: token)
    }

    // MARK: - Publikování

    private static func waitReady(container: String, token: String, maxSeconds: Double = 300) async throws {
        let started = Date()
        var wait: UInt64 = 3
        while Date().timeIntervalSince(started) < maxSeconds {
            try await Task.sleep(nanoseconds: wait * 1_000_000_000)
            wait = min(8, wait + 1)
            let status = try await call(container, ["fields": "status_code,status"], token: token)
            let code = status["status_code"] as? String ?? ""
            if code == "FINISHED" { return }
            if code == "ERROR" || code == "EXPIRED" {
                throw Failure(message: "Instagram odmítl médium: \(status["status"] as? String ?? code)", code: nil)
            }
        }
        throw Failure(message: "Zpracování média trvalo příliš dlouho. Zkus to znovu, nebo zmenši video.", code: nil)
    }

    /**
     Přímé odeslání videa Metě.

     Odesílání občas skončí čtyřstovkou bez bližšího vysvětlení a napodruhé
     projde beze změny — kontejner zřejmě chvíli po založení ještě není hotový.
     Proto tři pokusy s prodlevou.
     */
    private static func sendVideoBytes(to address: String, token: String, data: Data, what: String) async throws {
        guard let url = URL(string: address) else {
            throw Failure(message: "\(what) selhalo: neplatná adresa.", code: nil)
        }
        var last: Error?

        for wait in [0, 3, 8] {
            if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000_000) }

            var request = URLRequest(url: url, timeoutInterval: 600)
            request.httpMethod = "POST"
            request.setValue("OAuth \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("0", forHTTPHeaderField: "offset")
            request.setValue(String(data.count), forHTTPHeaderField: "file_size")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")

            let (body, response) = try await URLSession.shared.upload(for: request, from: data)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            let error = object["error"] as? [String: Any]

            if (200..<300).contains(status), error == nil, (object["success"] as? Bool) != false { return }

            // Detail z odpovědi je při hledání příčiny cennější než holé číslo stavu
            let detail = error?["message"] as? String
                ?? String(data: body, encoding: .utf8)?.prefix(200).description
                ?? ""
            let failure = Failure(
                message: "\(what) selhalo (\(status))\(detail.isEmpty ? "." : ": \(detail)")",
                code: error?["code"] as? Int ?? status
            )
            last = failure
            // Zamítnutí kvůli oprávnění nebo tokenu nemá smysl opakovat
            if status == 401 || status == 403 || isTokenError(failure) { break }
        }
        throw last ?? Failure(message: "\(what) selhalo.", code: nil)
    }

    static func validateCaption(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError.message("Popisek je prázdný.")
        }
        guard text.count <= 2200 else {
            throw BridgeError.message("Popisek má \(text.count) znaků, Instagram povoluje 2 200.")
        }
        let tags = text.filter { $0 == "#" }.count
        guard tags <= 30 else {
            throw BridgeError.message("Popisek má \(tags) hashtagů, Instagram povoluje 30.")
        }
    }

    struct Published {
        let containerId: String
        let igMediaId: String
        let permalink: String?
    }

    static func publish(igUserId: String, token: String, caption: String, media: [Media]) async throws -> Published {
        try validateCaption(caption)
        guard !media.isEmpty else { throw BridgeError.message("Příspěvek nemá žádná média.") }
        guard media.count <= 10 else { throw BridgeError.message("Karusel může mít nejvýš 10 položek.") }

        var containerId: String

        if media.count > 1 {
            var children: [String] = []
            for item in media {
                let params: [String: String] = item.isVideo
                    ? ["media_type": "VIDEO", "video_url": item.publicUrl, "is_carousel_item": "true"]
                    : ["image_url": item.publicUrl, "is_carousel_item": "true"]
                let created = try await call("\(igUserId)/media", params, token: token, method: "POST")
                guard let id = created["id"] as? String else {
                    throw Failure(message: "Instagram nezaložil položku karuselu.", code: nil)
                }
                if item.isVideo { try await waitReady(container: id, token: token) }
                children.append(id)
            }
            let created = try await call("\(igUserId)/media", [
                "media_type": "CAROUSEL", "children": children.joined(separator: ","), "caption": caption
            ], token: token, method: "POST")
            guard let id = created["id"] as? String else {
                throw Failure(message: "Instagram nezaložil karusel.", code: nil)
            }
            containerId = id
        } else {
            let item = media[0]
            var params: [String: String]
            if item.isVideo {
                params = item.data != nil
                    // Video putuje Metě přímo: kontejner se založí prázdný a bajty se pošlou zvlášť
                    ? ["media_type": "REELS", "upload_type": "resumable", "caption": caption, "share_to_feed": "true"]
                    : ["media_type": "REELS", "video_url": item.publicUrl, "caption": caption, "share_to_feed": "true"]
                if let offset = item.coverOffset {
                    params["thumb_offset"] = String(Int((offset * 1000).rounded()))
                }
            } else {
                params = ["image_url": item.publicUrl, "caption": caption]
            }
            let created = try await call("\(igUserId)/media", params, token: token, method: "POST")
            guard let id = created["id"] as? String else {
                throw Failure(message: "Instagram nezaložil příspěvek.", code: nil)
            }
            if item.isVideo, let bytes = item.data {
                try await sendVideoBytes(
                    to: "https://rupload.facebook.com/ig-api-upload/\(version)/\(id)",
                    token: token, data: bytes, what: "Nahrání videa"
                )
            }
            containerId = id
        }

        try await waitReady(container: containerId, token: token)
        let published = try await call("\(igUserId)/media_publish", ["creation_id": containerId],
                                       token: token, method: "POST")
        let mediaId = published["id"] as? String ?? ""

        var permalink: String?
        if !mediaId.isEmpty {
            // Odkaz je jen pro pohodlí, jeho selhání publikaci neruší
            permalink = (try? await call(mediaId, ["fields": "permalink"], token: token))?["permalink"] as? String
        }
        return Published(containerId: containerId, igMediaId: mediaId, permalink: permalink)
    }

    // MARK: - Souběžné sdílení na Facebook stránku

    /**
     Video na stránku přes Reels API.

     Starší cesta (`/{page}/videos`) vrací „No permission to publish the video"
     i s platnými oprávněními ke stránce — Meta ji pro tenhle případ opustila.
     Aktuální postup má tři kroky: založit relaci, poslat soubor, zveřejnit.
     */
    private static func shareReel(pageId: String, token: String, description: String, video: Media) async throws -> String {
        let start = try await call("\(pageId)/video_reels", ["upload_phase": "start"], token: token, method: "POST")
        guard let videoId = start["video_id"] as? String, !videoId.isEmpty else {
            throw Failure(message: "Facebook nezaložil nahrávání videa.", code: nil)
        }
        let uploadUrl = start["upload_url"] as? String
            ?? "https://rupload.facebook.com/video-upload/\(version)/\(videoId)"

        if let bytes = video.data {
            try await sendVideoBytes(to: uploadUrl, token: token, data: bytes, what: "Nahrání videa na stránku")
        } else if !video.publicUrl.isEmpty {
            // Soubor hostovaný jinde si Facebook stáhne sám podle hlavičky file_url
            guard let url = URL(string: uploadUrl) else {
                throw Failure(message: "Nahrání videa na stránku selhalo: neplatná adresa.", code: nil)
            }
            var request = URLRequest(url: url, timeoutInterval: 600)
            request.httpMethod = "POST"
            request.setValue("OAuth \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(video.publicUrl, forHTTPHeaderField: "file_url")
            let (body, response) = try await URLSession.shared.data(for: request)
            let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            if let error = object["error"] as? [String: Any] {
                throw Failure(message: error["message"] as? String ?? "Nahrání videa na stránku selhalo.",
                              code: error["code"] as? Int)
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                throw Failure(message: "Nahrání videa na stránku selhalo (\(status)).", code: status)
            }
        } else {
            throw Failure(message: "Video není odkud vzít.", code: nil)
        }

        try await call("\(pageId)/video_reels", [
            "video_id": videoId, "upload_phase": "finish", "video_state": "PUBLISHED", "description": description
        ], token: token, method: "POST")
        return videoId
    }

    /**
     Zveřejní stejný obsah na Facebook stránce, ke které je Instagram připojený.

     Fotky se nahrají jako nezveřejněné a připojí se k jednomu příspěvku, takže
     z karuselu vznikne album, ne pět samostatných příspěvků.
     */
    static func shareToPage(pageId: String, token: String, caption: String, media: [Media]) async throws -> String {
        let photos = media.filter { !$0.isVideo && !$0.publicUrl.isEmpty }
        if let video = media.first(where: { $0.isVideo }) {
            return try await shareReel(pageId: pageId, token: token, description: caption, video: video)
        }
        guard !photos.isEmpty else { throw Failure(message: "Není co na stránku sdílet.", code: nil) }

        if photos.count == 1 {
            let response = try await call("\(pageId)/photos",
                                          ["url": photos[0].publicUrl, "caption": caption],
                                          token: token, method: "POST")
            return response["post_id"] as? String ?? response["id"] as? String ?? ""
        }

        var ids: [String] = []
        for photo in photos {
            let uploaded = try await call("\(pageId)/photos",
                                          ["url": photo.publicUrl, "published": "false"],
                                          token: token, method: "POST")
            if let id = uploaded["id"] as? String { ids.append(id) }
        }
        var params: [String: String] = ["message": caption]
        for (index, id) in ids.enumerated() {
            params["attached_media[\(index)]"] = "{\"media_fbid\":\"\(id)\"}"
        }
        let response = try await call("\(pageId)/feed", params, token: token, method: "POST")
        return response["id"] as? String ?? ""
    }

    /// Kolik příspěvků účet za posledních 24 h publikoval přes API (limit je 100).
    static func publishingLimit(igUserId: String, token: String) async -> [String: Any]? {
        guard let response = try? await call("\(igUserId)/content_publishing_limit",
                                             ["fields": "quota_usage,config"], token: token),
              let row = (response["data"] as? [[String: Any]])?.first else { return nil }
        let cap = (row["config"] as? [String: Any])?["quota_total"] as? Int ?? 100
        return ["used": row["quota_usage"] as? Int ?? 0, "cap": cap]
    }
}
