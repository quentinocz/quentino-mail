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
        /*
         Dva pohledy zvlášť. Hlavní je poslední půlrok — podle něj se
         rozhoduje, co postnout teď. Starší úspěchy se přidávají jako
         připomenutí, ne jako měřítko: mohly mít zaplacený dosah.
         */
        out["bestEver"] = bestPosts(limit: 3, sinceDays: 180)
        out["bestOlder"] = bestPosts(limit: 2, beforeDays: 180)
        out["candidates"] = boostCandidates(days)
        out["boostKnown"] = knowsBoost()
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
    static func bestPosts(
        months: [Int] = [], limit: Int = 3, sinceDays: Int? = nil, beforeDays: Int? = nil
    ) -> [[String: Any]] {
        let rows = sourceRows()

        let wanted = Set(months)
        let now = Date().timeIntervalSince1970
        var picked: [(row: [String: Any], score: Int)] = []
        for row in rows {
            if !wanted.isEmpty {
                let month = Int(String((row["posted_at"] as? String ?? "").dropFirst(5).prefix(2))) ?? 0
                if !wanted.contains(month - 1) { continue }
            }
            /*
             Stáří. Hlavní seznam se dívá na poslední půlrok — podle něj se
             rozhoduje, co postnout teď; starší se ukazují zvlášť jako
             připomenutí, protože mohly mít zaplacený dosah.
             */
            if sinceDays != nil || beforeDays != nil {
                guard let when = Formats.date(row["posted_at"] as? String ?? "") else {
                    if sinceDays != nil { continue }
                    picked.append((row, score(row)))
                    continue
                }
                let age = (now - when.timeIntervalSince1970) / 86_400
                if let sinceDays, age > Double(sinceDays) { continue }
                if let beforeDays, age <= Double(beforeDays) { continue }
            }
            picked.append((row, score(row)))
        }

        return picked.sorted { $0.score > $1.score }.prefix(limit).map { found in post(found.row) }
    }

    /// Lajk je klepnutí, komentář práce — proto váží víc
    private static func score(_ row: [String: Any]) -> Int {
        (row["like_count"] as? Int ?? 0) + (row["comment_count"] as? Int ?? 0) * 3
    }

    /// Zdrojové příspěvky i s propagací; starší databáze sloupec nemá
    private static func sourceRows() -> [[String: Any]] {
        let withBoost = (try? SQLite.shared.query(
            "SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id, boosted "
            + "FROM ig_source_posts WHERE posted_at != '' ORDER BY posted_at DESC LIMIT 2000")) ?? []
        if !withBoost.isEmpty { return withBoost }
        return (try? SQLite.shared.query(
            "SELECT posted_at, caption, like_count, comment_count, permalink, ig_media_id "
            + "FROM ig_source_posts WHERE posted_at != '' ORDER BY posted_at DESC LIMIT 2000")) ?? []
    }

    /// Řádek z databáze na příspěvek i s trhy, kanály a propagací
    private static func post(_ row: [String: Any]) -> [String: Any] {
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
        // Prázdná hodnota znamená nevíme — a nevíme se nesmí tvářit jako ne
        if let boosted = row["boosted"] as? Int {
            one["boosted"] = boosted == 1
        } else {
            one["boosted"] = NSNull()
        }
        return one
    }

    /**
     Příspěvky, které si říkají o rozpočet.

     Úspěch placeného příspěvku není zásluha příspěvku — je koupený. Hledá se
     proto opak: čerstvý příspěvek, který si vede nadprůměrně bez placení.
     Měřítko je medián neplacených, ne průměr — jeden virál by průměr vytáhl
     tak, že by pak neprošlo nic.
     */
    static func boostCandidates(_ days: [[String: Any]], limit: Int = 3) -> [[String: Any]] {
        let rows = sourceRows()
        guard !rows.isEmpty else { return [] }

        let now = Date().timeIntervalSince1970
        let fresh = rows.filter { row in
            guard let when = Formats.date(row["posted_at"] as? String ?? "") else { return false }
            return now - when.timeIntervalSince1970 <= 60 * 86_400
        }
        guard !fresh.isEmpty else { return [] }

        let organic = rows.filter { ($0["boosted"] as? Int) != 1 }.map { score($0) }.sorted()
        guard !organic.isEmpty else { return [] }
        let median = max(1, organic[organic.count / 2])

        var daily: [String: Int] = [:]
        for day in days { daily[day["day"] as? String ?? ""] = day["orders"] as? Int ?? 0 }
        let average = days.isEmpty
            ? 0.0
            : Double(days.reduce(0) { $0 + ($1["orders"] as? Int ?? 0) }) / Double(days.count)

        let picked = fresh
            .filter { ($0["boosted"] as? Int) != 1 && Double(score($0)) >= Double(median) * 1.3 }
            .sorted { score($0) > score($1) }
            .prefix(limit)

        return picked.map { row in
            var one = post(row)
            /*
             Objednávky kolem vydání — den vydání a dva dny po něm. Déle už
             se to míchá s čímkoli jiným, co se ten týden dělo. Je to
             souvislost, ne důkaz, a tak se to i píše.
             */
            let day = String((row["posted_at"] as? String ?? "").prefix(10))
            var around: [Int] = []
            if let start = Formats.date(day + "T12:00:00Z") {
                for ahead in 0...2 {
                    let key = String(Formats.iso(start.addingTimeInterval(Double(ahead) * 86_400)).prefix(10))
                    if let value = daily[key] { around.append(value) }
                }
            }
            let mine = around.isEmpty ? 0 : Double(around.reduce(0, +)) / Double(around.count)
            let lift: Int? = (average > 0 && !around.isEmpty)
                ? Int((((mine - average) / average) * 100).rounded())
                : nil
            let times = (Double(score(row)) / Double(median) * 10).rounded() / 10

            var why = "Zaujal \(times)× víc než běžný neplacený příspěvek"
            if (row["boosted"] as? Int) == 0 { why += " a rozpočet za ním nestál" }
            if let lift {
                let how = lift > 0 ? "o \(lift) % víc" : (lift < 0 ? "o \(-lift) % míň" : "stejně")
                why += "; v den vydání a dva dny po něm chodilo \(how) objednávek než obvykle"
                    + " (souvislost, ne důkaz)"
            }
            one["why"] = why + "."
            one["lift"] = lift ?? NSNull()
            return one
        }
    }

    /// Ví se u téhle instalace, které příspěvky byly propagované?
    static func knowsBoost() -> Bool {
        let count = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM ig_source_posts WHERE boosted IS NOT NULL"
        ))?.first?["n"] as? Int) ?? 0
        return count > 0
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
