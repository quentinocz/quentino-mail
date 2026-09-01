import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 Obchodní kanály (produkty, Upgates, objednávky, balení) a drobnosti kolem souborů.

 Původně tu byly i kanály hlásící „tohle na telefonu zatím není"; od doplnění
 rozboru objednávek, sledování zásilek a balení už žádný takový nezbyl.
 */
extension Bridge {
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

        // MARK: Katalog, varianty a zásoby
        //
        // Štítky ani zápis do administrace tu nejsou: tisk PDF a okno
        // s naskladňováním v Upgates existují jen na počítači. Telefon
        // naskladnění připraví, počítač ji zapíše — rozhraní to tak i ukazuje.

        register("catalog:detail") { args in Catalog.detail(args.first as? String ?? "") }
        register("catalog:scan") { args in Catalog.find(args.first as? String ?? "") }
        register("catalog:suggest") { args in
            Catalog.suggest(args.first as? String ?? "",
                            limit: args.count > 1 ? (args[1] as? Int ?? 8) : 8)
        }
        register("catalog:stockAt") { _ in Catalog.stockSyncedAt() }
        register("catalog:refreshStock") { _ in try await Catalog.refreshStock() }

        // MARK: Naskladnění

        register("stockin:list") { _ in Stockin.list() }
        register("stockin:create") { args in Stockin.create(args.first as? String ?? "") }
        register("stockin:open") { args in
            let id = args.first as? String ?? ""
            return ["session": Stockin.session(id), "items": Stockin.items(id)]
        }
        register("stockin:scan") { args in
            let out = Stockin.scan(
                args.first as? String ?? "",
                args.count > 1 ? (args[1] as? String ?? "") : "",
                qty: args.count > 2 ? (args[2] as? Int ?? 1) : 1
            )
            if out["added"] as? Bool == true { Bridge.notify("stockin:changed") }
            return out
        }
        register("stockin:qty") { args in
            Stockin.setQty(args.first as? String ?? "",
                           args.count > 1 ? (args[1] as? String ?? "") : "",
                           args.count > 2 ? (args[2] as? Int ?? 0) : 0)
            Bridge.notify("stockin:changed")
            return true
        }
        register("stockin:rename") { args in
            Stockin.rename(args.first as? String ?? "",
                           title: args.count > 1 ? (args[1] as? String ?? "") : "",
                           note: args.count > 2 ? (args[2] as? String ?? "") : "")
            Bridge.notify("stockin:changed")
            return true
        }
        register("stockin:delete") { args in
            Stockin.remove(args.first as? String ?? "")
            Bridge.notify("stockin:changed")
            return true
        }
        register("stockin:plan") { args in Stockin.plan(args.first as? String ?? "") }

        // MARK: Čtečka kódů fotoaparátem
        //
        // Hledáček zůstane otevřený a kódy chodí do rozhraní po jednom
        // událostí `scan:code`; rozhraní pošle zpátky větu, která se ukáže
        // rovnou nad tlačítkem v hledáčku.

        register("scan:available") { _ in await CodeScanner.available() }
        register("scan:start") { args in
            let opts = args.first as? [String: Any] ?? [:]
            return try await CodeScanner.start(
                panel: opts["panel"] as? Bool ?? false,
                qty: opts["qty"] as? Bool ?? true
            )
        }
        register("scan:stop") { _ in await CodeScanner.stop(); return true }
        register("scan:feedback") { args in
            let text = args.first as? String ?? ""
            let ok = args.count > 1 ? (args[1] as? Bool ?? true) : true
            await CodeScanner.feedback(text, ok: ok)
            return true
        }
        register("scan:count") { args in
            await CodeScanner.count(args.first as? Int ?? 1)
            return true
        }
        /*
         Zapisuje se z počítače, ne odsud. Kdyby kanál chyběl úplně, dostalo
         by rozhraní neurčité „neznámý kanál"; takhle se dozví proč.
         */
        register("stockin:sendWindow") { _ in
            throw BridgeError.message("Naskladnění se do Upgates zapisuje z počítače — "
                + "naskladnění se tam objeví po synchronizaci.")
        }
        register("stockin:sendApi") { _ in
            throw BridgeError.message("Naskladnění se do Upgates zapisuje z počítače.")
        }
        register("stockin:confirm") { args in
            Stockin.markSent(args.first as? String ?? "")
            Bridge.notify("stockin:changed")
            return true
        }

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

        // MARK: Objednávka u zprávy

        register("orders:card") { args in
            let withLive = args.count > 1 ? (args[1] as? Bool ?? true) : true
            return await Orders.card(dbId: try Self.int(args.first), withLive: withLive)
        }
        register("orders:refresh") { args in
            // Ruční obnovení nesmí sáhnout do uložené karty, jinak by tlačítko
            // u uzavřené objednávky nedělalo nic
            await Orders.card(dbId: try Self.int(args.first), withLive: true, withRendered: true, force: true)
        }
        register("orders:badge") { args in await Orders.badge(dbId: try Self.int(args.first)) }
        register("orders:shipment") { args in
            let force = args.count > 1 ? (args[1] as? Bool ?? false) : false
            return await Orders.shipment(dbId: try Self.int(args.first), force: force)
        }

        // MARK: Projekty Supabase
        //
        // Bezplatný tarif je po pár dnech ticha uspí. Aplikace jich používá
        // víc (chat, úložiště médií pro Instagram) a můžou to být i dva
        // různé projekty.

        register("supabase:status") { _ in KeepAlive.status() }
        register("supabase:ping") { _ in
            let result = await KeepAlive.keepAwake(force: true)
            return ["result": result, "status": KeepAlive.status()]
        }

        // MARK: Feed objednávek
        //
        // Kvůli telefonu na zákazníka: potvrzovací e-mail ho většinou nemá,
        // export objednávek ano. Na telefonu z toho je jedno klepnutí na
        // „Zavolat" místo hledání v administraci.

        register("orderfeed:list") { _ in
            ["feeds": OrderFeed.statuses(), "stats": OrderFeed.stats()]
        }
        register("orderfeed:save") { args in
            let saved = OrderFeed.save(args.first as? [[String: Any]] ?? [])
            return ["feeds": saved, "stats": OrderFeed.stats()]
        }
        register("orderfeed:refresh") { args in
            let result: [[String: Any]]
            if let id = args.first as? String, !id.isEmpty {
                result = [["feed": id, "orders": try await OrderFeed.refresh(id: id)]]
            } else {
                result = await OrderFeed.refreshDue(force: true)
            }
            return ["result": result, "feeds": OrderFeed.statuses(), "stats": OrderFeed.stats()]
        }
        register("orderfeed:contact") { args in
            OrderFeed.contact(args.first as? [String: Any] ?? [:])
        }
        register("orderfeed:byEmail") { args in
            let limit = args.count > 1 ? (args[1] as? Int ?? 12) : 12
            return OrderFeed.byEmail(args.first as? String ?? "", limit: limit)
        }
        register("orderfeed:byCode") { args in
            OrderFeed.byCode(args.first as? String ?? "") ?? NSNull()
        }

        // MARK: Vazby zpráv na objednávky

        register("orderlinks:refresh") { _ in OrderLinks.refresh() }
        register("orderlinks:pending") { args in
            OrderLinks.pendingCount(accountId: try? Self.int(args.first))
        }
        register("orderlinks:resolve") { args in
            OrderLinks.setResolved(messageId: try Self.int(args.first),
                                   value: args.count > 1 ? (args[1] as? Bool ?? false) : false)
            return true
        }

        // MARK: Balení objednávek

        register("packing:scan") { args in
            let days = (try? Self.int(args.first)) ?? 7
            let force = args.count > 1 ? (args[1] as? Bool ?? false) : false
            return await Packing.scan(days: days, force: force)
        }
        register("packing:setItem") { args in
            Packing.setItem(messageId: try Self.int(args.first),
                            index: try Self.int(args.count > 1 ? args[1] : nil),
                            value: args.count > 2 ? (args[2] as? Bool ?? false) : false)
        }
        register("packing:setCount") { args in
            Packing.setCount(messageId: try Self.int(args.first),
                             index: try Self.int(args.count > 1 ? args[1] : nil),
                             count: (try? Self.int(args.count > 2 ? args[2] : nil)) ?? 0)
        }
        register("packing:scanItem") { args in
            Packing.scanItem(messageId: try Self.int(args.first),
                             raw: args.count > 1 ? (args[1] as? String ?? "") : "")
        }
        // MARK: Upozornění na telefon
        //
        // Téma se generuje na počítači i tady stejně; SQL pro Supabase se
        // odsud nenabízí — do databáze se stejně sahá z počítače.
        register("notify:topic") { _ in
            let abc = Array("abcdefghijklmnopqrstuvwxyz0123456789")
            return "quentino-" + String((0..<24).map { _ in abc.randomElement()! })
        }
        register("notify:test") { args in
            await Notify.test(server: args.first as? String ?? "",
                              topic: args.count > 1 ? (args[1] as? String ?? "") : "")
        }
        register("notify:chatSql") { _ in
            throw BridgeError.message("Nastavení chatu v Supabase se dělá na počítači — "
                + "je to jednorázové vložení SQL do administrace projektu.")
        }

        register("packing:mailFor") { args in
            Packing.mailForOrder(args.first as? String ?? "") ?? NSNull()
        }
        register("packing:openOrder") { args in
            await Packing.openOrder(args.first as? String ?? "")
        }
        register("packing:setDone") { args in
            Packing.setDone(messageId: try Self.int(args.first),
                            value: args.count > 1 ? (args[1] as? Bool ?? false) : false)
            return true
        }
        register("packing:reset") { args in
            Packing.reset(messageId: try Self.int(args.first))
            return true
        }

        // MARK: Hlášky dopravců

        register("ship:relearn") { args in
            guard let text = args.first as? String, args.count > 1, let phase = args[1] as? String else {
                throw BridgeError.message("Chybí hláška nebo fáze.")
            }
            ShipPhase.relearn(text: text, phase: phase)
            return true
        }
    }

    func registerFileChannels() {
        // Otevření odkazu v prohlížeči
        // Schémata jsou vyjmenovaná schválně — cokoli jiného by ze stránky
        // mohlo spustit jinou aplikaci. `tel:` je tu kvůli volání zákazníkovi.
        register("shell:openUrl") { args in
            guard let text = args.first as? String,
                  text.hasPrefix("https://") || text.hasPrefix("tel:") || text.hasPrefix("mailto:")
            else { return false }
            await Self.openExternally(text)
            return true
        }

        // Náhled obrázku z disku jako data URI (podpis, poukazy, chat)
        register("files:readAsDataUrl") { args in
            guard let raw = args.first as? String else { throw BridgeError.message("Chybí cesta k souboru.") }
            guard let path = Files.resolve(raw) else {
                throw BridgeError.message("Soubor už na zařízení není.")
            }
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
                guard let raw = args.first as? String, let path = Files.resolve(raw) else {
                    throw BridgeError.message("Soubor už na zařízení není.")
                }
                await Files.share(URL(fileURLWithPath: path))
                return true
            }
        }
    }
}

/// Sdílení souborů, odkládací složka a dohledání souborů po přeinstalaci.
enum Files {
    /**
     Cesta k souboru uloženému aplikací.

     iOS dává aplikaci při každé nové instalaci jiný kontejner
     (`…/Application/<jiné UUID>/…`), takže absolutní cesta uložená v databázi
     po aktualizaci ukazuje do prázdna — logo v podpisu nebo fotka osoby pak
     „zmizí", i když soubor pořád existuje. Když na původní cestě nic není,
     zkusí se stejný soubor v dnešním kontejneru: nejdřív celý zbytek cesty za
     složkou `Quentino`, pak aspoň jméno souboru ve známých podsložkách.

     Vrací `nil`, jen když soubor opravdu nikde není.
     */
    static func resolve(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        let manager = FileManager.default
        if manager.fileExists(atPath: path) { return path }

        let support = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        if let range = path.range(of: "/Quentino/", options: .backwards) {
            let tail = String(path[range.upperBound...])
            let candidate = support.appendingPathComponent("Quentino").appendingPathComponent(tail).path
            if manager.fileExists(atPath: candidate) { return candidate }
        }

        let name = (path as NSString).lastPathComponent
        guard !name.isEmpty else { return nil }
        for folder in ["soubory", "posta", "ig-media", "ig-thumbs", "osoby", "poukazy"] {
            let candidate = support
                .appendingPathComponent("Quentino/\(folder)", isDirectory: true)
                .appendingPathComponent(name).path
            if manager.fileExists(atPath: candidate) { return candidate }
        }
        return nil
    }

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
