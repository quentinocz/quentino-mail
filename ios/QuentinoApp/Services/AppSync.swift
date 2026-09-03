import Foundation

/**
 Synchronizace mezi zařízeními přes sdílenou složku.

 Na počítači to je složka v Dropboxu nebo na disku, tady se vybere složka
 v aplikaci Soubory — typicky iCloud Drive. Přístup k ní přežije restart
 díky záložce (`bookmark`), kterou iOS vydá při výběru; bez ní by aplikace
 po zavření ke složce už nesměla.

 Nesynchronizuje se živá databáze, ale tři soubory se stejným tvarem jako na
 počítači:

 - `state.json` — nastavení, znalosti, osoby; vyhrává novější razítko
 - `contacts.json` — našeptávač adres, slučuje se sjednocením
 - `vouchers/` — deník každého zařízení zvlášť: šablony a kódy poukazů,
   slučují se po řádcích (společný soubor by při souběžném zápisu ztrácel data)

 Hesla účtů a API klíče se ze zásady nesynchronizují — na to je záloha.
 */
enum AppSync {
    static func config() -> [String: Any] {
        [
            "folder": Store.setting("syncFolder").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "enabled": Store.bool("syncEnabled", false),
            "lastRun": Store.setting("syncLastRun").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "lastResult": Store.setting("syncLastResult").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        ]
    }

    static func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        if patch["folder"] is NSNull {
            Store.setSetting("syncFolder", "")
            Store.setSetting("syncFolderBookmark", "")
        } else if let folder = patch["folder"] as? String {
            Store.setSetting("syncFolder", folder)
        }
        if let enabled = patch["enabled"] as? Bool { Store.setSetting("syncEnabled", enabled ? "1" : "0") }
        if (Store.setting("stateStamp") ?? "").isEmpty { Store.setSetting("stateStamp", Formats.iso()) }
        return config()
    }

    /// Uloží vybranou složku i s oprávněním, které přežije restart aplikace.
    static func rememberFolder(_ url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        Store.setSetting("syncFolderBookmark", bookmark.base64EncodedString())
        Store.setSetting("syncFolder", url.path)
    }

    /// Složka i s otevřeným přístupem; volající musí zavolat `stop`.
    private static func openFolder() -> (url: URL, stop: () -> Void)? {
        guard let base64 = Store.setting("syncFolderBookmark"), !base64.isEmpty,
              let data = Data(base64Encoded: base64) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else { return nil }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            Store.setSetting("syncFolderBookmark", fresh.base64EncodedString())
        }
        let scoped = url.startAccessingSecurityScopedResource()
        return (url, { if scoped { url.stopAccessingSecurityScopedResource() } })
    }

    // MARK: - Běh

    private static var running = false

    @discardableResult
    static func run() -> String {
        guard Store.bool("syncEnabled", false) else { return "Synchronizace není zapnutá." }
        guard !running else { return "Synchronizace už běží." }
        guard let folder = openFolder() else {
            return "Synchronizační složka není dostupná — vyber ji znovu."
        }
        running = true
        defer { running = false; folder.stop() }

        var parts: [String] = []
        do {
            // 1) Stav — novější vyhrává
            let localStamp = Store.setting("stateStamp", "1970-01-01T00:00:00Z") ?? "1970-01-01T00:00:00Z"
            let remote = readJson(folder.url.appendingPathComponent("state.json")) as? [String: Any]
            let remoteStamp = remote?["updatedAt"] as? String ?? ""

            if (remote?["app"] as? String) == "quentino-mail-sync", remoteStamp > localStamp {
                applyState(folder.url, remote ?? [:])
                parts.append("nastavení přijato")
                Bridge.notify("folders:changed")
            } else if remote == nil || localStamp > remoteStamp {
                try writeState(folder.url, stamp: localStamp)
                parts.append("nastavení odesláno")
            }

            // 2) Kontakty — sjednocení
            syncContacts(folder.url)

            // 3) Poukazy — šablony i odepsané kódy, po řádcích
            syncVouchers(folder.url)

            // 4) Instagram — co už na kterém trhu vyšlo
            syncInstagram(folder.url)

            // 4b) AI přehled — postřehy dne se počítají jednou, ne na každém zařízení
            syncDigest(folder.url)

            // 5) Naskladnění — rozpracované naskladnění z telefonu na počítač
            syncStockin(folder.url)

            let summary = parts.isEmpty ? "vše aktuální" : parts.joined(separator: ", ")
            Store.setSetting("syncLastRun", Formats.iso())
            Store.setSetting("syncLastResult", summary)
            Bridge.notify("ig:changed")
            return summary
        } catch {
            let message = "chyba: \(error.readableMessage)"
            Store.setSetting("syncLastResult", message)
            return message
        }
    }

    // MARK: - Stav

    private static func writeState(_ folder: URL, stamp: String) throws {
        var settings = Settings.current()
        settings["hasApiKey"] = nil
        settings["defaultPersonId"] = nil

        let mediaDir = folder.appendingPathComponent("media", isDirectory: true)
        var persons: [[String: Any]] = []
        let all = Settings.persons()
        for person in all {
            var photoFile: Any = NSNull()
            if let path = person["photoPath"] as? String, !path.isEmpty,
               FileManager.default.fileExists(atPath: path) {
                let name = "\(stableHash(person["name"] as? String ?? ""))-\(sanitize((path as NSString).lastPathComponent))"
                let destination = mediaDir.appendingPathComponent(name)
                if !FileManager.default.fileExists(atPath: destination.path) {
                    _ = try? FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
                    _ = try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: destination)
                }
                photoFile = name
            }
            persons.append([
                "name": person["name"] ?? "",
                "positions": person["positions"] ?? [:],
                "displayNames": person["displayNames"] ?? [:],
                "photoFile": photoFile
            ])
        }

        let defaultId = Int(Store.setting("defaultPersonId", "0") ?? "0") ?? 0
        let defaultName = all.first { ($0["id"] as? Int) == defaultId }?["name"] as? String

        let state: [String: Any] = [
            "app": "quentino-mail-sync",
            "version": 1,
            "updatedAt": stamp,
            "settings": settings,
            "defaultPersonName": defaultName ?? NSNull(),
            "knowledge": Settings.knowledge().map {
                ["title": $0["title"] ?? "", "content": $0["content"] ?? ""]
            },
            "persons": persons
        ]
        try writeJson(state, to: folder.appendingPathComponent("state.json"))
    }

    private static func applyState(_ folder: URL, _ remote: [String: Any]) {
        var settings = remote["settings"] as? [String: Any] ?? [:]
        settings["hasApiKey"] = nil
        settings["anthropicApiKey"] = nil
        settings["defaultPersonId"] = nil
        Settings.save(settings)

        // Znalosti — kompletní náhrada novějším stavem
        if let knowledge = remote["knowledge"] as? [[String: Any]] {
            _ = try? SQLite.shared.run("DELETE FROM knowledge")
            for item in knowledge {
                guard let title = item["title"] as? String, !title.isEmpty else { continue }
                _ = try? SQLite.shared.run("INSERT INTO knowledge (title, content) VALUES (?,?)",
                                       [.text(title), .text(item["content"] as? String ?? "")])
            }
        }

        // Osoby — kompletní náhrada, fotky ze složky media
        if let persons = remote["persons"] as? [[String: Any]] {
            _ = try? SQLite.shared.run("DELETE FROM persons")
            for person in persons {
                guard let name = person["name"] as? String, !name.isEmpty else { continue }
                var photoPath: String?
                if let file = person["photoFile"] as? String, !file.isEmpty {
                    let source = folder.appendingPathComponent("media").appendingPathComponent(file)
                    let target = Files.scratch.appendingPathComponent(file)
                    if FileManager.default.fileExists(atPath: source.path) {
                        if !FileManager.default.fileExists(atPath: target.path) {
                            _ = try? FileManager.default.copyItem(at: source, to: target)
                        }
                        photoPath = target.path
                    }
                }
                let positions = person["positions"] as? [String: String] ?? [:]
                let display = person["displayNames"] as? [String: String] ?? [:]
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO persons (name, position, position_cz, position_sk, position_en,
                      display_cz, display_sk, display_en, photo_path)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    [
                        .text(name), .text(positions["cz"] ?? ""),
                        .text(positions["cz"] ?? ""), .text(positions["sk"] ?? ""), .text(positions["en"] ?? ""),
                        .text(display["cz"] ?? ""), .text(display["sk"] ?? ""), .text(display["en"] ?? ""),
                        photoPath.map { SQLite.Value.text($0) } ?? .null
                    ]
                )
            }
            // Výchozí osoba podle jména — ID se mezi zařízeními liší
            if let wanted = remote["defaultPersonName"] as? String {
                let match = Settings.persons().first { ($0["name"] as? String) == wanted }
                Store.setSetting("defaultPersonId", String(match?["id"] as? Int ?? 0))
            }
        }

        // Razítko srovnat s přijatým stavem — Settings.save ho posunul na „teď"
        Store.setSetting("stateStamp", remote["updatedAt"] as? String ?? Formats.iso())
    }

    // MARK: - Kontakty

    private static func syncContacts(_ folder: URL) {
        let file = folder.appendingPathComponent("contacts.json")
        if let remote = readJson(file) as? [[String: Any]] {
            for contact in remote {
                guard let email = (contact["email"] as? String)?.lowercased(), !email.isEmpty else { continue }
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO contacts (email, name, uses, last_used) VALUES (?,?,?,?)
                    ON CONFLICT(email) DO UPDATE SET
                      uses = MAX(contacts.uses, excluded.uses),
                      last_used = MAX(contacts.last_used, excluded.last_used),
                      name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END
                    """,
                    [
                        .text(email), .text(contact["name"] as? String ?? ""),
                        .int(Int64(contact["uses"] as? Int ?? 1)),
                        .text(contact["last_used"] as? String ?? Formats.iso())
                    ]
                )
            }
        }
        let all = (try? SQLite.shared.query("SELECT email, name, uses, last_used FROM contacts")) ?? []
        _ = try? writeJson(all, to: file)
    }

    // MARK: - Poukazy

    /**
     Poukazy se nesynchronizují jedním společným souborem, ale **složkou
     deníků**: každé zařízení píše jen do svého `vouchers/<zařízení>.json`
     a z ostatních jen čte.

     Důvod je prozaický. Když do jednoho souboru zapisují všichni, cloud při
     souběžném zápisu jednu verzi zahodí (nebo z ní udělá „konfliktní kopii",
     které si nikdo nevšimne) — a s ní i to, co měl jen ten jeden. U poukazů
     to znamená ztracené informace o vydaných kódech, tedy přesně to, co
     nesmí. Do vlastního souboru nemá kdo zapisovat, takže není co ztratit.

     Slučuje se po řádcích, ne „novější stav vyhrává":
     - šablona: vyhrává novější `updated_at` (i smazání, to je jen příznak),
     - vydání kódu: vyhrává vždycky (nikdy se neztratí) a platí dřívější čas,
     - rezervace: vyhrává dřívější; při shodě času rozhodne jméno zařízení,
       aby obě strany došly k témuž závěru, i když se nevidí,
     - vydání dvěma zařízeními: platí to dřívější, to druhé se zapíše jako
       kolize a aplikace na ni upozorní.

     `vouchers.json` ve starém tvaru se pořád čte i píše, aby zařízení se
     starší verzí aplikace nezůstalo stranou.
     */
    /**
     Otisk toho, co jsme naposledy zapsali do deníku. Bez něj by se soubor
     přepisoval při každém kole, i když se nic nezměnilo — a cloud by pak měl
     co dělat s prázdnými změnami místo těch skutečných.

     Klíčem je zařízení, ne jen jedna hodnota: v běžném provozu má každé
     zařízení vlastní běh aplikace, ale ve zkouškách běží vedle sebe a otisk
     jednoho by pak umlčel zápis druhého.
     */
    private static var lastJournal: [String: String] = [:]

    private static func syncVouchers(_ folder: URL) {
        let me = Device.id()
        let journals = readVoucherJournals(folder)
        var names: [String: String] = [:]
        for journal in journals {
            let device = journal["device"] as? String ?? ""
            if !device.isEmpty {
                names[device] = (journal["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? String(device.prefix(8))
            }
        }

        var clashes = 0
        var changed = 0
        _ = try? SQLite.shared.transaction {
            for journal in journals {
                if let device = journal["device"] as? String, device == me { continue }
                changed += mergeVoucherTemplates(journal["templates"] as? [[String: Any]] ?? [])
                let result = mergeVoucherCodes(journal["codes"] as? [[String: Any]] ?? [], names: names)
                clashes += result.clashes
                changed += result.changed
            }
        }

        // Rezerva na příště se doplní až po sloučení, ať se nezamlouvá kód,
        // který si mezitím zamluvil někdo jiný
        Vouchers.claimAll()

        let templates = (try? SQLite.shared.query("SELECT * FROM voucher_templates")) ?? []
        let codes = (try? SQLite.shared.query("SELECT * FROM voucher_codes")) ?? []
        let body = (try? JSONSerialization.data(withJSONObject: ["templates": templates, "codes": codes],
                                                options: [.sortedKeys])) ?? Data()
        let stamp = String(decoding: body, as: UTF8.self)
        if stamp != lastJournal[me] {
            let out: [String: Any] = [
                "device": me,
                "name": Device.label(),
                "updatedAt": Formats.iso(),
                "templates": templates,
                "codes": codes
            ]
            let mine = folder.appendingPathComponent("vouchers", isDirectory: true)
            try? FileManager.default.createDirectory(at: mine, withIntermediateDirectories: true)
            _ = try? writeJson(out, to: mine.appendingPathComponent("\(me).json"))
            // Pro zařízení se starší verzí aplikace — ta o složce deníků nevědí
            _ = try? writeJson(["templates": templates, "codes": codes],
                               to: folder.appendingPathComponent("vouchers.json"))
            lastJournal[me] = stamp
        }

        // Otevřená obrazovka s poukazy se dozví, že přibyla šablona nebo ubyl
        // kód, aniž by ji musel člověk zavřít a otevřít
        if changed > 0 { Bridge.notify("vouchers:changed") }
        if clashes > 0 { Bridge.notify("vouchers:clash") }
    }

    // MARK: - Poukazy: rychlá dráha

    /**
     Poukazy samotné, mimo velké kolo synchronizace.

     Velké kolo dělá i archiv, a ten při větší schránce trvá — po tu dobu se
     nic jiného nesynchronizuje, protože běh je jeden a hlídá si zámek. Nová
     šablona nebo ubraný kód se tak objevily na druhém zařízení klidně za pár
     minut. Poukazy proto mají vlastní, krátký běh: přečte cizí deníky, sloučí
     a zapíše ten svůj. Je to práce se dvěma malými soubory, takže může běžet
     často a hned po každé změně.
     */
    private static var vouchersRunning = false

    static func syncVouchersNow() {
        guard Store.bool("syncEnabled", false), !vouchersRunning else { return }
        guard let folder = openFolder() else { return }
        vouchersRunning = true
        defer { vouchersRunning = false; folder.stop() }
        syncVouchers(folder.url)
    }

    /**
     Odeslat změnu poukazů co nevidět.

     Odklad je schválně: při vkládání zásoby kódů nebo rychlém klepání by se
     jinak soubor přepisoval několikrát za sebou. Půl vteřiny stačí, aby se
     z několika změn stal jeden zápis, a je to pořád „hned".
     */
    private static var pushTask: Task<Void, Never>?

    static func pushVouchersSoon() {
        pushTask?.cancel()
        pushTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            /*
             Nejdřív po drátě, pak do složky. Posel doručí do vteřiny, kdežto
             složka podle toho, jak rychle cloud nahraje soubor — a u poukazů
             na tom záleží: dvě zařízení, která o sobě nevědí, můžou vydat
             týž kód dvakrát a pozná se to až u zákazníka.
             */
            publishVouchers()
            syncVouchersNow()
        }
    }

    // MARK: - Poukazy po drátě

    /**
     Strop na zprávu poslanou po drátě.

     Broadcast má omezenou velikost a deník roste s počtem kódů. Když se
     nevejde, prostě se nepošle a doručí ho složka — pomaleji, ale
     spolehlivě. Mlčky se nic neztrácí.
     */
    private static let maxLiveJournal = 200_000

    /// Deník poukazů — tentýž tvar, jaký leží ve sdílené složce.
    static func voucherJournal() -> [String: Any] {
        [
            "device": Device.id(),
            "name": Device.label(),
            "updatedAt": Formats.iso(),
            "templates": (try? SQLite.shared.query("SELECT * FROM voucher_templates")) ?? [],
            "codes": (try? SQLite.shared.query("SELECT * FROM voucher_codes")) ?? []
        ]
    }

    private static func publishVouchers() {
        let journal = voucherJournal()
        guard JSONSerialization.isValidJSONObject(journal),
              let data = try? JSONSerialization.data(withJSONObject: journal),
              data.count <= maxLiveJournal else { return }
        Live.publish("vouchers", journal)
    }

    /**
     Přijatý deník od druhého zařízení.

     Slučuje se týmž kódem jako deník ze složky — jediný rozdíl je, že sem
     dorazil po vteřině místo po minutě. Zpátky se nic neposílá: dvě zařízení
     by si zprávy přehazovala tam a zpět a srovnat zbytek je práce pro složku,
     která běží tak jako tak.
     */
    static func applyVoucherJournal(_ journal: [String: Any]) {
        guard (journal["device"] as? String) != Device.id() else { return }
        var names: [String: String] = [:]
        let device = journal["device"] as? String ?? ""
        if !device.isEmpty {
            names[device] = (journal["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? String(device.prefix(8))
        }

        var clashes = 0
        var changed = 0
        _ = try? SQLite.shared.transaction {
            changed += mergeVoucherTemplates(journal["templates"] as? [[String: Any]] ?? [])
            let result = mergeVoucherCodes(journal["codes"] as? [[String: Any]] ?? [], names: names)
            clashes += result.clashes
            changed += result.changed
        }

        if changed > 0 { Bridge.notify("vouchers:changed") }
        if clashes > 0 { Bridge.notify("vouchers:clash") }
    }

    private static func readVoucherJournals(_ folder: URL) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let dir = folder.appendingPathComponent("vouchers", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension == "json" {
            // Rozepsaný soubor se nechá být — přijde příště celý
            if let journal = readJson(file) as? [String: Any], journal["codes"] is [[String: Any]] {
                out.append(journal)
            }
        }
        // Starý společný soubor: bere se jako další zdroj, aby se nic neztratilo
        if let legacy = readJson(folder.appendingPathComponent("vouchers.json")) as? [String: Any] {
            out.append([
                "device": "",
                "name": "starší verze",
                "templates": legacy["templates"] as? [[String: Any]] ?? [],
                "codes": legacy["codes"] as? [[String: Any]] ?? []
            ])
        }
        return out
    }

    /// - Returns: kolik šablon se skutečně změnilo — podle toho se obnovuje obrazovka
    private static func mergeVoucherTemplates(_ rows: [[String: Any]]) -> Int {
        var changed = 0
        for template in rows {
            guard let id = template["id"] as? String, let name = template["name"] as? String,
                  !id.isEmpty, !name.isEmpty else { continue }
            changed += (try? SQLite.shared.run(
                """
                INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang,
                  code_mode, fixed_code, archived, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name, value = excluded.value, unit = excluded.unit,
                  valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
                  code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
                  archived = excluded.archived, updated_at = excluded.updated_at
                WHERE excluded.updated_at > voucher_templates.updated_at
                """,
                [
                    .text(id), .text(name), .text(template["value"] as? String ?? ""),
                    .text(template["unit"] as? String ?? "CZK"),
                    .text(template["valid_until"] as? String ?? ""),
                    .text(template["note"] as? String ?? ""),
                    .text(template["lang"] as? String ?? "cz"),
                    .text(template["code_mode"] as? String ?? "fixed"),
                    .text(template["fixed_code"] as? String ?? ""),
                    .int(Int64(template["archived"] as? Int ?? 0)),
                    .text(template["updated_at"] as? String ?? Formats.iso())
                ]
            ))?.changes ?? 0
        }
        return changed
    }

    /// Dřívější rezervace vyhrává; při shodě času rozhodne jméno zařízení.
    private static func claimWins(_ atA: String, _ byA: String, _ atB: String, _ byB: String) -> Bool {
        if byB.isEmpty { return false }
        if byA.isEmpty { return true }
        if atB != atA { return atB < atA }
        return byB < byA
    }

    private static func mergeVoucherCodes(_ rows: [[String: Any]], names: [String: String]) -> (clashes: Int, changed: Int) {
        var clashes = 0
        var changed = 0
        for row in rows {
            guard let templateId = row["template_id"] as? String, let value = row["code"] as? String,
                  !templateId.isEmpty, !value.isEmpty else { continue }

            let local = (try? SQLite.shared.query(
                "SELECT * FROM voucher_codes WHERE template_id = ? AND code = ?",
                [.text(templateId), .text(value)]
            ))?.first

            let remoteUsedAt = row["used_at"] as? String
            let remoteUsedBy = row["used_by"] as? String ?? ""
            let remoteUsedFor = row["used_for"] as? String ?? ""
            let remoteClaimBy = row["claimed_by"] as? String ?? ""
            let remoteClaimAt = row["claimed_at"] as? String ?? ""
            let remoteDup = row["used_dup"] as? String ?? ""

            guard let local else {
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO voucher_codes (template_id, code, used_at, used_for, used_by,
                      claimed_by, claimed_at, used_dup, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    [
                        .text(templateId), .text(value),
                        remoteUsedAt.map { SQLite.Value.text($0) } ?? .null,
                        .text(remoteUsedFor), .text(remoteUsedBy),
                        .text(remoteClaimBy), .text(remoteClaimAt), .text(remoteDup),
                        .text(row["created_at"] as? String ?? Formats.iso())
                    ]
                )
                if !remoteDup.isEmpty { clashes += 1 }
                changed += 1
                continue
            }

            var usedAt = local["used_at"] as? String
            var usedFor = local["used_for"] as? String ?? ""
            var usedBy = local["used_by"] as? String ?? ""
            var dup = (local["used_dup"] as? String ?? "").isEmpty
                ? remoteDup : (local["used_dup"] as? String ?? "")

            if let remoteUsedAt {
                if usedAt == nil {
                    usedAt = remoteUsedAt; usedFor = remoteUsedFor; usedBy = remoteUsedBy
                } else if !usedBy.isEmpty, !remoteUsedBy.isEmpty, usedBy != remoteUsedBy {
                    // Tentýž kód vydala dvě zařízení. Platí dřívější vydání, to
                    // druhé se zapíše jako kolize — člověk musí vědět, že poukaz
                    // mají dva lidi.
                    let remoteFirst = remoteUsedAt < usedAt!
                    let loserBy = remoteFirst ? usedBy : remoteUsedBy
                    let loserAt = remoteFirst ? usedAt! : remoteUsedAt
                    if remoteFirst {
                        usedAt = remoteUsedAt; usedFor = remoteUsedFor; usedBy = remoteUsedBy
                    }
                    if dup.isEmpty {
                        dup = "\(names[loserBy] ?? String(loserBy.prefix(8)))@\(loserAt)"
                        clashes += 1
                    }
                } else if remoteUsedAt < usedAt! {
                    usedAt = remoteUsedAt; usedFor = remoteUsedFor
                    if !remoteUsedBy.isEmpty { usedBy = remoteUsedBy }
                }
            }

            // Rezervace řeší jen dosud nevydané kódy — u vydaného už nemá co rozhodovat
            var claimBy = local["claimed_by"] as? String ?? ""
            var claimAt = local["claimed_at"] as? String ?? ""
            if usedAt == nil, claimWins(claimAt, claimBy, remoteClaimAt, remoteClaimBy) {
                claimBy = remoteClaimBy; claimAt = remoteClaimAt
            }
            if usedAt != nil, !usedBy.isEmpty { claimBy = usedBy }

            let unchanged = usedAt == (local["used_at"] as? String)
                && usedFor == (local["used_for"] as? String ?? "")
                && usedBy == (local["used_by"] as? String ?? "")
                && claimBy == (local["claimed_by"] as? String ?? "")
                && claimAt == (local["claimed_at"] as? String ?? "")
                && dup == (local["used_dup"] as? String ?? "")
            if unchanged { continue }

            _ = try? SQLite.shared.run(
                """
                UPDATE voucher_codes
                SET used_at = ?, used_for = ?, used_by = ?, claimed_by = ?, claimed_at = ?, used_dup = ?
                WHERE template_id = ? AND code = ?
                """,
                [
                    usedAt.map { SQLite.Value.text($0) } ?? .null,
                    .text(usedFor), .text(usedBy), .text(claimBy), .text(claimAt), .text(dup),
                    .text(templateId), .text(value)
                ]
            )
            changed += 1
        }
        return (clashes, changed)
    }

    /**
     Co už na kterém trhu vyšlo.

     Publikace je jednosměrný fakt. Když se reels publikuje na německý trh
     z počítače, telefon o tom neví a nabízí ho k publikaci znovu. Rozepsané
     popisky se synchronizovat nedají — ty popisují práci na konkrétním
     zařízení a slévat je by znamenalo hádat, čí verze je ta správná. Zato
     „tenhle příspěvek na tomhle trhu vyšel" platí všude stejně.

     Slučuje se proto sjednocením a nikdy se nic neruší; při shodě platí
     dřívější čas, protože první publikace je ta pravá. Klíčem je
     Instagramové id zdrojového příspěvku — místní čísla řádků jsou na
     každém zařízení jiná.
     */
    /**
     Postřehy z AI přehledu.

     Vznikají jednou za den a jsou pro všechna zařízení stejné — každé si je
     počítat zvlášť znamená platit totéž čtyřikrát. Živý posel je pošle hned,
     tohle je pojistka pro zařízení, které bylo vypnuté: **novější vyhrává**,
     slučovat se nemá co.
     */
    private static func syncDigest(_ folder: URL) {
        let file = folder.appendingPathComponent("digest.json")
        let remote = readJson(file) as? [String: Any]
        if let remote { Digest.applyShare(remote) }

        guard let mine = Digest.share() else { return }
        let insight = remote?["insight"] as? [String: Any]
        let remoteAt = (insight?["at"] as? String) ?? (remote?["at"] as? String) ?? ""
        if (mine["at"] as? String ?? "") > remoteAt { _ = try? writeJson(mine, to: file) }
    }

    private static func syncInstagram(_ folder: URL) {
        let file = folder.appendingPathComponent("instagram.json")
        let remote = readJson(file) as? [String: Any]

        for row in remote?["published"] as? [[String: Any]] ?? [] {
            guard let media = row["source_media_id"] as? String, !media.isEmpty,
                  let lang = row["lang"] as? String, !lang.isEmpty else { continue }
            _ = try? SQLite.shared.run(
                """
                INSERT INTO ig_published (source_media_id, lang, at, permalink, ig_media_id)
                VALUES (?,?,?,?,?)
                ON CONFLICT(source_media_id, lang) DO UPDATE SET
                  at = CASE WHEN ig_published.at = '' OR excluded.at < ig_published.at
                            THEN excluded.at ELSE ig_published.at END,
                  permalink = CASE WHEN ig_published.permalink = ''
                                   THEN excluded.permalink ELSE ig_published.permalink END,
                  ig_media_id = CASE WHEN ig_published.ig_media_id = ''
                                     THEN excluded.ig_media_id ELSE ig_published.ig_media_id END
                """,
                [
                    .text(media), .text(lang.uppercased()),
                    .text(row["at"] as? String ?? ""),
                    .text(row["permalink"] as? String ?? ""),
                    .text(row["ig_media_id"] as? String ?? "")
                ]
            )
        }

        let out: [String: Any] = [
            "published": (try? SQLite.shared.query("SELECT * FROM ig_published")) ?? []
        ]
        _ = try? writeJson(out, to: file)
    }

    /**
     Rozpracované naskladnění z telefonu se musí objevit na počítači.

     Zboží se počítá u regálu s telefonem v ruce, ale do e-shopu se zapisuje
     z počítače — okno administrace je jen tam. Naskladnění proto putuje stejnou
     sdílenou složkou jako poukazy a slučuje se po řádcích, takže je jedno,
     kdo co přidal dřív.
     */
    private static func syncStockin(_ folder: URL) {
        let file = folder.appendingPathComponent("stockin.json")
        if let remote = readJson(file) as? [String: Any] { Stockin.merge(remote) }
        _ = try? writeJson(Stockin.export(), to: file)
        Bridge.notify("stockin:changed")
    }

    // MARK: - Soubory

    private static func sanitize(_ text: String) -> String {
        String(text.map { $0.isLetter || $0.isNumber || "@._-".contains($0) ? $0 : "_" }.prefix(80))
    }

    private static func readJson(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// Zápis vždy naráz — kdyby aplikaci systém uspal uprostřed, druhé
    /// zařízení by jinak našlo půlku souboru.
    private static func writeJson(_ object: Any, to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    /// Stabilní otisk (FNV-1a). `hashValue` se v každém spuštění liší, takže
    /// by fotky ve sdílené složce vznikaly pořád znovu pod jiným jménem.
    private static func stableHash(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16).padding(toLength: 12, withPad: "0", startingAt: 0)
    }
}
