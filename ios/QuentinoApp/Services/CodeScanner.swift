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
  4. **Čte se jen z rámečku uprostřed.** V krabici i na regálu bývá štítků
     vedle sebe víc a hledáček by si vybral ten, který uvidí dřív. Rámeček
     říká, kam mířit, a `regionOfInterest` zařídí, že se mimo něj nečte —
     takže „načetlo to sousední kód" nemá jak nastat.
  5. **Při balení je hledáček menší a nahoře.** Odškrtává se proti seznamu
     položek, a ten musí zůstat vidět — celoobrazovkový hledáček by ho zakryl
     a po každém kusu by se musel zavírat. V režimu `panel` proto sedí jen
     v horní části okna nad rozhraním a to si dole udělá místo.
  6. **Počet se nastavuje předem.** V krabici je šest kusů, ale pípne se
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

    /// Kolik bodů shora zabere hledáček v režimu panelu — bez horního okraje.
    private static let panelBody: CGFloat = 208

    /**
     Otevře hledáček. Kódy chodí do rozhraní událostí `scan:code`.

     - Parameter panel: hledáček jen v horní části okna, rozhraní pod ním
       zůstane vidět a ovladatelné (balení objednávek).
     - Parameter qty: počítadlo kusů pod hláškou (naskladnění). Při balení se
       přidává po jednom, počítadlo by tam jen překáželo.
     - Returns: `panel` = kolik bodů shora si má rozhraní nechat volných.
       Nula znamená celoobrazovkový hledáček.
     */
    static func start(panel: Bool = false, qty: Bool = true) throws -> [String: Any] {
        guard available() else {
            throw BridgeError.message("Tenhle telefon čtečku kódů z fotoaparátu nepodporuje — "
                + "kód se dá napsat rukou.")
        }
        guard let host = MediaPicker.topViewController() else {
            throw BridgeError.message("Nedá se otevřít fotoaparát.")
        }
        if let open = controller { return ["panel": open.reservedHeight] }

        let scanner = ScannerController(panel: panel, showsQty: qty)
        controller = scanner

        guard panel else {
            scanner.modalPresentationStyle = .fullScreen
            host.present(scanner, animated: true)
            return ["panel": 0]
        }

        /*
         Panel není samostatná obrazovka, ale patro nad rozhraním: přidá se
         jako potomek hostitele a přilepí se nahoru. Kdyby se prezentoval
         modálně, WKWebView pod ním by přestal brát dotyky a odškrtávat by
         nešlo — a právě o to při balení jde.
         */
        let inset = host.view.safeAreaInsets.top
        let height = inset + panelBody
        // Musí se nastavit dřív, než se sáhne na `view` — tím se spustí
        // `viewDidLoad`, a ten už s odsazením pod stavovým řádkem počítá
        scanner.topInset = inset
        host.addChild(scanner)
        scanner.view.frame = CGRect(x: 0, y: 0, width: host.view.bounds.width, height: height)
        scanner.view.autoresizingMask = [.flexibleWidth]
        host.view.addSubview(scanner.view)
        scanner.didMove(toParent: host)
        return ["panel": Int(height)]
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

    /// Menší hledáček přilepený nahoru, pod ním zůstane rozhraní
    let panel: Bool
    private let showsQty: Bool
    /// Výška stavového řádku — v panelu se pod něj nesmí nic schovat
    var topInset: CGFloat = 0
    var reservedHeight: Int { panel ? Int(view.bounds.height) : 0 }

    init(panel: Bool, showsQty: Bool) {
        self.panel = panel
        self.showsQty = showsQty && !panel
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("nepoužívá se") }

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
        banner.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        banner.layer.cornerRadius = 12
        banner.layer.masksToBounds = true
        banner.text = panel ? " Kód do rámečku " : " Kód do rámečku · níž nastav počet kusů "
        banner.font = .systemFont(ofSize: panel ? 13 : 15, weight: .semibold)
        view.addSubview(banner)

        let close = UIButton(type: .system)
        close.translatesAutoresizingMaskIntoConstraints = false
        close.setTitle("Hotovo", for: .normal)
        close.setTitleColor(.white, for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: panel ? 14 : 17, weight: .semibold)
        close.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        close.layer.cornerRadius = panel ? 15 : 22
        close.addTarget(self, action: #selector(done), for: .touchUpInside)
        view.addSubview(close)

        makeReticle()
        if showsQty { makeQtyBar() }

        /*
         Panel má jen tři patra: hlášku dole, rámeček uprostřed a „Hotovo"
         vpravo nahoře vedle něj. Počítadlo kusů tu není — při balení se
         přidává po jednom kusu, jak se který naskenuje.
         */
        if panel {
            NSLayoutConstraint.activate([
                banner.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 10),
                banner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                banner.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.94),
                banner.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -8),
                banner.heightAnchor.constraint(greaterThanOrEqualToConstant: 34),
                close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
                close.topAnchor.constraint(equalTo: view.topAnchor, constant: topInset + 8),
                close.widthAnchor.constraint(equalToConstant: 84),
                close.heightAnchor.constraint(equalToConstant: 30)
            ])
            return
        }

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

    // MARK: Míření

    private let dimming = UIView()
    private let hole = CAShapeLayer()
    private let reticle = UIView()

    private func makeReticle() {
        dimming.isUserInteractionEnabled = false
        dimming.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        dimming.layer.mask = hole
        view.addSubview(dimming)

        reticle.isUserInteractionEnabled = false
        reticle.layer.borderColor = UIColor.white.cgColor
        reticle.layer.borderWidth = 2
        reticle.layer.cornerRadius = 16
        view.addSubview(reticle)

        // Hláška a tlačítka patří nad ztmavení, ne pod něj
        view.bringSubviewToFront(banner)
    }

    /**
     Rámeček se počítá až podle skutečné velikosti okna.

     `regionOfInterest` je v souřadnicích hledáčku, takže se musí nastavit
     po rozvržení — před ním má okno ještě nulové rozměry a čtečka by hledala
     v prázdnu.
     */
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()

        /*
         V panelu je místa málo: rámeček se odvozuje od jeho výšky, ne od šířky
         okna, a sedí hned pod horním okrajem — pod ním zbývá pruh na hlášku.
         */
        let side = panel
            ? min(view.bounds.height - topInset - 60, view.bounds.width * 0.55)
            : min(view.bounds.width * 0.72, 300)
        let rect = panel
            ? CGRect(x: (view.bounds.width - side) / 2, y: topInset + 12, width: side, height: side)
            : CGRect(
                x: (view.bounds.width - side) / 2,
                y: view.bounds.midY - side / 2 - 40,
                width: side, height: side
            )
        reticle.frame = rect
        dimming.frame = view.bounds

        let path = UIBezierPath(rect: view.bounds)
        path.append(UIBezierPath(roundedRect: rect, cornerRadius: 16).reversing())
        hole.path = path.cgPath
        hole.fillRule = .evenOdd

        scanner?.regionOfInterest = rect

        view.bringSubviewToFront(dimming)
        view.bringSubviewToFront(reticle)
        view.bringSubviewToFront(banner)
        if showsQty { view.bringSubviewToFront(qtyBar) }
        for sub in view.subviews where sub is UIButton { view.bringSubviewToFront(sub) }
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

        /*
         Po jednom i po deseti.

         Krabice mívá šest kusů, ale taky padesát. Po jednom by se k padesáti
         ťukalo dlouho a držení tlačítka se u velkých čísel špatně trefuje do
         přesné hodnoty — dvě tlačítka navíc jsou rychlejší i spolehlivější
         než jedno, které se musí držet a včas pustit.
         */
        qtyBar.addArrangedSubview(stepButton("−10", delta: -10, width: 54, size: 17, repeats: false))
        qtyBar.addArrangedSubview(stepButton("−", delta: -1, width: 52, size: 26, repeats: true))
        qtyBar.addArrangedSubview(qtyLabel)
        qtyBar.addArrangedSubview(stepButton("+", delta: 1, width: 52, size: 26, repeats: true))
        qtyBar.addArrangedSubview(stepButton("+10", delta: 10, width: 54, size: 17, repeats: false))
        view.addSubview(qtyBar)
    }

    private func stepButton(_ title: String, delta: Int, width: CGFloat,
                            size: CGFloat, repeats: Bool) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: size, weight: .medium)
        button.tag = delta
        button.addTarget(self, action: #selector(step(_:)), for: .touchUpInside)
        button.widthAnchor.constraint(equalToConstant: width).isActive = true

        /*
         Držení počítá dál — u dvaceti kusů je dvacet ťuknutí trest. Po deseti
         se ale nedrží: osmkrát za vteřinu po desítce je osmdesát kusů za
         vteřinu a číslo by se přestřelilo dřív, než se stihne pustit.
         */
        if repeats {
            let hold = UILongPressGestureRecognizer(target: self, action: #selector(holdStep(_:)))
            hold.minimumPressDuration = 0.4
            button.addGestureRecognizer(hold)
        }
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
        guard showsQty else { return }
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
        if panel {
            // Panel je patro nad rozhraním, ne obrazovka — odchází se odebráním
            willMove(toParent: nil)
            view.removeFromSuperview()
            removeFromParent()
        } else {
            dismiss(animated: true)
        }
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
