import BackgroundTasks
import Foundation
import UIKit

/**
 Probouzení na pozadí.

 Bez tohohle ví aplikace o nové poště jen tehdy, když se na ni někdo dívá:
 `Scheduler` běží v popředí a na pozadí systém aplikaci zmrazí. Upozornění na
 poštu přitom posílá počítač — a ten bývá vypnutý.

 `BGAppRefreshTask` je jediná cesta, jak se bez placeného účtu u Applu dostat
 k běhu na pozadí. Systém si sám rozhodne, kdy úlohu pustí: řídí se tím, jak
 často aplikaci otvíráš, jestli je telefon na nabíječce a na Wi-Fi. Reálně to
 znamená několikrát denně, ne každých pár minut — je to záchranná síť, ne
 okamžité doručení, a rozhraní to tak i popisuje.

 Úloha musí doběhnout rychle (systém dává řádově půl minuty) a **vždycky**
 zavolat `setTaskCompleted`, jinak si iOS příště nechá zajít chuť.

 Režimy `fetch` a `processing` už jsou v `ios/project.yml`; k tomu patří klíč
 `BGTaskSchedulerPermittedIdentifiers` se stejným názvem, jaký se registruje tady.
 */
enum Background {
    /// Musí se shodovat s BGTaskSchedulerPermittedIdentifiers v project.yml
    static let refreshId = "cz.quentino.app.refresh"

    /**
     Registruje se ještě před tím, než aplikace doběhne start.

     iOS vyžaduje, aby byl handler zaregistrovaný do konce `didFinishLaunching`
     — pozdější registrace skončí výjimkou.
     */
    static func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: refreshId, using: nil
        ) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(task)
        }
    }

    /**
     Objedná další probuzení.

     Plánuje se po každém doběhnutí a při odchodu do pozadí — jedna objednávka
     platí na jedno probuzení, takže bez tohohle by se aplikace probudila
     jednou a nikdy víc. `earliestBeginDate` je prosba, ne příkaz.
     */
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: refreshId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        // Hned si řekneme o další, ať řada nikdy nevyschne
        schedule()

        let work = Task {
            await run()
            task.setTaskCompleted(success: true)
        }

        // Když systém čas utne, práce se zruší a úloha se korektně uzavře —
        // neuzavřená úloha znamená, že příště nedostaneme nic
        task.expirationHandler = {
            work.cancel()
            task.setTaskCompleted(success: false)
        }
    }

    /**
     Co se stihne za těch pár desítek vteřin.

     Pošta má přednost: kvůli ní se to celé dělá. Chat se ozývá sám ze
     Supabase, takže se tu jen dotáhne stav, ať je po otevření aplikace
     aktuální — a jen když na to zbyde čas.
     */
    private static func run() async {
        await Task.detached(priority: .utility) { MailSync.syncAll() }.value
        guard !Task.isCancelled else { return }
        await Notify.announceNewMail()
    }
}
