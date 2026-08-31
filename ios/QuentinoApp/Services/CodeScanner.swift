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
  4. **Počet se nastavuje předem.** V krabici je šest kusů, ale pípne se
     jednou — proto je pod větou „− 6 +" a říká, **kolik kusů přidá další
     načtení**. Nastavit to jednou je rychlejší než po každém pípnutí
     opravovat řádek v seznamu. Držení tlačítka počítá dál, ať se u dvaceti
     kusů neťuká dvacetkrát; klávesnice tu schválně není, zakryla by hledáček.
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

    /// Kolik kusů přidá další načtení — číslo v počítadle.
    static func count(_ value: Int) {
        controller?.setCount(value)
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
        banner.text = " Namiř na kód na štítku · níž nastav počet kusů "
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

        makeQtyBar()

        NSLayoutConstraint.activate([
            banner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            banner.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.9),
            banner.bottomAnchor.constraint(equalTo: qtyBar.topAnchor, constant: -12),
            banner.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            qtyBar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            qtyBar.heightAnchor.constraint(equalToConstant: 52),
            qtyBar.bottomAnchor.constraint(equalTo: close.topAnchor, constant: -14),
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.widthAnchor.constraint(equalToConstant: 140),
            close.heightAnchor.constraint(equalToConstant: 44),
            close.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
        ])
    }

    // MARK: Počet bez zavírání hledáčku

    private let qtyBar = UIStackView()
    private let qtyLabel = UILabel()
    private var repeatTimer: Timer?

    private func makeQtyBar() {
        qtyBar.translatesAutoresizingMaskIntoConstraints = false
        qtyBar.axis = .horizontal
        qtyBar.alignment = .fill
        qtyBar.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        qtyBar.layer.cornerRadius = 26
        qtyBar.layer.masksToBounds = true

        qtyLabel.textColor = .white
        qtyLabel.textAlignment = .center
        qtyLabel.font = .monospacedDigitSystemFont(ofSize: 19, weight: .bold)
        qtyLabel.text = "1"
        qtyLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true

        qtyBar.addArrangedSubview(stepButton("−", delta: -1))
        qtyBar.addArrangedSubview(qtyLabel)
        qtyBar.addArrangedSubview(stepButton("+", delta: 1))
        view.addSubview(qtyBar)
    }

    private func stepButton(_ title: String, delta: Int) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 26, weight: .medium)
        button.tag = delta
        button.addTarget(self, action: #selector(step(_:)), for: .touchUpInside)
        button.widthAnchor.constraint(equalToConstant: 58).isActive = true

        // Držení počítá dál — u dvaceti kusů je dvacet ťuknutí trest
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(holdStep(_:)))
        hold.minimumPressDuration = 0.4
        button.addGestureRecognizer(hold)
        return button
    }

    @objc private func step(_ sender: UIButton) {
        Bridge.notify("scan:qty", ["delta": sender.tag])
    }

    @objc private func holdStep(_ sender: UILongPressGestureRecognizer) {
        let delta = sender.view?.tag ?? 0
        switch sender.state {
        case .began:
            repeatTimer?.invalidate()
            repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { _ in
                Task { @MainActor in Bridge.notify("scan:qty", ["delta": delta]) }
            }
        case .ended, .cancelled, .failed:
            repeatTimer?.invalidate()
            repeatTimer = nil
        default:
            break
        }
    }

    func show(_ text: String, ok: Bool) {
        banner.text = " \(text) "
        banner.backgroundColor = (ok ? UIColor.systemGreen : UIColor.systemRed).withAlphaComponent(0.85)
        if !ok { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    }

    /*
     Počítadlo se mění mimo načítání kódů, takže se ho netýká ani hláška,
     ani haptika — při držení tlačítka chodí zprávy osmkrát za vteřinu
     a telefon by nepřetržitě drnčel.
     */
    func setCount(_ value: Int) {
        qtyLabel.text = String(max(1, value))
    }

    /// Kód se načetl — potvrdit hmatem, ať se člověk nemusí dívat.
    func confirmScan() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    @objc private func done() { finish() }

    func finish() {
        repeatTimer?.invalidate()
        repeatTimer = nil
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
        confirmScan()
        Bridge.notify("scan:code", ["text": clean])
    }
}
