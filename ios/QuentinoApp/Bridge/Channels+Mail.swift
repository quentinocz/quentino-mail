import Foundation

/**
 Kanály pošty.

 Čtení a zápis na server blokují vlákno, proto každá taková operace odchází
 do `Task.detached` — jinak by se při stahování zprávy zaseklo rozhraní.
 Tvar dat je shodný se stolní verzí, rozhraní se nemění.
 */
extension Bridge {
    func registerMailChannels() {
        // MARK: Účty

        register("accounts:list") { _ in MailStore.accounts() }
        register("accounts:save") { args in
            let patch = args.first as? [String: Any] ?? [:]
            return try MailStore.saveAccount(patch)
        }
        register("accounts:delete") { args in
            MailStore.deleteAccount(try Self.int(args.first))
            self.emitAsync("folders:changed")
            return true
        }
        register("accounts:test") { args in
            let config = args.first as? [String: Any] ?? [:]
            return try await Task.detached(priority: .userInitiated) {
                try MailSync.test(config)
            }.value
        }

        // MARK: Složky a synchronizace

        register("folders:list") { args in
            let accountId = try Self.int(args.first)
            let refresh = args.count > 1 && (args[1] as? Bool ?? false)
            return try await Task.detached(priority: .userInitiated) {
                try MailSync.folders(accountId, refresh: refresh)
            }.value
        }

        register("sync:folder") { args in
            let accountId = try Self.int(args.first)
            let folder = args.count > 1 ? (args[1] as? String ?? "INBOX") : "INBOX"
            try await Task.detached(priority: .userInitiated) {
                _ = try MailSync.sync(accountId: accountId, folder: folder)
            }.value
            // Kategorie a shrnutí doběhnou na pozadí, rozhraní na ně nečeká
            Task { await MailAI.autoProcess(accountId: accountId, folder: folder) }
            return true
        }

        register("sync:all") { _ in
            await Task.detached(priority: .utility) { MailSync.syncAll() }.value
            Task {
                for account in MailStore.accounts() {
                    await MailAI.autoProcess(accountId: account["id"] as? Int ?? 0, folder: "INBOX")
                }
            }
            return true
        }

        // MARK: Zprávy

        register("messages:list") { args in
            MailStore.messages(
                accountId: try Self.int(args.first),
                folder: args.count > 1 ? (args[1] as? String ?? "INBOX") : "INBOX",
                options: args.count > 2 ? (args[2] as? [String: Any] ?? [:]) : [:]
            )
        }

        register("messages:get") { args in
            let dbId = try Self.int(args.first)
            try await Task.detached(priority: .userInitiated) { try MailSync.fetchFull(dbId) }.value
            return try MailStore.full(dbId)
        }

        register("messages:thread") { args in MailStore.thread(try Self.int(args.first)) }

        register("messages:setFlag") { args in
            let dbId = try Self.int(args.first)
            let flag = args.count > 1 ? (args[1] as? String ?? "seen") : "seen"
            let value = args.count > 2 && (args[2] as? Bool ?? false)
            try await Task.detached(priority: .userInitiated) {
                try MailSync.setFlag(dbId, flag: flag, value: value)
            }.value
            self.emitAsync("messages:changed")
            return true
        }

        register("messages:delete") { args in
            let dbId = try Self.int(args.first)
            try await Task.detached(priority: .userInitiated) { try MailSync.delete(dbId) }.value
            return true
        }

        register("messages:move") { args in
            let dbId = try Self.int(args.first)
            let folder = args.count > 1 ? (args[1] as? String ?? "") : ""
            guard !folder.isEmpty else { throw BridgeError.message("Chybí cílová složka.") }
            try await Task.detached(priority: .userInitiated) { try MailSync.move(dbId, to: folder) }.value
            return true
        }

        register("messages:archive") { args in
            let dbId = try Self.int(args.first)
            return try await Task.detached(priority: .userInitiated) { try MailSync.archive(dbId) }.value
        }

        register("messages:categorize") { args in
            let accountId = try Self.int(args.first)
            let folder = args.count > 1 ? (args[1] as? String ?? "INBOX") : "INBOX"
            await MailAI.categorize(accountId: accountId, folder: folder)
            return true
        }

        register("trash:empty") { args in
            let accountId = try Self.int(args.first)
            return try await Task.detached(priority: .userInitiated) {
                try MailSync.emptyTrash(accountId)
            }.value
        }

        register("quota:get") { args in
            let accountId = try Self.int(args.first)
            return await Task.detached(priority: .utility) { MailSync.quota(accountId) }.value
        }

        register("stats:categories") { args in
            MailStore.categoryStats(accountId: try Self.int(args.first))
        }

        // MARK: Hromadné operace

        register("messages:bulkFlag") { args in
            let ids = (args.first as? [Any] ?? []).compactMap { try? Self.int($0) }
            let flag = args.count > 1 ? (args[1] as? String ?? "seen") : "seen"
            let value = args.count > 2 && (args[2] as? Bool ?? false)
            try await Task.detached(priority: .userInitiated) {
                for id in ids { try? MailSync.setFlag(id, flag: flag, value: value) }
            }.value
            self.emitAsync("messages:changed")
            return true
        }

        register("messages:bulkDelete") { args in
            let ids = (args.first as? [Any] ?? []).compactMap { try? Self.int($0) }
            try await Task.detached(priority: .userInitiated) {
                for id in ids { try? MailSync.delete(id) }
            }.value
            return true
        }

        register("messages:bulkArchive") { args in
            let ids = (args.first as? [Any] ?? []).compactMap { try? Self.int($0) }
            let deleteAfter = args.count > 1 && (args[1] as? Bool ?? false)
            try await Task.detached(priority: .userInitiated) {
                for id in ids {
                    guard (try? MailSync.archive(id)) != nil else { continue }
                    if deleteAfter { try? MailSync.delete(id) }
                }
            }.value
            self.emitAsync("messages:changed")
            return true
        }

        // MARK: Odesílání

        register("send:now") { args in
            guard let draft = args.first as? [String: Any] else { throw BridgeError.message("Chybí zpráva.") }
            var prepared = draft
            // Překlad před odesláním — stejně jako na počítači
            if let target = draft["translateTo"] as? String, target != "cs", !target.isEmpty {
                prepared["html"] = try await MailAI.translateHtml(draft["html"] as? String ?? "", to: target)
            }
            let payload = prepared
            try await Task.detached(priority: .userInitiated) { try MailSync.send(payload) }.value
            self.emitAsync("messages:changed")
            return true
        }

        register("send:schedule") { args in
            guard let draft = args.first as? [String: Any] else { throw BridgeError.message("Chybí zpráva.") }
            let id = try MailStore.enqueue(draft)
            self.emitAsync("outbox:changed")
            Task.detached(priority: .utility) { MailSync.processOutbox() }
            return id
        }

        register("outbox:list") { _ in MailStore.outbox() }
        register("outbox:cancel") { args in
            MailStore.cancelOutbox(try Self.int(args.first))
            self.emitAsync("outbox:changed")
            return true
        }
        register("outbox:processNow") { _ in
            await Task.detached(priority: .userInitiated) { MailSync.processOutbox() }.value
            return true
        }

        // MARK: AI nad poštou

        register("ai:summarize") { args in try await MailAI.summarize(try Self.int(args.first)) }
        register("ai:reply") { args in
            try await MailAI.reply(args.first as? [String: Any] ?? [:])
        }
        register("ai:translateIncoming") { args in
            try await MailAI.translateIncoming(try Self.int(args.first))
        }
        register("ai:digest") { _ in try await MailAI.digest() }

        // Tisk zprávy do PDF — stejná cesta jako u poukazů
        register("messages:exportPdf") { args in
            let name = args.first as? String ?? "zprava"
            guard args.count > 1, let html = args[1] as? String else {
                throw BridgeError.message("Chybí obsah zprávy.")
            }
            return try await MailPdf.export(name: name, html: html)
        }
    }
}
