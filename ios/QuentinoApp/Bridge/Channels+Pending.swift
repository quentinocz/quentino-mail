import Foundation
import UIKit

/**
 Kanály, které na iOS teprve vzniknou.

 Registrují se schválně — rozhraní pak místo ticha dostane větu, co ještě
 chybí, a v aplikaci je hned vidět, kam sáhnout dřív. Jak které služby
 přibývají, mizí odsud řádky.

 Pár drobností, které jdou udělat rovnou (otevření odkazu, náhled souboru),
 je hotových tady.
 */
extension Bridge {
    private func pending(_ channels: [String], _ note: String) {
        for channel in channels {
            register(channel) { _ in throw BridgeError.message("\(note) (\(channel))") }
        }
    }

    func registerMailChannels() {
        pending([
            "accounts:list", "accounts:save", "accounts:delete", "accounts:test",
            "folders:list", "sync:folder", "sync:all",
            "messages:list", "messages:get", "messages:thread", "messages:setFlag",
            "messages:delete", "messages:move", "messages:archive", "messages:categorize",
            "messages:bulkFlag", "messages:bulkDelete", "messages:bulkArchive", "trash:empty",
            "send:now", "send:schedule", "outbox:list", "outbox:cancel", "outbox:processNow",
            "quota:get", "stats:categories", "messages:exportPdf"
        ], "Pošta se na iPhonu a iPadu teprve dodělává")
    }

    func registerInstagramChannels() {
        pending([
            "ig:overview", "ig:saveConnection", "ig:installCallback", "ig:testStorage",
            "ig:connect", "ig:addMarket", "ig:connectToken", "ig:pasteCallback", "ig:finishConnect",
            "ig:disconnect", "ig:setSource", "ig:setShareFb", "ig:limit",
            "ig:markets", "ig:saveMarket", "ig:deleteMarket", "ig:brand", "ig:saveBrand",
            "ig:feed", "ig:sync", "ig:thumb", "ig:createFromSource",
            "ig:pickMedia", "ig:preview", "ig:createDraft", "ig:updateDraft", "ig:post", "ig:drafts",
            "ig:deletePost", "ig:warnings", "ig:generate", "ig:blankCaptions", "ig:chooseVariant",
            "ig:editCaption", "ig:publish", "ig:publishPost", "ig:jobs", "ig:cancelJob",
            "ig:retryJob", "ig:runQueue", "ig:refreshTokens", "ig:retryFacebook", "ig:relogin"
        ], "Sociální sítě se na mobil chystají")
    }

    func registerShopChannels() {
        pending([
            "products:search", "products:refresh", "products:status", "products:list", "products:facets",
            "contacts:search", "upgates:config", "upgates:saveConfig", "upgates:test", "upgates:orders",
            "orders:card", "orders:badge", "orders:refresh", "orders:shipment",
            "orderlinks:refresh", "orderlinks:pending", "orderlinks:resolve",
            "packing:scan", "packing:setItem", "packing:setDone", "packing:reset",
            "customer:context", "customer:conversation", "customer:messageText", "ship:relearn",
            "voucher:create", "vouchers:list", "vouchers:save", "vouchers:delete", "vouchers:addCodes",
            "vouchers:codes", "vouchers:deleteCode", "vouchers:release", "vouchers:use"
        ], "Objednávky a poukazy se doplní po poště")
    }

    func registerFileChannels() {
        // Otevření odkazu v prohlížeči — funguje hned
        register("shell:openUrl") { args in
            guard let text = args.first as? String, let url = URL(string: text),
                  text.hasPrefix("https://") else { return false }
            await MainActor.run { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
            return true
        }

        // Náhled obrázku z disku jako data URI (používá podpis a poukazy)
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
                "gif": "image/gif", "webp": "image/webp"
            ]
            let type = mime[url.pathExtension.lowercased()] ?? "application/octet-stream"
            return "data:\(type);base64,\(data.base64EncodedString())"
        }

        pending([
            "files:openAttachment", "files:showInFolder", "files:pickAttachments",
            "files:pickImage", "files:saveTempImage",
            "config:export", "config:import", "config:importUnlock",
            "appsync:get", "appsync:save", "appsync:run", "appsync:pickFolder"
        ], "Práce se soubory a synchronizace se dodělává")
    }
}
