import Foundation
import UIKit

/**
 Pravidelné úlohy, dokud je aplikace v popředí.

 Na počítači to má na starosti `scheduler.ts` a běží pořád. iOS aplikaci na
 pozadí uspí, takže se stejné úlohy pouštějí jen tehdy, když se na aplikaci
 opravdu někdo dívá — a hned po probuzení, aby první pohled ukázal aktuální
 stav, ne ten hodinu starý.

 Intervaly odpovídají desktopu: fronta publikací každých 30 s, synchronizace
 každou minutu, obnova přístupů k Metě po dvanácti hodinách.
 */
@MainActor
final class Scheduler {
    static let shared = Scheduler()

    private var ticker: Task<Void, Never>?
    private var lastSync = Date.distantPast
    private var lastMail = Date.distantPast
    private var lastFeed = Date.distantPast
    private var lastTokens = Date.distantPast
    private var observers: [NSObjectProtocol] = []

    private init() { }

    func start() {
        guard ticker == nil else { return }
        observe()
        ticker = Task { [weak self] in
            // Krátká prodleva po startu, ať se nejdřív ukáže rozhraní
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
    }

    func stop() {
        ticker?.cancel()
        ticker = nil
    }

    /// Po návratu do popředí se úlohy pustí hned — spojení i data jsou stará.
    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.lastSync = .distantPast
                self?.lastMail = .distantPast
                await self?.tick()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in
            // Nic se neplánuje: iOS aplikaci stejně za chvíli zmrazí
        })
    }

    private func tick() async {
        await IgQueue.shared.process()

        // Naplánované zprávy a nová pošta — na telefonu jen v popředí,
        // na pozadí by aplikaci systém stejně zmrazil.
        await Task.detached(priority: .utility) { MailSync.processOutbox() }.value
        if Date().timeIntervalSince(lastMail) > 120 {
            lastMail = Date()
            await Task.detached(priority: .utility) { MailSync.syncAll() }.value
            for account in MailStore.accounts() {
                await MailAI.autoProcess(accountId: account["id"] as? Int ?? 0, folder: "INBOX")
            }
        }

        if Date().timeIntervalSince(lastSync) > 60 {
            lastSync = Date()
            if Store.bool("syncEnabled", false) {
                _ = await Task.detached(priority: .utility) { AppSync.run() }.value
            }
        }

        if Date().timeIntervalSince(lastFeed) > 3600 {
            lastFeed = Date()
            if Products.isStale() {
                _ = try? await Products.refresh()
                Bridge.notify("products:changed")
            }
        }

        if Date().timeIntervalSince(lastTokens) > 12 * 3600 {
            lastTokens = Date()
            _ = await IgPublisher.refreshTokens(force: false)
        }
    }
}
