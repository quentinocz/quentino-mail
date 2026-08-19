import Foundation
import CommonCrypto

/**
 Odvození klíče algoritmem scrypt.

 Zálohy zamčené heslem vznikají na počítači v Node.js (`crypto.scryptSync`)
 a iOS na tenhle algoritmus nic systémového nemá. Bez něj by se záloha
 z Macu na telefonu neotevřela, takže je tu vlastní implementace podle
 RFC 7914 s výchozími hodnotami Node.js: N = 16384, r = 8, p = 1.

 Běží jednotky sekund a zabere ~16 MB — proto se volá jen při odemykání
 zálohy a nikdy na hlavním vlákně.
 */
enum Scrypt {
    static func derive(
        password: String,
        salt: [UInt8],
        n: Int = 16_384,
        r: Int = 8,
        p: Int = 1,
        length: Int = 32
    ) -> [UInt8] {
        let passwordBytes = Array(password.utf8)
        let blockWords = 32 * r

        // 1) Vstupní materiál z PBKDF2
        var blocks = toWords(pbkdf2(passwordBytes, salt, rounds: 1, length: p * 128 * r))

        // 2) Každý blok projde pamětově náročnou částí
        var scratch = [UInt32](repeating: 0, count: blockWords * n)
        for index in 0..<p {
            let start = index * blockWords
            var block = Array(blocks[start..<(start + blockWords)])
            romix(&block, n: n, r: r, scratch: &scratch)
            blocks.replaceSubrange(start..<(start + blockWords), with: block)
        }

        // 3) Výsledek zase přes PBKDF2
        return pbkdf2(passwordBytes, toBytes(blocks), rounds: 1, length: length)
    }

    // MARK: - PBKDF2

    private static func pbkdf2(_ password: [UInt8], _ salt: [UInt8], rounds: UInt32, length: Int) -> [UInt8] {
        var derived = [UInt8](repeating: 0, count: length)
        password.withUnsafeBufferPointer { passwordBuffer in
            salt.withUnsafeBufferPointer { saltBuffer in
                _ = passwordBuffer.baseAddress!.withMemoryRebound(to: Int8.self, capacity: password.count) { chars in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        chars, password.count,
                        saltBuffer.baseAddress, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        rounds,
                        &derived, length
                    )
                }
            }
        }
        return derived
    }

    // MARK: - Jádro

    private static func romix(_ block: inout [UInt32], n: Int, r: Int, scratch: inout [UInt32]) {
        let words = 32 * r
        for index in 0..<n {
            scratch.replaceSubrange((index * words)..<((index + 1) * words), with: block)
            blockMix(&block, r: r)
        }
        for _ in 0..<n {
            // Integerify: první slovo posledního 64bajtového bloku
            let target = Int(block[(2 * r - 1) * 16]) % n
            let offset = target * words
            for position in 0..<words { block[position] ^= scratch[offset + position] }
            blockMix(&block, r: r)
        }
    }

    private static func blockMix(_ block: inout [UInt32], r: Int) {
        var x = Array(block[((2 * r - 1) * 16)..<(2 * r * 16)])
        var mixed = [UInt32](repeating: 0, count: 32 * r)

        for index in 0..<(2 * r) {
            for position in 0..<16 { x[position] ^= block[index * 16 + position] }
            salsa20_8(&x)
            // Sudé bloky do první poloviny, liché do druhé
            let destination = (index % 2 == 0 ? index / 2 : r + index / 2) * 16
            mixed.replaceSubrange(destination..<(destination + 16), with: x)
        }
        block = mixed
    }

    private static func rotate(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }

    private static func salsa20_8(_ block: inout [UInt32]) {
        var x = block
        for _ in 0..<4 {
            x[4] ^= rotate(x[0] &+ x[12], 7);   x[8] ^= rotate(x[4] &+ x[0], 9)
            x[12] ^= rotate(x[8] &+ x[4], 13);  x[0] ^= rotate(x[12] &+ x[8], 18)
            x[9] ^= rotate(x[5] &+ x[1], 7);    x[13] ^= rotate(x[9] &+ x[5], 9)
            x[1] ^= rotate(x[13] &+ x[9], 13);  x[5] ^= rotate(x[1] &+ x[13], 18)
            x[14] ^= rotate(x[10] &+ x[6], 7);  x[2] ^= rotate(x[14] &+ x[10], 9)
            x[6] ^= rotate(x[2] &+ x[14], 13);  x[10] ^= rotate(x[6] &+ x[2], 18)
            x[3] ^= rotate(x[15] &+ x[11], 7);  x[7] ^= rotate(x[3] &+ x[15], 9)
            x[11] ^= rotate(x[7] &+ x[3], 13);  x[15] ^= rotate(x[11] &+ x[7], 18)

            x[1] ^= rotate(x[0] &+ x[3], 7);    x[2] ^= rotate(x[1] &+ x[0], 9)
            x[3] ^= rotate(x[2] &+ x[1], 13);   x[0] ^= rotate(x[3] &+ x[2], 18)
            x[6] ^= rotate(x[5] &+ x[4], 7);    x[7] ^= rotate(x[6] &+ x[5], 9)
            x[4] ^= rotate(x[7] &+ x[6], 13);   x[5] ^= rotate(x[4] &+ x[7], 18)
            x[11] ^= rotate(x[10] &+ x[9], 7);  x[8] ^= rotate(x[11] &+ x[10], 9)
            x[9] ^= rotate(x[8] &+ x[11], 13);  x[10] ^= rotate(x[9] &+ x[8], 18)
            x[12] ^= rotate(x[15] &+ x[14], 7); x[13] ^= rotate(x[12] &+ x[15], 9)
            x[14] ^= rotate(x[13] &+ x[12], 13); x[15] ^= rotate(x[14] &+ x[13], 18)
        }
        for index in 0..<16 { block[index] = block[index] &+ x[index] }
    }

    // MARK: - Převody (všude little-endian, jako v referenční implementaci)

    private static func toWords(_ bytes: [UInt8]) -> [UInt32] {
        var words = [UInt32](repeating: 0, count: bytes.count / 4)
        for index in 0..<words.count {
            let offset = index * 4
            words[index] = UInt32(bytes[offset])
                | UInt32(bytes[offset + 1]) << 8
                | UInt32(bytes[offset + 2]) << 16
                | UInt32(bytes[offset + 3]) << 24
        }
        return words
    }

    private static func toBytes(_ words: [UInt32]) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: words.count * 4)
        for (index, word) in words.enumerated() {
            let offset = index * 4
            bytes[offset] = UInt8(word & 0xFF)
            bytes[offset + 1] = UInt8((word >> 8) & 0xFF)
            bytes[offset + 2] = UInt8((word >> 16) & 0xFF)
            bytes[offset + 3] = UInt8((word >> 24) & 0xFF)
        }
        return bytes
    }
}
