import Foundation

/**
 Pomůcky pro volání HTTP API.

 Všechny služby (Claude, Supabase, Meta, Upgates) mluví přes HTTPS a vrací
 JSON, takže se to vyplatí mít na jednom místě i s převodem chyb do češtiny.
 */
enum Http {
    struct Failure: LocalizedError {
        let status: Int
        let body: String
        var errorDescription: String? {
            body.isEmpty ? "Server odpověděl \(status)." : "Server odpověděl \(status): \(body.prefix(200))"
        }
    }

    static func request(
        _ url: String,
        method: String = "GET",
        headers: [String: String] = [:],
        body: Data? = nil,
        timeout: TimeInterval = 60
    ) async throws -> Data {
        guard let target = URL(string: url) else {
            throw BridgeError.message("Neplatná adresa: \(url)")
        }
        var request = URLRequest(url: target, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Failure(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    static func json(
        _ url: String,
        method: String = "GET",
        headers: [String: String] = [:],
        body: Any? = nil,
        timeout: TimeInterval = 60
    ) async throws -> Any {
        var payload: Data?
        var allHeaders = headers
        if let body {
            payload = try JSONSerialization.data(withJSONObject: body)
            allHeaders["Content-Type"] = "application/json"
        }
        let data = try await request(url, method: method, headers: allHeaders, body: payload, timeout: timeout)
        guard !data.isEmpty else { return [:] }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func dictionary(
        _ url: String,
        method: String = "GET",
        headers: [String: String] = [:],
        body: Any? = nil,
        timeout: TimeInterval = 60
    ) async throws -> [String: Any] {
        (try await json(url, method: method, headers: headers, body: body, timeout: timeout))
            as? [String: Any] ?? [:]
    }

    static func array(
        _ url: String,
        method: String = "GET",
        headers: [String: String] = [:],
        body: Any? = nil
    ) async throws -> [[String: Any]] {
        (try await json(url, method: method, headers: headers, body: body)) as? [[String: Any]] ?? []
    }

    static func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}
