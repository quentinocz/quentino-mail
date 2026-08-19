import Foundation

/**
 Claude API.

 Stejné modely i stejná evidence spotřeby jako na počítači — tabulka
 `ai_usage` se plní shodně, aby přehled seděl bez ohledu na zařízení.
 */
enum AI {
    static func apiKey() throws -> String {
        guard let key = Secrets.get("anthropicApiKey"), !key.isEmpty else {
            throw BridgeError.message("Není nastaven Anthropic API klíč (Nastavení → AI).")
        }
        return key
    }

    /// Jedno kolo rozhovoru; vrací text odpovědi.
    static func ask(
        model: String,
        system: String?,
        content: [[String: Any]],
        maxTokens: Int = 1024
    ) async throws -> String {
        var payload: [String: Any] = [
            "model": model,
            "max_tokens": maxTokens,
            "messages": [["role": "user", "content": content]]
        ]
        if let system, !system.isEmpty { payload["system"] = system }

        let response = try await Http.dictionary(
            "https://api.anthropic.com/v1/messages",
            method: "POST",
            headers: [
                "x-api-key": try apiKey(),
                "anthropic-version": "2023-06-01"
            ],
            body: payload
        )

        if let error = response["error"] as? [String: Any], let message = error["message"] as? String {
            throw BridgeError.message(message)
        }
        record(model: model, usage: response["usage"] as? [String: Any])

        let blocks = response["content"] as? [[String: Any]] ?? []
        return blocks
            .filter { ($0["type"] as? String) == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func ask(model: String, system: String?, user: String, maxTokens: Int = 1024) async throws -> String {
        try await ask(model: model, system: system, content: [["type": "text", "text": user]], maxTokens: maxTokens)
    }

    static var draftModel: String { Store.setting("draftModel", "claude-sonnet-5")! }
    static var fastModel: String { Store.setting("fastModel", "claude-haiku-4-5-20251001")! }

    /// Anthropic zůstatek kreditu přes API nedává, proto si spotřebu vedeme sami.
    private static func record(model: String, usage: [String: Any]?) {
        let month = String(ISO8601DateFormatter().string(from: Date()).prefix(7))
        let input = usage?["input_tokens"] as? Int ?? 0
        let output = usage?["output_tokens"] as? Int ?? 0
        try? SQLite.shared.run(
            """
            INSERT INTO ai_usage (month, model, input_tokens, output_tokens, calls) VALUES (?,?,?,?,1)
            ON CONFLICT(month, model) DO UPDATE SET
              input_tokens = input_tokens + excluded.input_tokens,
              output_tokens = output_tokens + excluded.output_tokens,
              calls = calls + 1
            """,
            [.text(month), .text(model), .int(Int64(input)), .int(Int64(output))]
        )
    }

    /// Vylepšení nebo korektura textu — stejné pokyny jako na počítači.
    static func improve(text: String, mode: String) async throws -> String {
        let brand = Store.setting("brandPrompt", "") ?? ""
        let system = mode == "grammar"
            ? "Oprav v textu e-mailu gramatiku, překlepy, diakritiku a interpunkci. Nic jiného neměň — zachovej styl, obsah i délku. Vrať POUZE opravený text."
            : "\(brand)\n\nVylepši následující text: uhlazenější formulace, správná struktura, zdvořilý a pozitivní tón odpovídající značce. Zachovej jazyk originálu a veškerá fakta. Vrať POUZE vylepšený text, bez komentářů."
        return try await ask(model: draftModel, system: system, user: text, maxTokens: 1500)
    }

    static func translate(text: String, to language: String) async throws -> String {
        try await ask(
            model: draftModel,
            system: "Přelož následující text do jazyka s ISO kódem \"\(language)\". Zachovej strukturu odstavců. Vrať POUZE překlad.",
            user: text,
            maxTokens: 2500
        )
    }

    static func usage() -> [String: Any] {
        let month = String(ISO8601DateFormatter().string(from: Date()).prefix(7))
        let rows = (try? SQLite.shared.query(
            "SELECT model, input_tokens, output_tokens, calls FROM ai_usage WHERE month = ?",
            [.text(month)]
        )) ?? []

        var calls = 0, input = 0, output = 0
        var usd = 0.0
        for row in rows {
            let model = (row["model"] as? String ?? "").lowercased()
            let inTok = row["input_tokens"] as? Int ?? 0
            let outTok = row["output_tokens"] as? Int ?? 0
            calls += row["calls"] as? Int ?? 0
            input += inTok
            output += outTok
            // Orientační ceník za milion tokenů podle rodiny modelu
            let price: (Double, Double) = model.contains("haiku") ? (1, 5)
                : model.contains("opus") ? (15, 75) : (3, 15)
            usd += Double(inTok) / 1e6 * price.0 + Double(outTok) / 1e6 * price.1
        }
        return [
            "month": month, "calls": calls, "inputTokens": input, "outputTokens": output,
            "estUsd": (usd * 100).rounded() / 100
        ]
    }
}
