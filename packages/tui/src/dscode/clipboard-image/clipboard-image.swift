import AppKit
import Darwin
import Foundation

func fail(_ message: String, _ status: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(status)
}

func pngData(from pasteboard: NSPasteboard) -> Data? {
    if let direct = pasteboard.data(forType: .png) { return direct }
    if let image = NSImage(pasteboard: pasteboard),
       let tiff = image.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: tiff) {
        return bitmap.representation(using: .png, properties: [:])
    }
    return nil
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--self-test" {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                       isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
                                       bitsPerPixel: 0) else {
        fail("could not create test image", 3)
    }
    bitmap.setColor(.red, atX: 0, y: 0)
    guard let source = bitmap.representation(using: .png, properties: [:]) else {
        fail("could not encode test image", 3)
    }
    let board = NSPasteboard(name: NSPasteboard.Name("dscode-image-self-test-\(UUID().uuidString)"))
    board.clearContents()
    guard board.setData(source, forType: .png), pngData(from: board) == source else {
        fail("pasteboard image round trip failed", 3)
    }
    guard let tiff = bitmap.representation(using: .tiff, properties: [:]) else {
        fail("could not create test TIFF", 3)
    }
    board.clearContents()
    guard board.setData(tiff, forType: .tiff),
          let converted = pngData(from: board),
          converted.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else {
        fail("pasteboard TIFF conversion failed", 3)
    }
    exit(0)
}

guard CommandLine.arguments.count == 2 else { fail("missing output path", 3) }
guard let data = pngData(from: NSPasteboard.general) else { fail("clipboard has no image", 2) }
guard data.count <= 32 * 1024 * 1024 else { fail("clipboard image is too large", 4) }

do {
    try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
} catch {
    fail("could not save clipboard image", 3)
}
