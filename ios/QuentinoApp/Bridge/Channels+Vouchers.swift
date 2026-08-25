import Foundation

/**
 Kanály dárkových poukazů.

 Šablony i zásoba kódů leží ve stejných tabulkách jako na počítači, takže
 poukaz vydaný z telefonu se na Macu po synchronizaci pozná jako použitý.
 */
extension Bridge {
    func registerVoucherChannels() {
        /**
         Po každé změně se poukazy rovnou pošlou do sdílené složky, ať se nová
         šablona nebo ubraný kód objeví na druhém zařízení hned a ne až
         s dalším velkým kolem synchronizace.
         */
        func changed<T>(_ value: T) -> T {
            AppSync.pushVouchersSoon()
            return value
        }

        register("vouchers:list") { _ in Vouchers.templates() }
        register("vouchers:save") { args in
            try changed(Vouchers.saveTemplate(args.first as? [String: Any] ?? [:]))
        }
        register("vouchers:delete") { args in
            try changed(Vouchers.deleteTemplate(id: Self.text(args.first)))
        }
        register("vouchers:addCodes") { args in
            try changed(Vouchers.addCodes(
                templateId: Self.text(args.first),
                raw: args.count > 1 ? (args[1] as? String ?? "") : ""
            ))
        }
        register("vouchers:codes") { args in
            Vouchers.codes(templateId: try Self.text(args.first))
        }
        register("vouchers:deleteCode") { args in
            try changed(Vouchers.deleteCode(
                templateId: Self.text(args.first),
                code: args.count > 1 ? (args[1] as? String ?? "") : ""
            ))
        }
        /**
         Sladit poukazy hned. Aplikace to dělá sama každých pár vteřin, ale když
         někdo čeká na kódy z druhého zařízení, je lepší mít tlačítko než hádat,
         jestli se něco děje. (Rychlost dodání souboru řídí cloud, ne my.)
         */
        register("vouchers:sync") { _ in
            await Task.detached(priority: .utility) { AppSync.syncVouchersNow() }.value
            return Vouchers.templates()
        }

        /// Kódy, které podle synchronizace vydala dvě zařízení — normálně prázdné
        register("vouchers:clashes") { _ in Vouchers.clashes() }
        register("vouchers:clearClash") { args in
            Vouchers.clearClash(
                templateId: try Self.text(args.first),
                code: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
        }
        register("vouchers:release") { args in
            Vouchers.releaseCode(
                templateId: try Self.text(args.first),
                code: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
            return changed(true)
        }

        /**
         Odebere kód ze zásoby a rovnou z něj vysází PDF. Když se sazba
         nepovede, kód se vrátí zpátky — jinak by zmizel, aniž by ho někdo
         dostal.
         */
        register("vouchers:use") { args in
            let templateId = try Self.text(args.first)
            let forWhom = args.count > 1 ? (args[1] as? String ?? "") : ""
            let taken = try Vouchers.takeCode(templateId: templateId, forWhom: forWhom)
            do {
                let spec = try Vouchers.spec(templateId: templateId, code: taken.code)
                let files = try await VoucherPdf.create(spec: spec)
                // Ubraný kód ať druhé zařízení ví hned
                return changed(["code": taken.code, "remaining": taken.remaining, "files": files])
            } catch {
                Vouchers.releaseCode(templateId: templateId, code: taken.code)
                AppSync.pushVouchersSoon()
                throw error
            }
        }

        // Poukaz ze zadaných hodnot, bez šablony
        register("voucher:create") { args in
            guard let spec = args.first as? [String: Any] else {
                throw BridgeError.message("Chybí zadání poukazu.")
            }
            return try await VoucherPdf.create(spec: spec)
        }
    }

    /// Textový parametr, který nesmí chybět.
    static func text(_ value: Any?) throws -> String {
        guard let text = value as? String, !text.isEmpty else {
            throw BridgeError.message("Chybí identifikátor.")
        }
        return text
    }
}
