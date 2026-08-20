import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/**
 Tenká vrstva nad systémovým SQLite.

 Záměrně bez knihovny třetí strany: iOS má SQLite v systému, takže se sestavení
 nezdržuje závislostmi a `.ipa` zůstává malé. Rozhraní je jen tolik, kolik
 aplikace potřebuje — dotaz, zápis, transakce.

 Databáze se jmenuje stejně jako na počítači (`quentino-mail.db`) a má stejné
 schéma, takže zálohy i synchronizace fungují napříč zařízeními.
 */
final class SQLite {
    enum Value {
        case null
        case int(Int64)
        case double(Double)
        case text(String)
        case blob(Data)
    }

    struct Error: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static let shared = SQLite()

    private var handle: OpaquePointer?
    private let queue = DispatchQueue(label: "cz.quentino.sqlite")

    private init() {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Quentino", isDirectory: true)
        _ = try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("quentino-mail.db").path

        if sqlite3_open(path, &handle) != SQLITE_OK {
            assertionFailure("Databázi se nepodařilo otevřít: \(lastError)")
        }
        exec("PRAGMA journal_mode = WAL;")
        exec("PRAGMA foreign_keys = ON;")
        exec(Schema.sql)
        for statement in Schema.migrations {
            // Doplňkové sloupce pro starší databáze — chyba „už existuje" je v pořádku
            _ = try? run(statement)
        }
    }

    private var lastError: String {
        String(cString: sqlite3_errmsg(handle))
    }

    @discardableResult
    func exec(_ sql: String) -> Bool {
        queue.sync {
            sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK
        }
    }

    /// Zápis; vrací počet dotčených řádků a ID posledního vloženého.
    @discardableResult
    func run(_ sql: String, _ params: [Value] = []) throws -> (changes: Int, lastId: Int64) {
        try queue.sync {
            let statement = try prepare(sql, params)
            defer { sqlite3_finalize(statement) }
            let status = sqlite3_step(statement)
            guard status == SQLITE_DONE || status == SQLITE_ROW else {
                throw Error(message: "SQL: \(lastError)")
            }
            return (Int(sqlite3_changes(handle)), sqlite3_last_insert_rowid(handle))
        }
    }

    /// Dotaz; každý řádek je slovník sloupec → hodnota (JSON-kompatibilní).
    func query(_ sql: String, _ params: [Value] = []) throws -> [[String: Any]] {
        try queue.sync {
            let statement = try prepare(sql, params)
            defer { sqlite3_finalize(statement) }

            var rows: [[String: Any]] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                var row: [String: Any] = [:]
                for index in 0..<sqlite3_column_count(statement) {
                    let name = String(cString: sqlite3_column_name(statement, index))
                    switch sqlite3_column_type(statement, index) {
                    case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(statement, index))
                    case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, index)
                    case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, index))
                    case SQLITE_NULL: row[name] = NSNull()
                    default:
                        if let bytes = sqlite3_column_blob(statement, index) {
                            let count = Int(sqlite3_column_bytes(statement, index))
                            row[name] = Data(bytes: bytes, count: count).base64EncodedString()
                        } else {
                            row[name] = NSNull()
                        }
                    }
                }
                rows.append(row)
            }
            return rows
        }
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        exec("BEGIN IMMEDIATE")
        do {
            let result = try body()
            exec("COMMIT")
            return result
        } catch {
            exec("ROLLBACK")
            throw error
        }
    }

    private func prepare(_ sql: String, _ params: [Value]) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw Error(message: "SQL: \(lastError)")
        }
        for (offset, value) in params.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .null: sqlite3_bind_null(statement, index)
            case .int(let number): sqlite3_bind_int64(statement, index, number)
            case .double(let number): sqlite3_bind_double(statement, index, number)
            case .text(let text): sqlite3_bind_text(statement, index, text, -1, SQLITE_TRANSIENT)
            case .blob(let data): _ = data.withUnsafeBytes {
                sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(data.count), SQLITE_TRANSIENT)
            }
            }
        }
        return statement
    }
}

extension SQLite.Value {
    /// Pohodlné vytvoření z čehokoliv, co přijde z JavaScriptu.
    static func of(_ any: Any?) -> SQLite.Value {
        switch any {
        case nil, is NSNull: return .null
        case let text as String: return .text(text)
        case let number as Int: return .int(Int64(number))
        case let number as Int64: return .int(number)
        case let number as Double: return .double(number)
        case let flag as Bool: return .int(flag ? 1 : 0)
        default: return .text(String(describing: any!))
        }
    }
}
