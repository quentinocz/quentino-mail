import Foundation

/**
 Kanály dárkových poukazů.

 Šablony i zásoba kódů leží ve stejných tabulkách jako na počítači, takže
 poukaz vydaný z telefonu se na Macu po synchronizaci pozná jako použitý.
 */
extension Bridge {
    func registerVoucherChannels() {
        register("vouchers:list") { _ in Vouchers.templates() }
        register("vouchers:save") { args in
            try Vouchers.saveTemplate(args.first as? [String: Any] ?? [:])
        }
        register("vouchers:delete") { args in
            Vouchers.deleteTemplate(id: try Self.text(args.first))
        }
        register("vouchers:addCodes") { args in
            Vouchers.addCodes(
                templateId: try Self.text(args.first),
                raw: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
        }
        register("vouchers:codes") { args in
            Vouchers.codes(templateId: try Self.text(args.first))
        }
        register("vouchers:deleteCode") { args in
            Vouchers.deleteCode(
                templateId: try Self.text(args.first),
                code: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
        }
        register("vouchers:release") { args in
            Vouchers.releaseCode(
                templateId: try Self.text(args.first),
                code: args.count > 1 ? (args[1] as? String ?? "") : ""
            )
            return true
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
                return ["code": taken.code, "remaining": taken.remaining, "files": files]
            } catch {
                Vouchers.releaseCode(templateId: templateId, code: taken.code)
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
