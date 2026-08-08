#!/usr/bin/env swift
//
// generate-icons.swift
//
// Self-contained icon generator for the Archive.ph Safari plugin.
// Draws an "archive box" glyph in code (no external assets) and emits
// every PNG the project needs, plus a human-viewable contact sheet.
//
// Usage:
//   swift scripts/generate-icons.swift
//
// Output directory: scripts/icon-out/ (git-ignored)
//

import AppKit
import CoreGraphics
import Foundation

// MARK: - Colors

let colorBackground = NSColor(calibratedRed: 0xFA / 255.0, green: 0xFA / 255.0, blue: 0xFA / 255.0, alpha: 1.0)
let colorPrimaryRed = NSColor(calibratedRed: 0xCC / 255.0, green: 0x2B / 255.0, blue: 0x2B / 255.0, alpha: 1.0)
let colorAccentRed = NSColor(calibratedRed: 0xA0 / 255.0, green: 0x20 / 255.0, blue: 0x20 / 255.0, alpha: 1.0)
let colorTemplateBlack = NSColor.black

// MARK: - Drawing helpers

/// Draws the archive-box glyph (lid + body + slot) into the current graphics
/// context, centered within `rect`, occupying `glyphFraction` of the rect's
/// width. All dimensions are derived from `rect` so the drawing is
/// resolution-independent and always renders crisply at the target size.
///
/// - Parameters:
///   - rect: The bounding box to center the glyph within.
///   - glyphFraction: Fraction of rect width the glyph should occupy.
///   - boxColor: Fill color for lid + body.
///   - slotColor: Fill color for the handle/slot line. If nil, no slot is drawn
///     (used for the solid template glyph where everything is one color).
func drawArchiveGlyph(in rect: CGRect, glyphFraction: CGFloat, boxColor: NSColor, slotColor: NSColor?) {
    let glyphWidth = rect.width * glyphFraction
    let glyphHeight = glyphWidth * 0.82 // slightly shorter than wide, box-like proportions
    let originX = rect.midX - glyphWidth / 2
    let originY = rect.midY - glyphHeight / 2

    // Proportions (relative to glyphHeight / glyphWidth)
    let lidHeight = glyphHeight * 0.30
    let gap = glyphHeight * 0.08
    let bodyHeight = glyphHeight - lidHeight - gap
    let bodyInset = glyphWidth * 0.06 // body is slightly narrower than the lid
    let cornerRadius = glyphWidth * 0.10

    // Lid: wider flat box on top
    let lidRect = CGRect(x: originX, y: originY + bodyHeight + gap, width: glyphWidth, height: lidHeight)
    let lidPath = NSBezierPath(roundedRect: lidRect, xRadius: cornerRadius, yRadius: cornerRadius)
    boxColor.setFill()
    lidPath.fill()

    // Body: box below, slightly narrower than the lid
    let bodyRect = CGRect(x: originX + bodyInset, y: originY, width: glyphWidth - 2 * bodyInset, height: bodyHeight)
    let bodyPath = NSBezierPath(roundedRect: bodyRect, xRadius: cornerRadius * 0.8, yRadius: cornerRadius * 0.8)
    boxColor.setFill()
    bodyPath.fill()

    // Slot / handle: small horizontal line centered in the body, in a lighter/accent shade.
    if let slotColor {
        let slotWidth = bodyRect.width * 0.42
        let slotHeight = max(bodyRect.height * 0.10, 1.0)
        let slotRect = CGRect(
            x: bodyRect.midX - slotWidth / 2,
            y: bodyRect.midY - slotHeight / 2,
            width: slotWidth,
            height: slotHeight
        )
        let slotPath = NSBezierPath(roundedRect: slotRect, xRadius: slotHeight / 2, yRadius: slotHeight / 2)
        slotColor.setFill()
        slotPath.fill()
    }
}

/// Renders the full-color rounded-rect tile icon (background + box glyph) at
/// the given pixel size and returns the resulting bitmap representation.
func renderColorTile(size: Int) -> NSBitmapImageRep {
    let sizeF = CGFloat(size)
    let rep = makeBitmapRep(size: size)

    withGraphicsContext(rep) {
        let fullRect = CGRect(x: 0, y: 0, width: sizeF, height: sizeF)
        let cornerRadius = sizeF * 0.22
        let bgPath = NSBezierPath(roundedRect: fullRect, xRadius: cornerRadius, yRadius: cornerRadius)
        colorBackground.setFill()
        bgPath.fill()

        drawArchiveGlyph(in: fullRect, glyphFraction: 0.60, boxColor: colorPrimaryRed, slotColor: colorAccentRed)
    }

    return rep
}

/// Renders the black-with-alpha template glyph (no background) at the given
/// pixel size, tight to the canvas with ~12% padding on each side.
func renderTemplateGlyph(size: Int) -> NSBitmapImageRep {
    let sizeF = CGFloat(size)
    let rep = makeBitmapRep(size: size)

    withGraphicsContext(rep) {
        let fullRect = CGRect(x: 0, y: 0, width: sizeF, height: sizeF)
        // ~12% padding on each side -> glyph occupies ~76% of canvas width.
        drawArchiveGlyph(in: fullRect, glyphFraction: 0.76, boxColor: colorTemplateBlack, slotColor: nil)
    }

    return rep
}

// MARK: - Bitmap / context utilities

func makeBitmapRep(size: Int) -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fatalError("Failed to create NSBitmapImageRep for size \(size)")
    }
    rep.size = NSSize(width: size, height: size)
    return rep
}

func withGraphicsContext(_ rep: NSBitmapImageRep, _ drawing: () -> Void) {
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
        fatalError("Failed to create NSGraphicsContext")
    }
    let previous = NSGraphicsContext.current
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh))
    drawing()
    context.flushGraphics()
    NSGraphicsContext.current = previous
}

func writePNG(_ rep: NSBitmapImageRep, to url: URL) {
    guard let data = rep.representation(using: .png, properties: [:]) else {
        fatalError("Failed to encode PNG for \(url.path)")
    }
    do {
        try data.write(to: url, options: .atomic)
    } catch {
        fatalError("Failed to write \(url.path): \(error)")
    }
}

// MARK: - Paths / output setup

let scriptDir: URL = {
    let path = CommandLine.arguments[0]
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    return url.deletingLastPathComponent()
}()

let outDir = scriptDir.appendingPathComponent("icon-out")

func setUpOutputDirectory() {
    let fm = FileManager.default
    if fm.fileExists(atPath: outDir.path) {
        // Idempotent: clear out any previous PNGs so stale files can't linger.
        if let contents = try? fm.contentsOfDirectory(at: outDir, includingPropertiesForKeys: nil) {
            for file in contents where file.pathExtension.lowercased() == "png" {
                try? fm.removeItem(at: file)
            }
        }
    } else {
        try? fm.createDirectory(at: outDir, withIntermediateDirectories: true)
    }
}

// MARK: - Manifest of required outputs

struct IconSpec {
    let filename: String
    let size: Int
    let kind: Kind

    enum Kind {
        case color
        case template
    }
}

let manifest: [IconSpec] = [
    // Safari toolbar template glyphs
    IconSpec(filename: "toolbar-16.png", size: 16, kind: .template),
    IconSpec(filename: "toolbar-32.png", size: 32, kind: .template),

    // General-purpose color icons
    IconSpec(filename: "icon-48.png", size: 48, kind: .color),
    IconSpec(filename: "icon-96.png", size: 96, kind: .color),
    IconSpec(filename: "icon-128.png", size: 128, kind: .color),

    // Mac AppIcon.appiconset (filenames/sizes authoritative from Contents.json)
    IconSpec(filename: "mac-icon-16@1x.png", size: 16, kind: .color),
    IconSpec(filename: "mac-icon-16@2x.png", size: 32, kind: .color),
    IconSpec(filename: "mac-icon-32@1x.png", size: 32, kind: .color),
    IconSpec(filename: "mac-icon-32@2x.png", size: 64, kind: .color),
    IconSpec(filename: "mac-icon-128@1x.png", size: 128, kind: .color),
    IconSpec(filename: "mac-icon-128@2x.png", size: 256, kind: .color),
    IconSpec(filename: "mac-icon-256@1x.png", size: 256, kind: .color),
    IconSpec(filename: "mac-icon-256@2x.png", size: 512, kind: .color),
    IconSpec(filename: "mac-icon-512@1x.png", size: 512, kind: .color),
    IconSpec(filename: "mac-icon-512@2x.png", size: 1024, kind: .color),
]

// MARK: - Generation

print("Generating icons into \(outDir.path) ...")
setUpOutputDirectory()

for spec in manifest {
    let rep: NSBitmapImageRep
    switch spec.kind {
    case .color:
        rep = renderColorTile(size: spec.size)
    case .template:
        rep = renderTemplateGlyph(size: spec.size)
    }
    let url = outDir.appendingPathComponent(spec.filename)
    writePNG(rep, to: url)
    print("  wrote \(spec.filename) (\(spec.size)x\(spec.size))")
}

// MARK: - Contact sheet

/// Builds a single PNG showing the color tile at 128/48/16 and the template
/// glyph at 32/16, each rendered twice: once on a light strip (#F0F0F0) and
/// once on a dark strip (#2A2A2A), so a human can judge legibility on both.
func renderContactSheet() -> NSBitmapImageRep {
    let lightBG = NSColor(calibratedWhite: 0xF0 / 255.0, alpha: 1.0)
    let darkBG = NSColor(calibratedRed: 0x2A / 255.0, green: 0x2A / 255.0, blue: 0x2A / 255.0, alpha: 1.0)

    let colorSizes = [128, 48, 16]
    let templateSizes = [32, 16]

    let padding: CGFloat = 24
    let cellSpacing: CGFloat = 24
    let rowSpacing: CGFloat = 24
    let maxCellSize: CGFloat = 128

    // Row width = padding + sum(cell widths + spacing between them) + padding
    let cellCountPerRow = colorSizes.count + templateSizes.count
    let rowWidth = padding * 2 + maxCellSize * CGFloat(cellCountPerRow) + cellSpacing * CGFloat(cellCountPerRow - 1)
    let rowHeight = padding * 2 + maxCellSize
    let sheetWidth = Int(rowWidth)
    let sheetHeight = Int(rowHeight * 2 + rowSpacing)

    // makeBitmapRep assumes a square canvas; the contact sheet is not square,
    // so build a dedicated bitmap rep here instead of reusing that helper.
    guard let sheetRep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: sheetWidth,
        pixelsHigh: sheetHeight,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fatalError("Failed to create contact sheet bitmap")
    }
    sheetRep.size = NSSize(width: sheetWidth, height: sheetHeight)

    withGraphicsContext(sheetRep) {
        let fullRect = CGRect(x: 0, y: 0, width: sheetWidth, height: sheetHeight)

        // Two horizontal strips: dark on top, light below (drawing origin is bottom-left).
        let darkStripRect = CGRect(x: 0, y: rowHeight + rowSpacing, width: CGFloat(sheetWidth), height: rowHeight)
        let lightStripRect = CGRect(x: 0, y: 0, width: CGFloat(sheetWidth), height: rowHeight)

        lightBG.setFill()
        NSBezierPath(rect: fullRect).fill()
        darkBG.setFill()
        NSBezierPath(rect: darkStripRect).fill()
        lightBG.setFill()
        NSBezierPath(rect: lightStripRect).fill()

        func drawRow(in stripRect: CGRect) {
            var x = padding
            let centerY = stripRect.midY

            for size in colorSizes {
                let cellSize = CGFloat(size)
                let cellRect = CGRect(x: x, y: centerY - cellSize / 2, width: cellSize, height: cellSize)
                let cornerRadius = cellSize * 0.22
                let bgPath = NSBezierPath(roundedRect: cellRect, xRadius: cornerRadius, yRadius: cornerRadius)
                colorBackground.setFill()
                bgPath.fill()
                drawArchiveGlyph(in: cellRect, glyphFraction: 0.60, boxColor: colorPrimaryRed, slotColor: colorAccentRed)
                x += maxCellSize + cellSpacing
            }

            for size in templateSizes {
                let cellSize = CGFloat(size)
                let cellRect = CGRect(x: x, y: centerY - cellSize / 2, width: cellSize, height: cellSize)
                drawArchiveGlyph(in: cellRect, glyphFraction: 0.76, boxColor: colorTemplateBlack, slotColor: nil)
                x += maxCellSize + cellSpacing
            }
        }

        drawRow(in: darkStripRect)
        drawRow(in: lightStripRect)
    }

    return sheetRep
}

let contactSheetURL = outDir.appendingPathComponent("contact-sheet.png")
writePNG(renderContactSheet(), to: contactSheetURL)
print("  wrote contact-sheet.png")

// MARK: - Validation

var validationFailures: [String] = []

func runSips(_ args: [String]) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        fatalError("Failed to run sips: \(error)")
    }
    process.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8) ?? ""
}

func actualPixelSize(of url: URL) -> (width: Int, height: Int)? {
    let output = runSips(["-g", "pixelWidth", "-g", "pixelHeight", url.path])
    var width: Int?
    var height: Int?
    for line in output.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("pixelWidth:") {
            width = Int(trimmed.replacingOccurrences(of: "pixelWidth:", with: "").trimmingCharacters(in: .whitespaces))
        } else if trimmed.hasPrefix("pixelHeight:") {
            height = Int(trimmed.replacingOccurrences(of: "pixelHeight:", with: "").trimmingCharacters(in: .whitespaces))
        }
    }
    guard let w = width, let h = height else { return nil }
    return (w, h)
}

print("\nValidating output files...")

// 1. Every manifest file exists with exact expected pixel dimensions.
for spec in manifest {
    let url = outDir.appendingPathComponent(spec.filename)
    guard FileManager.default.fileExists(atPath: url.path) else {
        validationFailures.append("MISSING: \(spec.filename)")
        continue
    }
    guard let actual = actualPixelSize(of: url) else {
        validationFailures.append("UNREADABLE DIMENSIONS: \(spec.filename)")
        continue
    }
    if actual.width != spec.size || actual.height != spec.size {
        validationFailures.append("SIZE MISMATCH: \(spec.filename) expected \(spec.size)x\(spec.size), got \(actual.width)x\(actual.height)")
    } else {
        print("  OK  \(spec.filename): \(actual.width)x\(actual.height)")
    }
}

// Contact sheet existence check (dimensions are not fixed/expected, just must exist).
if !FileManager.default.fileExists(atPath: contactSheetURL.path) {
    validationFailures.append("MISSING: contact-sheet.png")
} else if let actual = actualPixelSize(of: contactSheetURL) {
    print("  OK  contact-sheet.png: \(actual.width)x\(actual.height)")
} else {
    validationFailures.append("UNREADABLE DIMENSIONS: contact-sheet.png")
}

// 2. Template PNGs must contain no colored pixels: everywhere alpha > 0, RGB must be 0.
func verifyTemplatePurity(url: URL) -> Bool {
    guard let dataProvider = CGDataProvider(url: url as CFURL),
          let cgImage = CGImage(
            pngDataProviderSource: dataProvider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
          ) else {
        validationFailures.append("TEMPLATE PURITY: failed to decode \(url.lastPathComponent)")
        return false
    }

    let width = cgImage.width
    let height = cgImage.height
    let bytesPerPixel = 4
    let bytesPerRow = bytesPerPixel * width
    var pixelData = [UInt8](repeating: 0, count: bytesPerRow * height)

    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        validationFailures.append("TEMPLATE PURITY: failed to create color space for \(url.lastPathComponent)")
        return false
    }

    guard let context = CGContext(
        data: &pixelData,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        validationFailures.append("TEMPLATE PURITY: failed to create bitmap context for \(url.lastPathComponent)")
        return false
    }

    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    for pixelIndex in 0..<(width * height) {
        let offset = pixelIndex * bytesPerPixel
        let r = pixelData[offset]
        let g = pixelData[offset + 1]
        let b = pixelData[offset + 2]
        let a = pixelData[offset + 3]
        if a > 0 && (r != 0 || g != 0 || b != 0) {
            validationFailures.append(
                "TEMPLATE PURITY: \(url.lastPathComponent) has colored pixel at index \(pixelIndex) (r=\(r) g=\(g) b=\(b) a=\(a))"
            )
            return false
        }
    }
    return true
}

var templatePurityOK = true
for spec in manifest where spec.kind == .template {
    let url = outDir.appendingPathComponent(spec.filename)
    let ok = verifyTemplatePurity(url: url)
    templatePurityOK = templatePurityOK && ok
    if ok {
        print("  OK  \(spec.filename): template purity (no colored pixels)")
    }
}

// MARK: - Report & exit

if validationFailures.isEmpty {
    print("\nAll checks passed.")
    print("Contact sheet: \(contactSheetURL.path)")
    exit(0)
} else {
    print("\nVALIDATION FAILED:")
    for failure in validationFailures {
        print("  - \(failure)")
    }
    exit(1)
}
