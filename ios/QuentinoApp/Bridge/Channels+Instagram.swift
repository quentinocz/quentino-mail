import Foundation
import UIKit

/**
 Kanály sociálních sítí.

 Jména i tvary parametrů jsou shodné se stolní verzí (`src/main/instagram/ipc.ts`),
 takže rozhraní běží beze změny. Jediný rozdíl je ve výběru médií: místo
 systémového dialogu se otevře knihovna fotek.
 */
extension Bridge {
    func registerInstagramChannels() {
        // MARK: Přehled a připojení

        register("ig:overview") { _ in Instagram.overview() }
        register("ig:saveConnection") { args in Instagram.saveConnection(args.first as? [String: Any] ?? [:]) }
        register("ig:installCallback") { _ in try await Instagram.installCallback() }
        register("ig:testStorage") { _ in try await IgMedia.testStorage() }

        register("ig:connect") { args in
            let url = try await Instagram.shared.startConnect(lang: args.first as? String ?? "")
            await Self.openExternally(url)
            return url
        }
        register("ig:relogin") { args in
            let url = try await Instagram.shared.relogin(lang: args.first as? String ?? "")
            await Self.openExternally(url)
            return url
        }
        register("ig:addMarket") { args in
            try await Instagram.shared.addMarket(lang: args.first as? String ?? "")
        }
        register("ig:connectToken") { args in
            try await Instagram.shared.connectWithToken(
                lang: args.first as? String ?? "",
                token: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
        }
        // Náhradní cesta, když návratovou stránku prohlížeč nepředá zpět aplikaci
        register("ig:pasteCallback") { args in
            try await Instagram.shared.pasteCallback(args.first as? String ?? "")
        }
        register("ig:finishConnect") { args in
            try await Instagram.shared.finishConnect(igUserId: args.first as? String ?? "")
        }

        register("ig:disconnect") { args in
            IgStore.deleteAccount(id: try Self.int(args.first))
            self.emitAsync("ig:changed")
            return true
        }
        register("ig:setSource") { args in
            IgStore.setSource(id: try Self.int(args.first))
            self.emitAsync("ig:changed")
            return true
        }
        register("ig:setShareFb") { args in
            IgStore.setShareFb(id: try Self.int(args.first), value: args.count > 1 && (args[1] as? Bool ?? false))
            self.emitAsync("ig:changed")
            return true
        }
        register("ig:limit") { args in
            await Instagram.accountLimit(accountId: try Self.int(args.first))
        }

        // MARK: Trhy a značka

        register("ig:markets") { _ in IgStore.markets() }
        register("ig:saveMarket") { args in IgStore.saveMarket(args.first as? [String: Any] ?? [:]) }
        register("ig:deleteMarket") { args in IgStore.deleteMarket(lang: args.first as? String ?? "") }
        register("ig:brand") { _ in IgStore.brand() }
        register("ig:saveBrand") { args in IgStore.saveBrand(args.first as? [String: Any] ?? [:]) }

        // MARK: Feed zdrojového účtu

        register("ig:feed") { args in
            IgStore.sourcePosts(
                limit: (args.first as? Int) ?? 60,
                offset: args.count > 1 ? (args[1] as? Int ?? 0) : 0
            )
        }
        register("ig:sync") { args in
            try await IgPublisher.syncSource(full: (args.first as? Bool) ?? false)
        }
        register("ig:thumb") { args in
            await Instagram.thumb(sourcePostId: try Self.int(args.first))
        }
        register("ig:createFromSource") { args in
            try Instagram.createFromSource(sourcePostId: try Self.int(args.first))
        }

        // MARK: Příspěvky

        register("ig:pickMedia") { _ in await MediaPicker.pickMedia(limit: 10) }
        register("ig:preview") { args in Instagram.preview(path: args.first as? String ?? "") }
        register("ig:createDraft") { args in
            try Instagram.createDraft(
                files: args.first as? [String] ?? [],
                brief: args.count > 1 ? (args[1] as? String ?? "") : "",
                mediaNote: args.count > 2 ? (args[2] as? String ?? "") : ""
            )
        }
        register("ig:updateDraft") { args in
            try Instagram.updateDraft(
                postId: try Self.int(args.first),
                patch: args.count > 1 ? (args[1] as? [String: Any] ?? [:]) : [:]
            )
        }
        register("ig:post") { args in IgStore.post(id: try Self.int(args.first)) }
        register("ig:drafts") { _ in IgStore.drafts() }
        register("ig:deletePost") { args in
            IgStore.deletePost(id: try Self.int(args.first))
            self.emitAsync("ig:changed")
            return true
        }
        register("ig:warnings") { args in Instagram.mediaWarnings(postId: try Self.int(args.first)) }

        // MARK: Generování a publikace

        register("ig:generate") { args in
            try await Instagram.generate(
                postId: try Self.int(args.first),
                langs: args.count > 1 ? (args[1] as? [String] ?? []) : []
            )
        }
        register("ig:blankCaptions") { args in
            try Instagram.blankCaptions(
                postId: try Self.int(args.first),
                langs: args.count > 1 ? (args[1] as? [String] ?? []) : []
            )
        }
        register("ig:chooseVariant") { args in
            IgStore.updateCaption(id: try Self.int(args.first),
                                  chosen: args.count > 1 ? (args[1] as? Int ?? 0) : 0)
            return true
        }
        register("ig:editCaption") { args in
            IgStore.updateCaption(id: try Self.int(args.first),
                                  edited: args.count > 1 ? (args[1] as? String ?? "") : "")
            return true
        }
        register("ig:publish") { args in
            try IgPublisher.schedule(
                captionId: try Self.int(args.first),
                at: args.count > 1 ? args[1] as? String : nil,
                channels: args.count > 2 ? args[2] as? String : nil
            )
        }
        register("ig:publishPost") { args in
            try Instagram.publishPost(
                postId: try Self.int(args.first),
                at: args.count > 1 ? args[1] as? String : nil,
                force: args.count > 2 && (args[2] as? Bool ?? false),
                channels: args.count > 3 ? args[3] as? String : nil
            )
        }
        register("ig:retryFacebook") { args in
            try await IgQueue.shared.retryFacebook(try Self.int(args.first))
            return true
        }

        // MARK: Fronta

        register("ig:jobs") { _ in IgStore.jobs() }
        register("ig:cancelJob") { args in
            IgStore.cancelJob(id: try Self.int(args.first))
            self.emitAsync("ig:changed")
            return true
        }
        register("ig:retryJob") { args in
            IgStore.retryJob(id: try Self.int(args.first))
            self.emitAsync("ig:changed")
            Task { await IgQueue.shared.process() }
            return true
        }
        register("ig:runQueue") { _ in
            await IgQueue.shared.process()
            return true
        }
        register("ig:refreshTokens") { _ in await IgPublisher.refreshTokens(force: true) }
    }

    // MARK: - Pomocné

    /// Rozhraní posílá čísla jako `Int` i jako `Double` (JSON nerozlišuje).
    static func int(_ value: Any?) throws -> Int {
        if let number = value as? Int { return number }
        if let number = value as? Double { return Int(number) }
        if let text = value as? String, let number = Int(text) { return number }
        throw BridgeError.message("Chybí identifikátor.")
    }

    @MainActor
    static func openExternally(_ address: String) {
        guard let url = URL(string: address) else { return }
        UIApplication.shared.open(url)
    }
}
