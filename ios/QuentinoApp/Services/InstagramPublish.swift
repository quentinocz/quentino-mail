import Foundation

/**
 Odbavení fronty: příprava médií, publikace a úklid.

 Fronta má stavy `scheduled` → `publishing` → `done` / `failed`. Běží vždy jen
 jedna položka, protože Meta na jednom účtu neschválí dva kontejnery naráz
 a při chybě je pak vidět, čeho se týkala.
 */
actor IgQueue {
    static let shared = IgQueue()

    private var running = false

    /**
     Chyby, u kterých má smysl to za chvíli zkusit znovu. Meta jimi hlásí
     i vlastní zádrhely při zpracování médií (řada 22070xx), takže první
     neúspěch neznamená, že je něco špatně s příspěvkem.
     */
    private static let transient = "2207076|2207001|2207053|2207032|Media upload has failed|Nahrání videa|Please try again|temporarily"
    private static let retryAfter: TimeInterval = 300
    private static let maxAttempts = 3

    // MARK: - Příprava médií

    /**
     Z každé položky příspěvku udělá veřejnou adresu, kterou si Meta stáhne.

     Do úložiště jde všechno — soubory z telefonu i média převzatá z vlastního
     účtu. Podstrčit Metě rovnou odkaz na její Instagram CDN se zdá jako
     zkratka, ale ty adresy jsou podepsané a časově omezené a její vlastní
     stahovač na nich selhává. Radši jednou stáhneme a nahrajeme k sobě;
     po zveřejnění se soubor z úložiště zase smaže.
     */
    private func resolveMedia(postId: Int, source: (id: Int, token: String)?) async throws -> [IgGraph.Media] {
        let rows = IgStore.postMedia(postId: postId)
        guard !rows.isEmpty else { throw BridgeError.message("Příspěvek nemá žádná média.") }

        var out: [IgGraph.Media] = []
        // Jedno video se Metě posílá přímo; karusel na to nemá, tam se použije adresa
        let directVideo = rows.count == 1 && (rows[0]["is_video"] as? Int ?? 0) == 1

        for row in rows {
            let isVideo = (row["is_video"] as? Int ?? 0) == 1
            let mediaId = row["id"] as? Int ?? 0
            let offset = row["cover_offset"] as? Double
            let publicUrl = row["public_url"] as? String ?? ""
            let sourceUrl = row["source_url"] as? String ?? ""

            if !sourceUrl.isEmpty {
                if !publicUrl.isEmpty {
                    out.append(IgGraph.Media(publicUrl: publicUrl, isVideo: isVideo, coverOffset: offset))
                    continue
                }
                guard let source else {
                    throw BridgeError.message("Není připojený zdrojový účet, ze kterého médium pochází.")
                }
                let igId = sourceUrl.hasPrefix("ig:") ? String(sourceUrl.dropFirst(3)) : sourceUrl

                var cdnUrl = ""
                do {
                    let info = try await IgGraph.mediaUrls(igMediaId: igId, token: source.token)
                    cdnUrl = info["media_url"] as? String ?? info["thumbnail_url"] as? String ?? ""
                } catch {
                    // Zneplatněný přístup se pozná u účtu, ne až u příspěvku
                    if IgGraph.isTokenError(error) {
                        IgStore.setAccountError(accountId: source.id, message: error.readableMessage)
                        throw BridgeError.message("Zdrojový účet je potřeba připojit znovu: \(error.readableMessage)")
                    }
                    throw BridgeError.message("Médium z původního příspěvku se nepodařilo načíst: \(error.readableMessage)")
                }
                guard !cdnUrl.isEmpty else {
                    throw BridgeError.message("Původní příspěvek nemá dostupné médium.")
                }

                let copy = try await IgMedia.download(cdnUrl)
                if directVideo {
                    // Do úložiště se video vůbec nedostane — jde rovnou Metě
                    out.append(IgGraph.Media(publicUrl: "", isVideo: isVideo, coverOffset: offset, data: copy))
                    continue
                }
                let key = "posts/\(postId)/\(mediaId)-\(Int(Date().timeIntervalSince1970)).\(isVideo ? "mp4" : "jpg")"
                let uploaded = try await IgMedia.upload(copy, key: key, mime: isVideo ? "video/mp4" : "image/jpeg")
                IgStore.setMediaPublicUrl(mediaId: mediaId, url: uploaded.publicUrl, key: uploaded.key)
                out.append(IgGraph.Media(publicUrl: uploaded.publicUrl, isVideo: isVideo, coverOffset: offset))
                continue
            }

            if !publicUrl.isEmpty {
                out.append(IgGraph.Media(publicUrl: publicUrl, isVideo: isVideo, coverOffset: offset))
                continue
            }

            let mime = row["mime"] as? String ?? ""
            let bytes = try IgMedia.read(row["path"] as? String ?? "")
            if directVideo {
                out.append(IgGraph.Media(publicUrl: "", isVideo: isVideo, coverOffset: offset, data: bytes))
                continue
            }
            let suffix = mime.split(separator: "/").last.map(String.init) ?? "bin"
            let clean = suffix.filter { $0.isLetter || $0.isNumber }
            let key = "posts/\(postId)/\(mediaId)-\(Int(Date().timeIntervalSince1970)).\(clean.isEmpty ? "bin" : clean)"
            let uploaded = try await IgMedia.upload(bytes, key: key, mime: mime)
            IgStore.setMediaPublicUrl(mediaId: mediaId, url: uploaded.publicUrl, key: uploaded.key)
            out.append(IgGraph.Media(publicUrl: uploaded.publicUrl, isVideo: isVideo, coverOffset: offset))
        }
        return out
    }

    /// Nahraná média se po vyřízení všech front smažou — Instagram už kopii má.
    private func cleanupPostMedia(postId: Int) async {
        guard IgStore.openJobs(postId: postId) == 0 else { return }
        for row in IgStore.postMedia(postId: postId) {
            guard let key = row["storage_key"] as? String, !key.isEmpty else { continue }
            await IgMedia.remove(key: key)
            IgStore.setMediaPublicUrl(mediaId: row["id"] as? Int ?? 0, url: nil, key: nil)
        }
    }

    private func sourceAccess() -> (id: Int, token: String)? {
        guard let source = IgStore.sourceAccount(), let id = source["id"] as? Int else { return nil }
        guard let token = try? IgStore.token(accountId: id) else { return nil }
        return (id, token)
    }

    // MARK: - Jedna položka fronty

    func runJob(_ jobId: Int) async {
        guard let job = IgStore.job(id: jobId) else { return }
        let captionId = job["caption_id"] as? Int ?? 0
        let accountId = job["account_id"] as? Int ?? 0
        let attempts = (job["attempts"] as? Int ?? 0) + 1

        guard let caption = IgStore.captionRow(id: captionId) else {
            IgStore.setJobState(id: jobId, [
                ("state", .text("failed")), ("error", .text("Popisek už neexistuje.")),
                ("finished_at", .text(Formats.iso()))
            ])
            Bridge.notify("ig:changed")
            return
        }
        let postId = caption["post_id"] as? Int ?? 0

        IgStore.setJobState(id: jobId, [
            ("state", .text("publishing")), ("started_at", .text(Formats.iso())),
            ("attempts", .int(Int64(attempts)))
        ])
        Bridge.notify("ig:changed")

        do {
            guard let account = IgStore.account(id: accountId) else {
                throw BridgeError.message("Cílový účet už není připojený.")
            }
            let channels = job["channels"] as? String ?? "ig"
            let toInstagram = channels.contains("ig")
            let toFacebook = channels.contains("fb")
            let pageId = account["pageId"] as? String ?? ""
            if toFacebook, pageId.isEmpty {
                throw BridgeError.message("U účtu není známá Facebook stránka — připoj ho znovu, doplní se.")
            }

            let token = try IgStore.token(accountId: accountId)
            let items = try await resolveMedia(postId: postId, source: sourceAccess())
            let text = IgStore.captionText(caption)

            if toInstagram {
                let result = try await IgGraph.publish(
                    igUserId: account["igUserId"] as? String ?? "", token: token, caption: text, media: items
                )
                IgStore.setJobState(id: jobId, [
                    ("state", .text("done")),
                    ("container_id", .text(result.containerId)),
                    ("ig_media_id", .text(result.igMediaId)),
                    ("permalink", result.permalink.map { SQLite.Value.text($0) } ?? .null),
                    ("error", .null),
                    ("finished_at", .text(Formats.iso()))
                ])
                IgStore.updateCaption(id: captionId, status: "published")
            } else {
                // Jen Facebook: na Instagramu nic nevzniká, popisek zůstává rozpracovaný
                IgStore.setJobState(id: jobId, [
                    ("state", .text("done")), ("error", .null), ("finished_at", .text(Formats.iso()))
                ])
            }
            IgStore.setAccountError(accountId: accountId, message: nil)

            if toFacebook {
                await shareOnFacebook(jobId: jobId, pageId: pageId, token: token, text: text, items: items)
            }
        } catch {
            let message = error.readableMessage
            let retryable = message.range(of: Self.transient, options: [.regularExpression, .caseInsensitive]) != nil

            if retryable, attempts < Self.maxAttempts, !IgGraph.isTokenError(error) {
                // Vrátí se do fronty; nahraná média zůstanou, položka je pořád otevřená
                IgStore.setJobState(id: jobId, [
                    ("state", .text("scheduled")),
                    ("error", .text("\(message) — zkusím to znovu za 5 minut (pokus \(attempts) z \(Self.maxAttempts)).")),
                    ("scheduled_at", .text(Formats.iso(Date().addingTimeInterval(Self.retryAfter)))),
                    ("started_at", .null)
                ])
            } else {
                IgStore.setJobState(id: jobId, [
                    ("state", .text("failed")), ("error", .text(message)), ("finished_at", .text(Formats.iso()))
                ])
            }
            // Když padl přístup k cílovému účtu, označí se u něj
            if IgGraph.isTokenError(error) {
                IgStore.setAccountError(accountId: accountId, message: message)
            }
        }

        await cleanupPostMedia(postId: postId)
        Bridge.notify("ig:changed")
    }

    /**
     Zveřejnění téhož obsahu na Facebook stránce. Neúspěch nemá vliv na
     příspěvek na Instagramu — jen se u položky poznamená, co chybělo.
     */
    private func shareOnFacebook(jobId: Int, pageId: String, token: String, text: String, items: [IgGraph.Media]) async {
        do {
            let postId = try await IgGraph.shareToPage(pageId: pageId, token: token, caption: text, media: items)
            IgStore.setJobState(id: jobId, [("fb_post_id", .text(postId)), ("fb_error", .null)])
        } catch {
            let message = error.readableMessage
            let scope = message.range(
                of: "permission|pages_read_engagement|pages_manage_posts",
                options: [.regularExpression, .caseInsensitive]
            ) != nil
            IgStore.setJobState(id: jobId, [("fb_error", .text(
                scope ? "\(message) — v Účtech dej u toho účtu „Rozšířit oprávnění\" a projdi přihlášení znovu."
                      : message
            ))])
        }
    }

    /// Zkusí sdílení na Facebook znovu u položky, která na Instagramu už vyšla.
    func retryFacebook(_ jobId: Int) async throws {
        guard let job = IgStore.job(id: jobId) else { throw BridgeError.message("Položka nenalezena.") }
        guard let caption = IgStore.captionRow(id: job["caption_id"] as? Int ?? 0) else {
            throw BridgeError.message("Popisek už neexistuje.")
        }
        let accountId = job["account_id"] as? Int ?? 0
        guard let account = IgStore.account(id: accountId) else {
            throw BridgeError.message("Účet už není připojený.")
        }
        let pageId = account["pageId"] as? String ?? ""
        guard !pageId.isEmpty else {
            throw BridgeError.message("U účtu není známá Facebook stránka — připoj ho znovu.")
        }
        let token = try IgStore.token(accountId: accountId)
        let postId = caption["post_id"] as? Int ?? 0

        do {
            let items = try await resolveMedia(postId: postId, source: sourceAccess())
            await shareOnFacebook(jobId: jobId, pageId: pageId, token: token,
                                  text: IgStore.captionText(caption), items: items)
            await cleanupPostMedia(postId: postId)
            Bridge.notify("ig:changed")
        } catch {
            await cleanupPostMedia(postId: postId)
            Bridge.notify("ig:changed")
            throw error
        }
    }

    func process() async {
        if running { return }
        running = true
        for job in IgStore.dueJobs(limit: 3) {
            await runJob(job["id"] as? Int ?? 0)
        }
        running = false
    }
}

/// Plánování a údržba — volá se z mostu i z pravidelné kontroly.
enum IgPublisher {
    /// Zařadí popisek na účet odpovídajícího trhu. Prázdné `at` znamená hned.
    @discardableResult
    static func schedule(captionId: Int, at: String?, channels: String?) throws -> Int {
        guard let caption = IgStore.captionRow(id: captionId) else {
            throw BridgeError.message("Popisek nenalezen.")
        }
        let lang = caption["lang"] as? String ?? ""
        guard let account = IgStore.account(lang: lang), let accountId = account["id"] as? Int else {
            throw BridgeError.message("Pro trh \(lang) není připojený žádný účet.")
        }

        // Bez výslovné volby platí nastavení účtu
        let target = channels ?? ((account["shareFb"] as? Bool ?? false) ? "ig+fb" : "ig")
        if target.contains("fb"), (account["pageId"] as? String ?? "").isEmpty {
            throw BridgeError.message("Účet \(lang) nemá známou Facebook stránku — připoj ho znovu.")
        }

        let text = IgStore.captionText(caption)
        // Limity 2 200 znaků a 30 hashtagů jsou instagramové, na Facebook se nevztahují
        if target.contains("ig") {
            try IgGraph.validateCaption(text)
        } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw BridgeError.message("Popisek je prázdný.")
        }

        let when = Formats.date(at) ?? Date()
        let id = try IgStore.enqueue(captionId: captionId, accountId: accountId,
                                     at: Formats.iso(when), channels: target)
        IgStore.updateCaption(id: captionId, status: "approved")
        Bridge.notify("ig:changed")
        if when <= Date() {
            Task { await IgQueue.shared.process() }
        }
        return id
    }

    /// Načte nové příspěvky ze zdrojového účtu.
    @discardableResult
    static func syncSource(full: Bool) async throws -> Int {
        guard let source = IgStore.sourceAccount(), let id = source["id"] as? Int else {
            throw BridgeError.message("Není připojený zdrojový účet.")
        }
        let token = try IgStore.token(accountId: id)
        let since = full ? nil : IgStore.newestSourceDate()
        let items = try await IgGraph.fetchHistory(
            igUserId: source["igUserId"] as? String ?? "", token: token, since: since
        )
        if !items.isEmpty { IgStore.upsertSourcePosts(items) }
        Bridge.notify("ig:changed")
        return items.count
    }

    /**
     Tokeny platí 60 dní a obnovují se samy, jakmile zbývá míň než 30 — to je
     dost velká rezerva na dovolenou i na týden bez zapnutého telefonu.
     Obnovuje se i uložený uživatelský přístup, jinak by po dvou měsících
     přestalo fungovat přidávání dalších účtů.
     */
    static func refreshTokens(force: Bool) async -> [String: Any] {
        var refreshed = 0
        var failed: [String] = []
        let horizon = Date().addingTimeInterval(Formats.days(30))
        let nextExpiry = Date().addingTimeInterval(Formats.days(59))

        if let userToken = IgStore.userToken(),
           let next = try? await IgGraph.exchangeLongLived(userToken) {
            IgStore.setUserToken(next, expires: nextExpiry)
        }

        for account in IgStore.accounts() {
            guard let id = account["id"] as? Int else { continue }
            let expires = Formats.date(account["tokenExpires"] as? String)
            if !force, let expires, expires > horizon { continue }
            do {
                let current = try IgStore.token(accountId: id)
                let next = try await IgGraph.exchangeLongLived(current)
                IgStore.setAccountToken(accountId: id, token: next, expires: nextExpiry)
                refreshed += 1
            } catch {
                IgStore.setAccountError(accountId: id, message: "Obnova přístupu selhala: \(error.readableMessage)")
                let label = account["username"] as? String ?? ""
                failed.append(label.isEmpty ? (account["lang"] as? String ?? "") : label)
            }
        }
        if refreshed > 0 || !failed.isEmpty { Bridge.notify("ig:changed") }
        return ["refreshed": refreshed, "failed": failed]
    }
}
