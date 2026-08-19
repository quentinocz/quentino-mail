import Foundation

/**
 Práce s časem na jednom místě.

 V databázi se potkávají dva tvary: to, co zapíše aplikace (`toISOString()`
 na počítači, tedy `2026-08-19T10:00:00.000Z`), a to, co zapíše samo SQLite
 (`datetime('now')`, tedy `2026-08-19 10:00:00` v UTC). Obojí je potřeba umět
 přečíst, jinak by se položky fronty a zprávy řadily náhodně.
 */
enum Formats {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let sqlite: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    /// Přečte čas v kterémkoliv z tvarů, se kterými aplikace pracuje.
    static func date(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        if let date = withFraction.date(from: text) { return date }
        if let date = plain.date(from: text) { return date }
        return sqlite.date(from: text)
    }

    /// Zápis ve tvaru, který používá i stolní verze.
    static func iso(_ date: Date = Date()) -> String {
        withFraction.string(from: date)
    }

    static func days(_ count: Double) -> TimeInterval {
        count * 86_400
    }

    /// Měsíc `YYYY-MM` pro evidenci spotřeby AI.
    static func month(_ date: Date = Date()) -> String {
        String(iso(date).prefix(7))
    }

    /// Je čas už za námi? Prázdná hodnota znamená „neomezeně".
    static func expired(_ text: String?) -> Bool {
        guard let date = date(text) else { return false }
        return date < Date()
    }
}
