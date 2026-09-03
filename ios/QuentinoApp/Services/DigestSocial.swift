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
        return out
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
