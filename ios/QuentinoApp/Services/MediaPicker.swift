import UIKit
import PhotosUI
import UniformTypeIdentifiers

/**
 Výběr souborů na iOS.

 Na počítači otevře Electron systémový dialog a vrátí cesty. Tady se to musí
 udělat oklikou: uživatel vybere fotku ve `PHPicker`, systém ji předá jako
 kopii a ta se uloží do složky aplikace. Rozhraní pak dostane cestu úplně
 stejně jako na Macu a nemusí o rozdílu vědět.

 HEIC z fotoaparátu se převádí na JPEG — Instagram spolehlivě bere jen JPEG
 a PNG, takže je lepší to vyřešit hned při výběru než chybou při publikaci.
 */
@MainActor
enum MediaPicker {
    /// Nejvýš položené okno, do kterého jde vsunout systémový výběr.
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first

        var controller = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            ?? scene?.windows.first?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    /// Fotky a videa z knihovny. Vrací cesty ke kopiím ve složce aplikace.
    static func pickMedia(limit: Int = 10) async -> [String] {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = limit
        configuration.filter = .any(of: [.images, .videos])
        // `compatible` nechá systém převést HEIC a HEVC do JPEG a H.264 — přesně to, co Meta bere
        configuration.preferredAssetRepresentationMode = .compatible

        let results = await present(configuration)
        var paths: [String] = []
        for result in results {
            if let path = await store(result.itemProvider) { paths.append(path) }
        }
        return paths
    }

    /// Jeden obrázek — používá se u podpisu a loga poukazu.
    static func pickImage() async -> String? {
        await pickMedia(limit: 1).first
    }

    /// Libovolné soubory (přílohy e-mailu) z aplikace Soubory i z iCloudu.
    static func pickDocuments(multiple: Bool = true) async -> [String] {
        await withCheckedContinuation { continuation in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = multiple
            let delegate = DocumentDelegate { urls in
                var paths: [String] = []
                for url in urls {
                    let target = uniqueFile(named: url.lastPathComponent)
                    try? FileManager.default.copyItem(at: url, to: target)
                    if FileManager.default.fileExists(atPath: target.path) { paths.append(target.path) }
                }
                continuation.resume(returning: paths)
            }
            picker.delegate = delegate
            retained = delegate
            guard let host = topViewController() else {
                retained = nil
                return continuation.resume(returning: [])
            }
            host.present(picker, animated: true)
        }
    }

    /// Výběr složky pro synchronizaci (typicky iCloud Drive).
    static func pickFolder() async -> URL? {
        await withCheckedContinuation { continuation in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            let delegate = DocumentDelegate { urls in continuation.resume(returning: urls.first) }
            picker.delegate = delegate
            retained = delegate
            guard let host = topViewController() else {
                retained = nil
                return continuation.resume(returning: nil)
            }
            host.present(picker, animated: true)
        }
    }

    /// Nabídne uložení hotového souboru do Souborů nebo iCloudu.
    static func exportFile(_ url: URL) async -> String? {
        await withCheckedContinuation { continuation in
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            let delegate = DocumentDelegate { urls in continuation.resume(returning: urls.first?.path ?? url.path) }
            picker.delegate = delegate
            retained = delegate
            guard let host = topViewController() else {
                retained = nil
                return continuation.resume(returning: nil)
            }
            host.present(picker, animated: true)
        }
    }

    /// Jeden soubor daného typu (obnovení zálohy).
    static func pickFile(types: [UTType]) async -> URL? {
        await withCheckedContinuation { continuation in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = false
            let delegate = DocumentDelegate { urls in continuation.resume(returning: urls.first) }
            picker.delegate = delegate
            retained = delegate
            guard let host = topViewController() else {
                retained = nil
                return continuation.resume(returning: nil)
            }
            host.present(picker, animated: true)
        }
    }

    // MARK: - Pomocné

    private static var retained: AnyObject?

    private static func present(_ configuration: PHPickerConfiguration) async -> [PHPickerResult] {
        await withCheckedContinuation { continuation in
            let picker = PHPickerViewController(configuration: configuration)
            let delegate = PhotoDelegate { results in continuation.resume(returning: results) }
            picker.delegate = delegate
            retained = delegate
            guard let host = topViewController() else {
                retained = nil
                return continuation.resume(returning: [])
            }
            host.present(picker, animated: true)
        }
    }

    nonisolated private static func uniqueFile(named name: String) -> URL {
        let safe = name.isEmpty ? "soubor" : name
        var target = IgMedia.mediaDirectory.appendingPathComponent(safe)
        var counter = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let base = (safe as NSString).deletingPathExtension
            let ext = (safe as NSString).pathExtension
            let next = ext.isEmpty ? "\(base)-\(counter)" : "\(base)-\(counter).\(ext)"
            target = IgMedia.mediaDirectory.appendingPathComponent(next)
            counter += 1
        }
        return target
    }

    /// Uloží vybranou položku do složky aplikace a vrátí cestu.
    private static func store(_ provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            return await copyFile(provider, type: UTType.movie.identifier, fallbackExtension: "mp4")
        }
        guard let data = await loadData(provider, type: UTType.image.identifier) else {
            return await copyFile(provider, type: UTType.item.identifier, fallbackExtension: "bin")
        }
        // Fotoaparát ukládá HEIC; pro Instagram se hodí spíš JPEG
        let isJpeg = data.count > 3 && data[0] == 0xFF && data[1] == 0xD8
        let isPng = data.count > 8 && data[0] == 0x89 && data[1] == 0x50
        if isJpeg || isPng {
            let target = uniqueFile(named: "foto-\(stamp()).\(isPng ? "png" : "jpg")")
            try? data.write(to: target)
            return target.path
        }
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.92) else { return nil }
        let target = uniqueFile(named: "foto-\(stamp()).jpg")
        try? jpeg.write(to: target)
        return target.path
    }

    nonisolated private static func stamp() -> String {
        String(Int(Date().timeIntervalSince1970 * 1000))
    }

    private static func loadData(_ provider: NSItemProvider, type: String) async -> Data? {
        guard provider.hasItemConformingToTypeIdentifier(type) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    private static func copyFile(_ provider: NSItemProvider, type: String, fallbackExtension: String) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(type) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                // Systémová kopie zmizí, jakmile se vrátíme — musí se přenést hned
                let name = url.lastPathComponent.isEmpty
                    ? "media-\(Int(Date().timeIntervalSince1970)).\(fallbackExtension)"
                    : url.lastPathComponent
                let target = uniqueFile(named: name)
                try? FileManager.default.copyItem(at: url, to: target)
                continuation.resume(returning: FileManager.default.fileExists(atPath: target.path) ? target.path : nil)
            }
        }
    }
}

private final class PhotoDelegate: NSObject, PHPickerViewControllerDelegate {
    private let finished: ([PHPickerResult]) -> Void
    private var done = false

    init(_ finished: @escaping ([PHPickerResult]) -> Void) {
        self.finished = finished
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !done else { return }
        done = true
        finished(results)
    }
}

private final class DocumentDelegate: NSObject, UIDocumentPickerDelegate {
    private let finished: ([URL]) -> Void
    private var done = false

    init(_ finished: @escaping ([URL]) -> Void) {
        self.finished = finished
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard !done else { return }
        done = true
        finished(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard !done else { return }
        done = true
        finished([])
    }
}
