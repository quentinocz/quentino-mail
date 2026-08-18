import Foundation

/**
 Instagram a Facebook.

 Zatím drží jen návrat z přihlášení, aby most měl co volat; publikování
 a generování textů se překlopí ze stolní verze (`src/main/instagram/*`),
 kde je celá logika už hotová a ověřená.
 */
final class Instagram {
    static let shared = Instagram()

    private init() { }

    /// Zpracuje odkaz `quentino-mail://ig-oauth?code=…` z prohlížeče.
    func handleCallback(url: URL) async throws -> [String: Any] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "code" })?.value != nil else {
            throw BridgeError.message("Přihlášení nevrátilo kód.")
        }
        throw BridgeError.message("Připojení účtu na mobilu ještě není hotové — připoj účet na počítači, nastavení se synchronizuje.")
    }
}
