import Foundation

/**
 Co dělaly sociální sítě — podklad pro AI přehled.

 Sesterský modul k `src/main/digestsocial.ts`. Aplikace ví o příspěvcích na
 Instagramu: kdy vyšly, kolik mají lajků a komentářů a na kolik trhů se
 rozeslaly. Spočítat jde, jestli **ve dnech s příspěvkem chodilo víc
 objednávek** — je to souvislost, ne důkaz, a tak se to i píše.

 Zhlédnutí a dosah aplikace nemá: Instagram je vydává jen přes rozhraní
 `insights` a to se zatím nestahuje.
 */
enum DigestSocial {
    static func view(days: [[String: Any]], windowDays: Int = 30) -> Any {
        let fromDay = days.first?["day"] as? String ?? ""
        guard !fromDay.isEmpty else { return NSNull() }

        // O kolik dní zpátky se ptát, aby bylo i předchozí období na srovnání
        let prevKey: String = {
            guard let from = Formats.date("\(fromDay) 12:00:00") ?? isoDay(fromDay) else { return fromDay }
            let back = from.addingTimeInterval(-Double(windowDays) * 86_400)
            return String(Formats.iso(back).prefix(10))
        }()

        guard let rows = try? SQLite.shared.query(
            "SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id "
            + "FROM ig_source_posts WHERE substr(posted_at, 1, 10) >= ? ORDER BY posted_at DESC LIMIT 200",
            [.text(prevKey)]
        ) else {
            // Instagram v téhle instalaci vůbec není — přehled se tím nemění
            return NSNull()
        }

        var inWindow = Set<String>()
        for one in days { if let day = one["day"] as? String { inWindow.insert(day) } }

        var postDays = Set<String>()
        var posts = 0
        var likes = 0
        var comments = 0
        var prevPosts = 0
        var best: [String: Any]?
        var bestScore = -1

        for row in rows {
            let day = String((row["posted_at"] as? String ?? "").prefix(10))
            if day.isEmpty { continue }
            if !inWindow.contains(day) {
                if day < fromDay { prevPosts += 1 }
                continue
            }
            posts += 1
            postDays.insert(day)
            let like = row["like_count"] as? Int ?? 0
            let comment = row["comment_count"] as? Int ?? 0
            likes += like
            comments += comment

            // Komentář stojí víc práce než lajk, tak i víc váží
            let score = like + comment * 3
            if score > bestScore {
                bestScore = score
                var one: [String: Any] = [:]
                one["at"] = row["posted_at"] as? String ?? ""
                let caption = (row["caption"] as? String ?? "")
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                one["caption"] = String(caption.prefix(120))
                one["likes"] = like
                one["comments"] = comment
                one["permalink"] = row["permalink"] as? String ?? ""
                one["markets"] = markets(row["ig_media_id"] as? String ?? "")
                best = one
            }
        }

        let withPost = days.filter { postDays.contains($0["day"] as? String ?? "") }
        let without = days.filter { !postDays.contains($0["day"] as? String ?? "") }

        var out: [String: Any] = [:]
        out["posts"] = posts
        out["likes"] = likes
        out["comments"] = comments
        out["best"] = best ?? NSNull()
        out["daysWithPost"] = postDays.count
        out["ordersWithPost"] = average(withPost)
        out["ordersWithout"] = average(without)
        out["prevPosts"] = prevPosts
        // Dlouhý pohled: co fungovalo nejlíp za celou dobu, ne jen v okně
        out["bestEver"] = bestPosts(limit: 3)
        return out
    }

    /**
     Kudy příspěvek vyšel.

     Aplikace publikuje na Instagram a volitelně sdílí na Facebook — a to je
     jediné, co se o Facebooku dá z databáze zjistit. **Lajky a komentáře
     jsou vždycky z Instagramu**, protože metriky Facebooku se nikam
     neukládají; říká se to proto rovnou.
     */
    private static func channels(_ mediaId: String) -> String {
        guard !mediaId.isEmpty else { return "IG" }
        let count = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM ig_jobs j WHERE j.fb_post_id IS NOT NULL AND j.fb_post_id != '' "
            + "AND j.ig_media_id IN (SELECT ig_media_id FROM ig_published WHERE source_media_id = ?)",
            [.text(mediaId)]
        ))?.first?["n"] as? Int) ?? 0
        return count > 0 ? "IG + FB" : "IG"
    }

    /// Na které trhy příspěvek šel — jazyky, ne jen počet
    private static func marketLabels(_ mediaId: String) -> [String] {
        guard !mediaId.isEmpty else { return [] }
        let rows = (try? SQLite.shared.query(
            "SELECT lang FROM ig_published WHERE source_media_id = ? ORDER BY lang", [.text(mediaId)])) ?? []
        return rows.compactMap { ($0["lang"] as? String)?.uppercased() }.filter { !$0.isEmpty }
    }

    /**
     Nejúspěšnější příspěvky za celou historii, případně jen z určitých měsíců.

     `months` (0 = leden) se hodí u sezóny: „co fungovalo loni v listopadu
     a prosinci" je pro chystanou kampaň lepší podklad než minulý týden.
     */
    static func bestPosts(months: [Int] = [], limit: Int = 3) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id "
            + "FROM ig_source_posts WHERE posted_at != '' ORDER BY posted_at DESC LIMIT 2000")) ?? []

        let wanted = Set(months)
        var picked: [(row: [String: Any], score: Int)] = []
        for row in rows {
            if !wanted.isEmpty {
                let month = Int(String((row["posted_at"] as? String ?? "").dropFirst(5).prefix(2))) ?? 0
                if !wanted.contains(month - 1) { continue }
            }
            let like = row["like_count"] as? Int ?? 0
            let comment = row["comment_count"] as? Int ?? 0
            picked.append((row, like + comment * 3))
        }

        return picked.sorted { $0.score > $1.score }.prefix(limit).map { found in
            let row = found.row
            let mediaId = row["ig_media_id"] as? String ?? ""
            let caption = (row["caption"] as? String ?? "")
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let labels = marketLabels(mediaId)

            var one: [String: Any] = [:]
            one["at"] = row["posted_at"] as? String ?? ""
            one["caption"] = String(caption.prefix(120))
            one["likes"] = row["like_count"] as? Int ?? 0
            one["comments"] = row["comment_count"] as? Int ?? 0
            one["permalink"] = row["permalink"] as? String ?? ""
            one["markets"] = labels.count
            one["marketLabels"] = labels
            one["channels"] = channels(mediaId)
            return one
        }
    }

    private static func average(_ days: [[String: Any]]) -> Double {
        guard !days.isEmpty else { return 0 }
        let sum = days.reduce(0) { $0 + ($1["orders"] as? Int ?? 0) }
        return (Double(sum) / Double(days.count) * 10).rounded() / 10
    }

    private static func markets(_ mediaId: String) -> Int {
        guard !mediaId.isEmpty else { return 0 }
        return ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM ig_published WHERE source_media_id = ?", [.text(mediaId)]
        ))?.first?["n"] as? Int) ?? 0
    }

    /// `YYYY-MM-DD` na datum — na poledne, ať časové pásmo nepřehodí den
    private static func isoDay(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        return Calendar.current.date(from: components)
    }
}
