import Foundation

/**
 Příspěvky, popisky a fronta publikací.

 Druhá polovina toho, co na počítači dělá `src/main/instagram/store.ts`.
 Dotazy jsou schválně stejné — díky tomu sedí data i po přenesení zálohy
 z jednoho zařízení na druhé.
 */
extension IgStore {
    // MARK: - Zdrojové příspěvky

    @discardableResult
    static func upsertSourcePosts(_ items: [[String: Any]]) -> Int {
        try? SQLite.shared.transaction {
            for item in items {
                let children = (item["children"] as? [String: Any])?["data"] as? [[String: Any]] ?? []
                let childrenJson = (try? JSONSerialization.data(withJSONObject: children))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                try SQLite.shared.run(
                    """
                    INSERT INTO ig_source_posts (ig_media_id, media_type, permalink, caption, posted_at,
                      like_count, comment_count, children_json)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(ig_media_id) DO UPDATE SET
                      caption = excluded.caption, like_count = excluded.like_count,
                      comment_count = excluded.comment_count, children_json = excluded.children_json
                    """,
                    [
                        .text(item["id"] as? String ?? ""),
                        .text(item["media_type"] as? String ?? "IMAGE"),
                        .text(item["permalink"] as? String ?? ""),
                        .text(item["caption"] as? String ?? ""),
                        .text(item["timestamp"] as? String ?? ""),
                        .int(Int64(item["like_count"] as? Int ?? 0)),
                        .int(Int64(item["comments_count"] as? Int ?? 0)),
                        .text(childrenJson)
                    ]
                )
            }
        }
        return items.count
    }

    static func newestSourceDate() -> String? {
        let rows = (try? SQLite.shared.query(
            "SELECT posted_at FROM ig_source_posts ORDER BY posted_at DESC LIMIT 1"
        )) ?? []
        return rows.first?["posted_at"] as? String
    }

    /// Feed pro rozhraní i s tím, které trhy už příspěvek dostaly.
    static func sourcePosts(limit: Int, offset: Int) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM ig_source_posts ORDER BY posted_at DESC LIMIT ? OFFSET ?",
            [.int(Int64(limit)), .int(Int64(offset))]
        )) ?? []
        if rows.isEmpty { return [] }

        let states = (try? SQLite.shared.query(
            """
            SELECT p.source_post_id AS sid, c.lang AS lang, c.status AS status,
                   (SELECT state FROM ig_jobs j WHERE j.caption_id = c.id ORDER BY j.id DESC LIMIT 1) AS job
            FROM ig_posts p JOIN ig_captions c ON c.post_id = p.id
            WHERE p.source_post_id IS NOT NULL
            """
        )) ?? []

        var done: [Int: [String]] = [:]
        var pending: [Int: [String]] = [:]
        for state in states {
            guard let sid = state["sid"] as? Int, let lang = state["lang"] as? String else { continue }
            if (state["status"] as? String) == "published" || (state["job"] as? String) == "done" {
                done[sid, default: []].append(lang)
            } else {
                pending[sid, default: []].append(lang)
            }
        }

        return rows.map { row in
            let id = row["id"] as? Int ?? 0
            var children = 0
            if let json = row["children_json"] as? String, let data = json.data(using: .utf8),
               let list = try? JSONSerialization.jsonObject(with: data) as? [Any] {
                children = list.count
            }
            return [
                "id": id,
                "igMediaId": row["ig_media_id"] ?? "",
                "mediaType": row["media_type"] ?? "IMAGE",
                "permalink": row["permalink"] ?? "",
                "caption": row["caption"] ?? "",
                "postedAt": row["posted_at"] ?? "",
                "likeCount": row["like_count"] ?? 0,
                "commentCount": row["comment_count"] ?? 0,
                "childCount": children,
                "done": done[id] ?? [],
                "pending": pending[id] ?? []
            ]
        }
    }

    static func sourcePost(id: Int) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM ig_source_posts WHERE id = ?", [.int(Int64(id))]))?.first
    }

    // MARK: - Příspěvky a média

    static func createPost(kind: String, sourcePostId: Int?, brief: String, mediaNote: String) throws -> Int {
        let result = try SQLite.shared.run(
            "INSERT INTO ig_posts (kind, source_post_id, brief, media_note) VALUES (?,?,?,?)",
            [
                .text(kind),
                sourcePostId.map { SQLite.Value.int(Int64($0)) } ?? .null,
                .text(brief), .text(mediaNote)
            ]
        )
        return Int(result.lastId)
    }

    static func updatePost(id: Int, brief: String?, mediaNote: String?) {
        if let brief {
            try? SQLite.shared.run("UPDATE ig_posts SET brief = ? WHERE id = ?", [.text(brief), .int(Int64(id))])
        }
        if let mediaNote {
            try? SQLite.shared.run("UPDATE ig_posts SET media_note = ? WHERE id = ?", [.text(mediaNote), .int(Int64(id))])
        }
    }

    static func setPostMedia(postId: Int, items: [[String: Any]]) {
        try? SQLite.shared.transaction {
            try SQLite.shared.run("DELETE FROM ig_post_media WHERE post_id = ?", [.int(Int64(postId))])
            for (index, item) in items.enumerated() {
                try SQLite.shared.run(
                    """
                    INSERT INTO ig_post_media (post_id, position, path, mime, is_video, width, height,
                      cover_offset, source_url)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    [
                        .int(Int64(postId)), .int(Int64(index)),
                        .text(item["path"] as? String ?? ""),
                        .text(item["mime"] as? String ?? ""),
                        .int((item["isVideo"] as? Bool ?? false) ? 1 : 0),
                        (item["width"] as? Int).map { SQLite.Value.int(Int64($0)) } ?? .null,
                        (item["height"] as? Int).map { SQLite.Value.int(Int64($0)) } ?? .null,
                        (item["coverOffset"] as? Double).map { SQLite.Value.double($0) } ?? .null,
                        (item["sourceUrl"] as? String).map { SQLite.Value.text($0) } ?? .null
                    ]
                )
            }
        }
    }

    static func postMedia(postId: Int) -> [[String: Any]] {
        (try? SQLite.shared.query(
            "SELECT * FROM ig_post_media WHERE post_id = ? ORDER BY position", [.int(Int64(postId))]
        )) ?? []
    }

    static func setMediaPublicUrl(mediaId: Int, url: String?, key: String?) {
        try? SQLite.shared.run(
            "UPDATE ig_post_media SET public_url = ?, storage_key = ? WHERE id = ?",
            [
                url.map { SQLite.Value.text($0) } ?? .null,
                key.map { SQLite.Value.text($0) } ?? .null,
                .int(Int64(mediaId))
            ]
        )
    }

    // MARK: - Popisky

    /// Opakované generování nepřepíše popisek, který už vyšel — proto ta
    /// podmínka na konci `ON CONFLICT`.
    static func saveCaptions(postId: Int, captions: [(lang: String, variants: [String])]) {
        try? SQLite.shared.transaction {
            for caption in captions {
                let json = (try? JSONSerialization.data(withJSONObject: caption.variants))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
                try SQLite.shared.run(
                    """
                    INSERT INTO ig_captions (post_id, lang, variants_json, chosen, status, updated_at)
                    VALUES (?,?,?,0,'draft',datetime('now'))
                    ON CONFLICT(post_id, lang) DO UPDATE SET
                      variants_json = excluded.variants_json, chosen = 0, edited = NULL,
                      status = 'draft', updated_at = datetime('now')
                    WHERE ig_captions.status != 'published'
                    """,
                    [.int(Int64(postId)), .text(caption.lang), .text(json)]
                )
            }
        }
    }

    static func updateCaption(id: Int, chosen: Int? = nil, edited: String? = nil, status: String? = nil) {
        if let chosen {
            try? SQLite.shared.run(
                "UPDATE ig_captions SET chosen = ?, edited = NULL, updated_at = datetime('now') WHERE id = ?",
                [.int(Int64(chosen)), .int(Int64(id))]
            )
        }
        if let edited {
            // Prázdný text znamená „zruš ruční přepis" — vrátí se vybraná varianta
            try? SQLite.shared.run(
                "UPDATE ig_captions SET edited = ?, updated_at = datetime('now') WHERE id = ?",
                [edited.isEmpty ? .null : .text(edited), .int(Int64(id))]
            )
        }
        if let status {
            try? SQLite.shared.run("UPDATE ig_captions SET status = ? WHERE id = ?",
                                   [.text(status), .int(Int64(id))])
        }
    }

    static func captionRow(id: Int) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM ig_captions WHERE id = ?", [.int(Int64(id))]))?.first
    }

    static func variants(_ row: [String: Any]) -> [String] {
        guard let json = row["variants_json"] as? String, let data = json.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return list.compactMap { $0 as? String }
    }

    /// Text, který se opravdu publikuje: ruční přepis má přednost před variantou.
    static func captionText(_ row: [String: Any]) -> String {
        if let edited = row["edited"] as? String, !edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return edited
        }
        let list = variants(row)
        let chosen = row["chosen"] as? Int ?? 0
        if chosen >= 0, chosen < list.count { return list[chosen] }
        return list.first ?? ""
    }

    private static func caption(_ row: [String: Any]) -> [String: Any] {
        let edited = row["edited"] as? String ?? ""
        return [
            "id": row["id"] ?? 0,
            "lang": row["lang"] ?? "",
            "variants": variants(row),
            "chosen": row["chosen"] ?? 0,
            "text": captionText(row),
            "status": row["status"] ?? "draft",
            "edited": !edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ]
    }

    static func post(id: Int) -> [String: Any]? {
        guard let row = (try? SQLite.shared.query("SELECT * FROM ig_posts WHERE id = ?", [.int(Int64(id))]))?.first
        else { return nil }

        let media = postMedia(postId: id).map { item -> [String: Any] in
            [
                "id": item["id"] ?? 0,
                "path": item["path"] ?? "",
                "mime": item["mime"] ?? "",
                "isVideo": (item["is_video"] as? Int ?? 0) == 1,
                "width": item["width"] ?? NSNull(),
                "height": item["height"] ?? NSNull(),
                "coverOffset": item["cover_offset"] ?? NSNull(),
                "sourceUrl": item["source_url"] ?? NSNull()
            ]
        }
        let captions = ((try? SQLite.shared.query(
            "SELECT * FROM ig_captions WHERE post_id = ? ORDER BY lang", [.int(Int64(id))]
        )) ?? []).map(caption)

        let source = (row["source_post_id"] as? Int).flatMap { sourcePost(id: $0) }
        return [
            "id": row["id"] ?? 0,
            "kind": row["kind"] ?? "new",
            "sourcePostId": row["source_post_id"] ?? NSNull(),
            "brief": row["brief"] ?? "",
            "mediaNote": row["media_note"] ?? "",
            "createdAt": row["created_at"] ?? "",
            "media": media,
            "captions": captions,
            "sourceCaption": (source?["caption"] as? String) ?? "",
            "sourcePermalink": (source?["permalink"] as? String) ?? ""
        ]
    }

    static func drafts() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT p.id FROM ig_posts p
            WHERE p.archived = 0
              AND EXISTS (SELECT 1 FROM ig_captions c WHERE c.post_id = p.id AND c.status != 'published')
            ORDER BY p.created_at DESC LIMIT 40
            """
        )) ?? []
        return rows.compactMap { ($0["id"] as? Int).flatMap { post(id: $0) } }
    }

    static func deletePost(id: Int) {
        try? SQLite.shared.run("DELETE FROM ig_posts WHERE id = ?", [.int(Int64(id))])
    }

    static func postIdFromSource(_ sourcePostId: Int) -> Int? {
        (try? SQLite.shared.query(
            "SELECT id FROM ig_posts WHERE source_post_id = ? ORDER BY id DESC LIMIT 1",
            [.int(Int64(sourcePostId))]
        ))?.first?["id"] as? Int
    }

    // MARK: - Fronta publikací

    static func enqueue(captionId: Int, accountId: Int, at: String, channels: String) throws -> Int {
        let result = try SQLite.shared.run(
            "INSERT INTO ig_jobs (caption_id, account_id, state, scheduled_at, channels) VALUES (?,?,'scheduled',?,?)",
            [.int(Int64(captionId)), .int(Int64(accountId)), .text(at), .text(channels)]
        )
        return Int(result.lastId)
    }

    static func dueJobs(limit: Int = 3) -> [[String: Any]] {
        (try? SQLite.shared.query(
            "SELECT * FROM ig_jobs WHERE state = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?",
            [.text(Formats.iso()), .int(Int64(limit))]
        )) ?? []
    }

    static func job(id: Int) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM ig_jobs WHERE id = ?", [.int(Int64(id))]))?.first
    }

    /// Částečná změna položky fronty. Pořadí dvojic určuje pořadí v SQL, takže
    /// se výsledek dá při ladění přečíst.
    static func setJobState(id: Int, _ patch: [(String, SQLite.Value)]) {
        guard !patch.isEmpty else { return }
        let assignments = patch.map { "\($0.0) = ?" }.joined(separator: ", ")
        var values = patch.map { $0.1 }
        values.append(.int(Int64(id)))
        try? SQLite.shared.run("UPDATE ig_jobs SET \(assignments) WHERE id = ?", values)
    }

    static func jobs(limit: Int = 80) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT j.*, c.lang AS lang, c.post_id AS post_id, c.variants_json, c.chosen, c.edited,
                   a.username AS username, a.color AS color
            FROM ig_jobs j
            JOIN ig_captions c ON c.id = j.caption_id
            JOIN ig_accounts a ON a.id = j.account_id
            ORDER BY CASE j.state WHEN 'publishing' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
                     j.scheduled_at DESC LIMIT ?
            """,
            [.int(Int64(limit))]
        )) ?? []

        return rows.map { row in
            [
                "id": row["id"] ?? 0,
                "captionId": row["caption_id"] ?? 0,
                "postId": row["post_id"] ?? 0,
                "lang": row["lang"] ?? "",
                "username": row["username"] ?? "",
                "color": row["color"] ?? "#7c5cff",
                "state": row["state"] ?? "scheduled",
                "scheduledAt": row["scheduled_at"] ?? "",
                "finishedAt": row["finished_at"] ?? NSNull(),
                "permalink": row["permalink"] ?? NSNull(),
                "error": row["error"] ?? NSNull(),
                "fbPostId": row["fb_post_id"] ?? NSNull(),
                "fbError": row["fb_error"] ?? NSNull(),
                "channels": row["channels"] as? String ?? "ig",
                "preview": String(captionText(row).prefix(160))
            ]
        }
    }

    static func cancelJob(id: Int) {
        try? SQLite.shared.run(
            "DELETE FROM ig_jobs WHERE id = ? AND state IN ('scheduled','failed')", [.int(Int64(id))]
        )
    }

    static func retryJob(id: Int) {
        try? SQLite.shared.run(
            "UPDATE ig_jobs SET state = 'scheduled', error = NULL, scheduled_at = ? WHERE id = ? AND state = 'failed'",
            [.text(Formats.iso()), .int(Int64(id))]
        )
    }

    /// Kolik front k příspěvku ještě běží — podle toho se uklízí úložiště.
    static func openJobs(postId: Int) -> Int {
        let rows = (try? SQLite.shared.query(
            """
            SELECT COUNT(*) AS c FROM ig_jobs j JOIN ig_captions c ON c.id = j.caption_id
            WHERE c.post_id = ? AND j.state IN ('scheduled','publishing')
            """,
            [.int(Int64(postId))]
        )) ?? []
        return rows.first?["c"] as? Int ?? 0
    }
}
