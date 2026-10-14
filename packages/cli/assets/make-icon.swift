// Draws OCD's icon (1024×1024 PNG, transparent margin per the macOS icon grid).
// OpenCode's mark (a thick white "o" on near-black, grey contents) drawn to
// bother anyone with OCD: flat and clean, but nothing where it belongs. The
// "o" leans, its bars are jumbled, one is escaping through the wall and two
// have fallen out into a crooked pile.
//
// Full bleed: the artwork fills the whole square and macOS applies its own
// rounded mask. (macOS 26 shrinks icons that bring their own rounded corners
// and transparent margin onto a grey tile.)
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

/// Draws `body` rotated by `degrees` (counter-clockwise) around `centre`.
func rotated(_ degrees: CGFloat, around centre: CGPoint, _ body: () -> Void) {
  ctx.saveGState()
  ctx.translateBy(x: centre.x, y: centre.y)
  ctx.rotate(by: degrees * .pi / 180)
  ctx.translateBy(x: -centre.x, y: -centre.y)
  body()
  ctx.restoreGState()
}

/// A flat bar of the given size, centred at `c`, turned by `tilt` degrees.
func bar(_ c: CGPoint, _ w: CGFloat, _ h: CGFloat, _ color: UInt32, tilt: CGFloat) {
  rotated(tilt, around: c) {
    ctx.setFillColor(rgb(color))
    ctx.fill(CGRect(x: c.x - w / 2, y: c.y - h / 2, width: w, height: h))
  }
}

let dark: UInt32 = 0x131010

// Body: the whole square, edge to edge; artwork scaled up from the 824px
// rounded-square layout so it keeps its place inside macOS's mask.
ctx.setFillColor(rgb(dark))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
ctx.saveGState()
ctx.translateBy(x: 512, y: 512)
ctx.scaleBy(x: 1024 / 824, y: 1024 / 824)
ctx.translateBy(x: -512, y: -512)

// The "o" (OpenCode's proportions), leaning 8° and sitting high and left. Its
// walls are not equally thick. Everything inside leans with it, and more.
let o = CGPoint(x: 492, y: 560)
let outer = CGRect(x: o.x - 150, y: o.y - 190, width: 300, height: 380)
let hole = CGRect(x: outer.minX + 70, y: outer.minY + 82, width: 300 - 70 - 54, height: 380 - 82 - 64)
rotated(8, around: o) {
  ctx.setFillColor(rgb(0xFFFFFF))
  ctx.fill(outer)
  ctx.setFillColor(rgb(dark))
  ctx.fill(hole)
  ctx.saveGState()
  ctx.clip(to: hole)
  // Left inside: two bars, neither straight, the lighter one below the darker.
  bar(CGPoint(x: hole.midX - 6, y: hole.minY + 44), 140, 52, 0x8E8C8C, tilt: -7)
  bar(CGPoint(x: hole.midX + 10, y: hole.maxY - 48), 118, 52, 0x5A5858, tilt: 11)
  ctx.restoreGState()
}

// One bar half way out through the right-hand wall, drawn over it.
bar(CGPoint(x: 622, y: 548), 170, 52, 0x747272, tilt: -19)

// Two bars that fell out, in a crooked pile on the floor.
bar(CGPoint(x: 640, y: 232), 196, 54, 0x6A6868, tilt: -4)
bar(CGPoint(x: 668, y: 286), 132, 50, 0x9A9898, tilt: 13)

ctx.restoreGState()

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
