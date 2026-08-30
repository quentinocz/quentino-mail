import UIKit
import AVFoundation
import VisionKit

/**
 Čtečka kódů fotoaparátem.

 U regálu je telefon jediné, co má člověk v ruce, a psát kódy po jednom na
 klávesnici je při dvaceti kusech trest. Systémová `DataScannerViewController`
 umí přečíst QR i čárové kódy z hledáčku a rovnou je zvýrazní v obraze, takže
 se nemusí mířit naslepo.

 Tři rozhodnutí, která stojí za vysvětlení:

  1. **Čte se v jednom kuse, ne po jednom kódu.** Zavírat hledáček po každém
     kusu by znamenalo dvacet otevření na jednu krabici. Kód se proto pošle
     do rozhraní hned, jak se přečte, a hledáček zůstane.
  2. **Stejný kód se nepřičte dvakrát za sebou.** Kamera vidí štítek
     třicetkrát za vteřinu; bez pojistky by z jednoho pípnutí bylo třicet
     kusů. Tentýž kód se proto přijme znovu až po dvou vteřinách — a jiný
     kód hned.
  3. **Zpětná vazba je v hledáčku, ne v aplikaci pod ním.** Rozhraní pošle
     zpátky jednu větu („Kšandy Slim · 120cm — celkem 6 ks") a ta se ukáže
     rovnou nad tlačítkem. Kdo drží telefon nad krabicí, se nedívá jinam.
 */
@MainActor
enum CodeScanner {
    /// Umí to tohle zařízení? Starší modely `DataScanner` nepodporují.
    static func available() -> Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    private static var controller: ScannerController?

    /// Otevře hledáček. Kódy chodí do rozhraní událostí `scan:code`.
    static func start() throws -> Bool {
        guard available() else {
            throw BridgeError.message("Tenhle telefon čtečku kódů z fotoaparátu nepodporuje — "
                + "kód se dá napsat rukou.")
        }
        if controller != nil { return true }
        guard let host = MediaPicker.topViewController() else {
            throw BridgeError.message("Nedá se otevřít fotoaparát.")
        }

        let scanner = ScannerController()
        controller = scanner
        scanner.modalPresentationStyle = .fullScreen
        host.present(scanner, animated: true)
        return true
    }

    static func stop() {
        controller?.finish()
        controller = nil
    }

    /// Krátká věta pod hledáček — co se právě přičetlo.
    static func feedback(_ text: String, ok: Bool) {
        controller?.show(text, ok: ok)
    }

    static func forget() { controller = nil }
}

@MainActor
private final class ScannerController: UIViewController {
    private var scanner: DataScannerViewController?
    private let banner = UILabel()
    private var lastCode = ""
    private var lastAt = Date.distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        /*
         Typy kódů: QR kvůli štítkům, které si tiskneme sami, a čárové kódy
         kvůli zboží, které je má od výrobce. Kdyby se hledaly všechny, čtečka
         by se chytala i na text v obalu.
         */
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr, .ean13, .ean8, .code128, .code39, .upce])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = self
        addChild(scanner)
        scanner.view.frame = view.bounds
        scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scanner.view)
        scanner.didMove(toParent: self)
        self.scanner = scanner
        try? scanner.startScanning()

        banner.translatesAutoresizingMaskIntoConstraints = false
        banner.numberOfLines = 2
        banner.textAlignment = .center
        banner.textColor = .white
        banner.font = .systemFont(ofSize: 15, weight: .semibold)
        banner.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        banner.layer.cornerRadius = 12
        banner.layer.masksToBounds = true
        banner.text = " Namiř na kód na štítku "
        view.addSubview(banner)

        let close = UIButton(type: .system)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setTitle("Hotovo", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        close.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        close.layer.cornerRadius = 22
        close.addTarget(self, action: #selector(done), for: .touchUpInside)
        view.addSubview(close)

        NSLayoutConstraint.activate([
            banner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            banner.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.9),
            banner.bottomAnchor.constraint(equalTo: close.topAnchor, constant: -16),
            banner.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.widthAnchor.constraint(equalToConstant: 140),
            close.heightAnchor.constraint(equalToConstant: 44),
            close.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
        ])
    }

    func show(_ text: String, ok: Bool) {
        banner.text = " \(text) "
        banner.backgroundColor = (ok ? UIColor.systemGreen : UIColor.systemRed).withAlphaComponent(0.85)
        UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
    }

    @objc private func done() { finish() }

    func finish() {
        scanner?.stopScanning()
        CodeScanner.forget()
        dismiss(animated: true)
        Bridge.notify("scan:closed")
    }
}

extension ScannerController: DataScannerViewControllerDelegate {
    // Protokol je v SDK svázaný s hlavním vláknem, takže tu nesmí být
    // `nonisolated` — jinak by metoda protokol nesplnila
    func dataScanner(_ scanner: DataScannerViewController,
                     didAdd added: [RecognizedItem],
                     allItems: [RecognizedItem]) {
        for item in added {
            guard case .barcode(let code) = item, let text = code.payloadStringValue else { continue }
            accept(text)
        }
    }

    /// Kamera hlásí tentýž kód pořád dokola — bez odstupu by z jednoho
    /// štítku byla desítka kusů.
    private func accept(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if clean == lastCode, Date().timeIntervalSince(lastAt) < 2 { return }
        lastCode = clean
        lastAt = Date()
        Bridge.notify("scan:code", ["text": clean])
    }
}
