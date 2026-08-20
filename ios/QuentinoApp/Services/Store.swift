import Foundation

/**
 Nastavení a tajemství.

 Obyčejné hodnoty leží v tabulce `settings` (stejně jako na počítači), hesla
 a API klíče v systémové klíčence. Na desktopu to dělá `safeStorage`, tady
 Keychain — v obou případech platí, že se do zálohy dávají rozšifrované,
 protože na jiném zařízení by byly k ničemu.
 */
enum Store {
    static func setting(_ key: String, _ fallback: String? = nil) -> String? {
        let rows = (try? SQLite.shared.query("SELECT value FROM settings WHERE key = ?", [.text(key)])) ?? []
        return rows.first?["value"] as? String ?? fallback
    }

    static func setSetting(_ key: String, _ value: String) {
        _ = try? SQLite.shared.run(
            "INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [.text(key), .text(value)]
        )
    }

    static func bool(_ key: String, _ fallback: Bool) -> Bool {
        guard let value = setting(key) else { return fallback }
        return value == "1"
    }

    static func json(_ key: String, _ fallback: Any) -> Any {
        guard let text = setting(key), let data = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else { return fallback }
        return parsed
    }

    static func setJson(_ key: String, _ value: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return }
        setSetting(key, text)
    }

    /// Razítko pro synchronizaci: druhé zařízení podle něj pozná, že je co poslat.
    static func touchState() {
        setSetting("stateStamp", ISO8601DateFormatter().string(from: Date()))
    }
}

/// Hesla a klíče v systémové klíčence.
enum Secrets {
    private static let service = "cz.quentino.app"

    static func set(_ key: String, _ value: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = query
        add[kSecValueData as String] = data
        // Po odemčení zařízení; jinak by aplikace na pozadí neuměla nic přečíst
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func has(_ key: String) -> Bool {
        !(get(key) ?? "").isEmpty
    }
}
