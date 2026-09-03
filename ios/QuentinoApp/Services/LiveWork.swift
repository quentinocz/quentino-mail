import Foundation

/**
 Co se stane, když od počítače něco přijde.

 Oddělené od `Live.swift` schválně: ten umí jen poslat a přijmout zprávu
 a neví nic o naskladnění ani o balení. Teprve tady se to spojuje dohromady.

 Na telefonu se nic nenabízí proužkem jako na počítači — kdo drží telefon
 v ruce, dívá se na to, co dělá. Přijatá změna se uloží a obrazovka se
 obnoví sama, protože seznam poslouchá na `stockin:changed` stejně, jako
 když se změní něco tady.
 */
enum LiveWork {
    static func start() {
        Live.onMessage = { message in
            let kind = message["kind"] as? String ?? ""
            switch kind {
            case "hello": answerHello()
            case "stockin": takeStockin(message["data"])
            case "packing": takePacking(message["data"])
            /*
             Poukazy se jen sloučí. Není to rozdělaná práce, na kterou by se
             dalo „přejít" — je to fakt o tom, který kód je vydaný, a ten
             platí všude stejně.
             */
            case "vouchers":
                if let journal = message["data"] as? [String: Any] {
                    AppSync.applyVoucherJournal(journal)
                }
            /*
             Postřehy z AI přehledu. Vznikají jednou za den a jsou pro
             všechna zařízení stejné — kdo je udělá první, pošle je
             ostatním, aby je nemuseli platit znovu.
             */
            case "digest":
                if Digest.applyShare(message["data"]) {
                    Bridge.current?.emitAsync("digest:changed")
                }
            default: break
            }
        }
        if Live.isEnabled() { Live.start() }
    }

    /**
     Někdo se právě připojil a ptá se, co je rozdělané.

     Odpovídá se jen otevřeným naskladněním — hotová druhou stranu
     nezajímají a poslat všechno by znamenalo velkou zprávu při každém
     zapnutí aplikace.
     */
    private static func answerHello() {
        let rows = (try? SQLite.shared.query(
            "SELECT id FROM stockin WHERE state = 'open' ORDER BY updated_at DESC LIMIT 3"
        )) ?? []
        for row in rows {
            let id = row["id"] as? String ?? ""
            if !id.isEmpty, let slice = Stockin.slice(id) {
                Live.publish("stockin", slice)
            }
        }
    }

    private static func takeStockin(_ data: Any?) {
        guard let payload = data as? [String: Any] else { return }
        Stockin.merge(payload)
        Bridge.notify("stockin:changed")
    }

    private static func takePacking(_ data: Any?) {
        guard let payload = data as? [String: Any] else { return }
        guard let applied = Packing.applyRemote(payload) else { return }
        // Se stavem, ne jen jako „něco se změnilo" — okno si ho promítne
        // rovnou do zaškrtávátek
        Bridge.notify("packing:changed", applied)
    }
}
