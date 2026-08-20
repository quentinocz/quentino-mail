import Foundation

/**
 Kanály chatu a AI.

 Názvy i tvary odpovědí jsou shodné se stolní verzí — rozhraní je používá
 beze změny.
 */
extension Bridge {
    func registerChatChannels() {
        register("chat:overview") { _ in
            var overview: [String: Any] = [
                "config": Chat.config(),
                "persons": Settings.persons().map { person -> [String: Any] in
                    let display = (person["displayNames"] as? [String: Any])?["cz"] as? String ?? ""
                    let name = person["name"] as? String ?? ""
                    let short = (display.isEmpty ? name : display).split(separator: " ").first.map(String.init) ?? ""
                    return ["id": person["id"] ?? 0, "name": name, "short": short]
                },
                "unread": 0,
                "waiting": 0
            ]
            if Chat.isReady, let totals = try? await Chat.unreadTotal() {
                overview["unread"] = totals["unread"] ?? 0
                overview["waiting"] = totals["conversations"] ?? 0
            }
            return overview
        }

        register("chat:saveConfig") { args in Chat.saveConfig(args.first as? [String: Any] ?? [:]) }
        register("chat:test") { _ in
            _ = try await Chat.conversations(onlyOpen: true)
            return "Spojení funguje, konverzace se čtou."
        }

        register("chat:conversations") { args in
            try await Chat.conversations(onlyOpen: (args.first as? Bool) ?? true)
        }
        register("chat:messages") { args in
            guard let id = args.first as? String else { throw BridgeError.message("Chybí konverzace.") }
            return try await Chat.messages(id)
        }
        register("chat:send") { args in
            guard let id = args.first as? String, let text = args.dropFirst().first as? String else {
                throw BridgeError.message("Chybí zpráva.")
            }
            let personId = args.count > 2 ? args[2] as? Int : nil
            let messages = try await Chat.send(id, text, personId: personId)
            self.emitAsync("chat:changed", ["conversationId": id])
            return messages
        }
        register("chat:markRead") { args in
            guard let id = args.first as? String else { return false }
            try await Chat.markRead(id)
            return true
        }
        register("chat:setStatus") { args in
            guard let id = args.first as? String, let status = args.dropFirst().first as? String else {
                throw BridgeError.message("Chybí stav.")
            }
            try await Chat.setStatus(id, status)
            self.emitAsync("chat:changed", ["conversationId": id])
            return true
        }

        register("chat:cards") { args in
            guard let text = args.first as? String else { return [] }
            return (try? await Chat.productPreview(urls: Chat.extractUrls(text))) ?? []
        }
        register("chat:searchProducts") { args in
            try await Chat.searchProducts(args.first as? String ?? "")
        }
        register("chat:productInDomain") { args in
            guard let id = args.first as? String, let domain = args.dropFirst().first as? String else {
                return NSNull()
            }
            return try await Chat.product(id: id, domain: domain)
        }
        register("chat:suggest") { args in
            guard let id = args.first as? String else { throw BridgeError.message("Chybí konverzace.") }
            return try await Chat.suggest(id, note: args.dropFirst().first as? String ?? "")
        }

        // Posílání obrázků z telefonu přijde spolu s výběrem souborů
        // Obrázek do chatu: vybere se z knihovny, nahraje do úložiště médií
        // a odešle jako odkaz — stejně jako z počítače.
        register("chat:sendImage") { args in
            guard let conversationId = args.first as? String else {
                throw BridgeError.message("Chybí konverzace.")
            }
            guard let path = await MediaPicker.pickImage() else { return NSNull() }
            let data = try IgMedia.read(path)
            let name = (path as NSString).lastPathComponent
            let uploaded = try await IgMedia.upload(
                data, key: "chat/\(Int(Date().timeIntervalSince1970))-\(name)", mime: IgMedia.mime(for: path)
            )
            let person = args.count > 1 ? args[1] as? Int : nil
            return try await Chat.send(conversationId, uploaded.publicUrl, personId: person)
        }
    }

    func registerAiChannels() {
        register("ai:improve") { args in
            guard let text = args.first as? String else { throw BridgeError.message("Chybí text.") }
            return try await AI.improve(text: text, mode: args.dropFirst().first as? String ?? "improve")
        }
        register("ai:translateText") { args in
            guard let text = args.first as? String else { throw BridgeError.message("Chybí text.") }
            return try await AI.translate(text: text, to: args.dropFirst().first as? String ?? "cs")
        }
        register("ai:usage") { _ in AI.usage() }

        // Shrnutí, odpovědi a překlady nad poštou registruje Channels+Mail
    }
}
