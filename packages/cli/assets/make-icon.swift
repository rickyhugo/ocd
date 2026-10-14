// Draws OCD's icon (1024×1024 PNG, transparent margin per the macOS icon grid).
// OpenCode's mark (a thick white "o" on near-black) drawn to bother anyone with
// OCD: a careful grid, guides and registration marks, and then, against them,
// a tilted, off-centre "o", unsorted and misaligned bars, one crooked mark, one
// stray grid line and a guide that ends on half a dash.
// Usage: swift packages/cli/assets/make-icon.swift <out.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

// Body: the macOS grid's 824×824 rounded square, centred.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.35))
ctx.addPath(shape)
ctx.setFillColor(rgb(0x131010))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()

// Graph paper: a 32px grid laid out from the centre, so a line runs through it.
let cell: CGFloat = 32
ctx.setLineWidth(2)
ctx.setStrokeColor(rgb(0xFFFFFF, 0.05))
var v: CGFloat = 512 - 12 * cell
while v <= 512 + 12 * cell {
  // One vertical line is 7px out of place.
  let x = v == 512 + 7 * cell ? v + 7 : v
  ctx.move(to: CGPoint(x: x, y: 100))
  ctx.addLine(to: CGPoint(x: x, y: 924))
  ctx.move(to: CGPoint(x: 100, y: v))
  ctx.addLine(to: CGPoint(x: 924, y: v))
  v += cell
}
ctx.strokePath()

// Centre guides, like a design tool's smart guides. Dashed outward from the
// centre in each direction, so both ends match exactly.
let guide = rgb(0xFF4D6D, 0.85)
ctx.setStrokeColor(guide)
ctx.setLineWidth(4)
ctx.setLineDash(phase: 0, lengths: [16, 16])
for (dx, dy) in [(0, 1), (0, -1), (1, 0), (-1, 0)] as [(CGFloat, CGFloat)] {
  // The right-hand guide stops 10px early: it ends on half a dash.
  let length: CGFloat = dx == 1 ? 342 : 352
  ctx.move(to: CGPoint(x: 512, y: 512))
  ctx.addLine(to: CGPoint(x: 512 + dx * length, y: 512 + dy * length))
}
ctx.strokePath()
ctx.setLineDash(phase: 0, lengths: [])

// The "o": OpenCode's proportions, 10×12 cells with a 2-cell stroke, on the grid.
let outer = CGRect(x: 512 - 5 * cell, y: 512 - 6 * cell, width: 10 * cell, height: 12 * cell)
let stroke: CGFloat = 2 * cell
let hole = outer.insetBy(dx: stroke, dy: stroke)
// ...nudged off the guides and tilted, just enough to see.
ctx.saveGState()
ctx.translateBy(x: 512 + 13, y: 512 - 9)
ctx.rotate(by: -2.4 * .pi / 180)
ctx.translateBy(x: -512, y: -512)
ctx.setFillColor(rgb(0xFFFFFF))
ctx.fill(outer)
// The guides stop at the "o": nothing crosses into it.
ctx.setFillColor(rgb(0x131010))
ctx.fill(hole)

// The hole's contents, sorted: three bars of exactly 2 cells, equal half-cell
// gaps, darkest at the bottom (where OpenCode's grey block sits).
let gap: CGFloat = cell / 2
let barH = (hole.height - 4 * gap) / 3
// Not sorted after all (light, dark, middle), and the middle bar is shoved right.
let bars: [(UInt32, CGFloat)] = [(0x5A5858, 0), (0x9C9A9A, 14), (0x7A7878, 0)]
for (i, bar) in bars.enumerated() {
  let y = hole.minY + gap + CGFloat(i) * (barH + gap)
  ctx.setFillColor(rgb(bar.0))
  ctx.fill(CGRect(x: hole.minX + gap + bar.1, y: y, width: hole.width - 2 * gap, height: barH))
}
ctx.restoreGState()

// Registration marks at the four corners of the "o".
ctx.setStrokeColor(guide)
ctx.setLineWidth(5)
for corner in [
  CGPoint(x: outer.minX, y: outer.minY), CGPoint(x: outer.maxX, y: outer.minY),
  CGPoint(x: outer.minX, y: outer.maxY), CGPoint(x: outer.maxX, y: outer.maxY),
] {
  let dx: CGFloat = corner.x < 512 ? -1 : 1
  let dy: CGFloat = corner.y < 512 ? -1 : 1
  let c = CGPoint(x: corner.x + dx * cell, y: corner.y + dy * cell)
  // The top-right mark is crooked.
  let tilt: CGFloat = dx == 1 && dy == 1 ? 17 * .pi / 180 : 0
  let a = CGPoint(x: cos(tilt) * cell / 2, y: sin(tilt) * cell / 2)
  ctx.move(to: CGPoint(x: c.x - a.x, y: c.y - a.y))
  ctx.addLine(to: CGPoint(x: c.x + a.x, y: c.y + a.y))
  ctx.move(to: CGPoint(x: c.x + a.y, y: c.y - a.x))
  ctx.addLine(to: CGPoint(x: c.x - a.y, y: c.y + a.x))
}
ctx.strokePath()
ctx.restoreGState()

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
