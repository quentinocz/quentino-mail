import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 Kanály, které na iOS teprve vzniknou, a drobnosti kolem souborů.

 Nehotové kanály se registrují schválně — rozhraní pak místo ticha dostane
 větu, co ještě chybí, a v aplikaci je hned vidět, kam sáhnout dřív. Jak které
 služby přibývají, mizí odsud řádky.
 */
extension Bridge {
    private func pending(_ channels: [String], _ note: String) {
        for channel in channels {
            register(channel) { _ in throw BridgeError.message("\(note) (\(channel))") }
        }
    }

    func registerShopChannels() {
        // MARK: Katalog produktů

        register("products:search") { args in
            Products.search(args.first as? String ?? "")
        }
        register("products:list") { args in
            Products.list(args.first as? [String: Any] ?? [:])
        }
        register("products:facets") { _ in Products.facets() }
        register("products:status") { _ in Products.status() }
        register("products:refresh") { _ in try await Products.refresh() }

        register("contacts:search") { args in
            Customer.search(contacts: args.first as? String ?? "")
        }

        // MARK: Upgates

        register("upgates:config") { _ in Upgates.config() }
        register("upgates:saveConfig") { args in
            Upgates.saveConfig(args.first as? [String: Any] ?? [:])
        }
        register("upgates:test") { _ in try await Upgates.test() }
        register("upgates:orders") { args in
            try await Upgates.orders(email: args.first as? String ?? "")
        }

        // MARK: Zákazník

        register("customer:context") { args in
            await Customer.context(email: args.first as? String ?? "", withBodies: false)
        }
        register("customer:conversation") { args in
            await Customer.context(email: args.first as? String ?? "", withBodies: true)
        }
        register("customer:messageText") { args in
            try await Customer.messageText(try Self.int(args.first))
        }

        // Karty objednávek a balení stojí na rozboru potvrzovacích e-mailů
        // a na stahování stránek dopravců. Na telefonu se to nehodí (je to
        // práce u počítače), takže se hlásí poctivě, že to tu není.
        pending([
            "orders:card", "orders:badge", "orders:refresh", "orders:shipment",
            "orderlinks:refresh", "orderlinks:pending", "orderlinks:resolve",
            "packing:scan", "packing:setItem", "packing:setDone", "packing:reset",
            "ship:relearn"
        ], "Objednávkové karty a balení jsou zatím jen na počítači")
    }

    func registerFileChannels() {
        // Otevření odkazu v prohlížeči
        register("shell:openUrl") { args in
            guard let text = args.first as? String, text.hasPrefix("https://") else { return false }
            await Self.openExternally(text)
            return true
        }

        // Náhled obrázku z disku jako data URI (podpis, poukazy, chat)
        register("files:readAsDataUrl") { args in
            guard let path = args.first as? String else { throw BridgeError.message("Chybí cesta k souboru.") }
            let url = URL(fileURLWithPath: path)
            guard let data = try? Data(contentsOf: url) else {
                throw BridgeError.message("Soubor se nepodařilo přečíst.")
            }
            guard data.count <= 5 * 1024 * 1024 else {
                throw BridgeError.message("Obrázek je příliš velký (max 5 MB).")
            }
            let mime: [String: String] = [
                "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp", "pdf": "application/pdf"
            ]
            let type = mime[url.pathExtension.lowercased()] ?? "application/octet-stream"
            return "data:\(type);base64,\(data.base64EncodedString())"
        }

        register("knowledge:importFile") { _ in
            guard let url = await MediaPicker.pickFile(types: [.plainText, .html, .commaSeparatedText, .text]) else {
                return NSNull()
            }
            guard let raw = try? Data(contentsOf: url),
                  let content = String(data: raw, encoding: .utf8) ?? String(data: raw, encoding: .isoLatin2) else {
                throw BridgeError.message("Soubor se nepodařilo přečíst jako text.")
            }
            let title = (url.deletingPathExtension().lastPathComponent)
            return ["title": title, "content": String(content.prefix(100_000))]
        }

        register("files:pickAttachments") { _ in await MediaPicker.pickDocuments() }
        register("files:pickImage") { _ in await MediaPicker.pickImage() }

        // Obrázek vložený do textu (podpis, poukaz) — uloží se do složky aplikace
        register("files:saveTempImage") { args in
            guard let name = args.first as? String, args.count > 1, let base64 = args[1] as? String else {
                throw BridgeError.message("Chybí obrázek.")
            }
            let clean = base64.contains(",") ? String(base64.split(separator: ",").last ?? "") : base64
            guard let data = Data(base64Encoded: clean) else {
                throw BridgeError.message("Obrázek se nepodařilo přečíst.")
            }
            let target = Files.scratch.appendingPathComponent(name.isEmpty ? "obrazek.png" : name)
            try data.write(to: target)
            return target.path
        }

        // Na iOS není „složka se souborem"; obojí proto otevře systémové sdílení,
        // odkud jde soubor uložit, poslat dál nebo zobrazit v náhledu.
        for channel in ["files:openAttachment", "files:showInFolder"] {
            register(channel) { args in
                guard let path = args.first as? String, FileManager.default.fileExists(atPath: path) else {
                    throw BridgeError.message("Soubor už na zařízení není.")
                }
                await Files.share(URL(fileURLWithPath: path))
                return true
            }
        }
    }
}

/// Sdílení souborů a odkládací složka.
enum Files {
    static var scratch: URL {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Quentino/soubory", isDirectory: true)
        _ = try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @MainActor
    static func share(_ url: URL) {
        guard let host = MediaPicker.topViewController() else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // Na iPadu musí mít nabídka z čeho vyjet, jinak spadne
        sheet.popoverPresentationController?.sourceView = host.view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: host.view.bounds.midX, y: host.view.bounds.maxY - 60, width: 1, height: 1
        )
        host.present(sheet, animated: true)
    }
}
