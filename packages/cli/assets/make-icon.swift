// Draws OCD's icon (1024×1024 PNG, transparent margin per the macOS icon grid).
// OpenCode's mark (a thick white "o" on near-black) drawn to bother anyone with
// OCD: careful scaffolding (a grid, centre guides, registration marks) and,
// against it, everything a little wrong. Every flaw is deliberate; see below.
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

/// A rounded rectangle whose corners need not match (bl, br, tr, tl; y up).
func roundedRect(_ r: CGRect, _ bl: CGFloat, _ br: CGFloat, _ tr: CGFloat, _ tl: CGFloat) -> CGPath {
  let p = CGMutablePath()
  p.move(to: CGPoint(x: r.minX + bl, y: r.minY))
  p.addLine(to: CGPoint(x: r.maxX - br, y: r.minY))
  p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + br), radius: br)
  p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - tr))
  p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.maxX - tr, y: r.maxY), radius: tr)
  p.addLine(to: CGPoint(x: r.minX + tl, y: r.maxY))
  p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY - tl), radius: tl)
  p.addLine(to: CGPoint(x: r.minX, y: r.minY + bl))
  p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + bl, y: r.minY), radius: bl)
  p.closeSubpath()
  return p
}

/// Draws `body` rotated by `degrees` around `centre`.
func rotated(_ degrees: CGFloat, around centre: CGPoint, _ body: () -> Void) {
  ctx.saveGState()
  ctx.translateBy(x: centre.x, y: centre.y)
  ctx.rotate(by: degrees * .pi / 180)
  ctx.translateBy(x: -centre.x, y: -centre.y)
  body()
  ctx.restoreGState()
}

// Body: the macOS grid's 824×824 rounded square. The top-right corner is
// rounded noticeably less than the other three.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = roundedRect(body, 185, 185, 128, 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.35))
ctx.addPath(shape)
ctx.setFillColor(rgb(0x131010))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()

// Graph paper: a 32px grid laid out from the centre. Two lines are out of
// place and one is missing.
let cell: CGFloat = 32
ctx.setLineWidth(2)
ctx.setStrokeColor(rgb(0xFFFFFF, 0.06))
for i in -12...12 {
  let v = 512 + CGFloat(i) * cell
  let x = i == 7 ? v + 7 : (i == -5 ? v - 5 : v)
  ctx.move(to: CGPoint(x: x, y: 100))
  ctx.addLine(to: CGPoint(x: x, y: 924))
  if i != 4 {
    ctx.move(to: CGPoint(x: 100, y: v))
    ctx.addLine(to: CGPoint(x: 924, y: v))
  }
}
ctx.strokePath()

// Centre guides. The vertical one is 9px right of centre; the horizontal one
// keeps a different dash rhythm on each side and ends on half a dash.
let guide = rgb(0xFF4D6D, 0.85)
ctx.setStrokeColor(guide)
ctx.setLineWidth(4)
ctx.setLineDash(phase: 0, lengths: [16, 16])
for (dx, dy) in [(0, 1), (0, -1)] as [(CGFloat, CGFloat)] {
  ctx.move(to: CGPoint(x: 521, y: 512))
  ctx.addLine(to: CGPoint(x: 521 + dx * 352, y: 512 + dy * 352))
}
ctx.move(to: CGPoint(x: 512, y: 512))
ctx.addLine(to: CGPoint(x: 160, y: 512))
ctx.strokePath()
ctx.setLineDash(phase: 0, lengths: [22, 10])
ctx.move(to: CGPoint(x: 512, y: 512))
ctx.addLine(to: CGPoint(x: 851, y: 512))
ctx.strokePath()
ctx.setLineDash(phase: 0, lengths: [])

// A stray dash where nothing should be.
ctx.setLineWidth(4)
ctx.move(to: CGPoint(x: 236, y: 822))
ctx.addLine(to: CGPoint(x: 256, y: 829))
ctx.strokePath()

// The "o": OpenCode's proportions on the grid, then tilted 5.5° and pushed off
// the guides. Its stroke is not the same thickness on every side.
let outer = CGRect(x: 512 - 5 * cell, y: 512 - 6 * cell, width: 10 * cell, height: 12 * cell)
let hole = CGRect(
  x: outer.minX + 72, y: outer.minY + 78,
  width: outer.width - 72 - 54, height: outer.height - 78 - 62)
let centre = CGPoint(x: 512, y: 512)
ctx.saveGState()
ctx.translateBy(x: 24, y: -16)
rotated(-5.5, around: centre) {
  ctx.setFillColor(rgb(0xFFFFFF))
  ctx.fill(outer)
  ctx.setFillColor(rgb(0x131010))
  ctx.fill(hole)

  // The bars: out of order, different lengths, each at its own angle, one of
  // them very slightly the wrong grey, and the middle one poking out over the
  // white stroke.
  let gap: CGFloat = 14
  let barH = (hole.height - 4 * gap) / 3
  let bars: [(color: UInt32, inset: CGFloat, shift: CGFloat, tilt: CGFloat)] = [
    (0x5A5858, 16, 0, 1.5),
    (0x9DA39A, 16, 30, -4),  // a touch green
    (0x7A7878, 40, -6, 2.5),
  ]
  for (i, bar) in bars.enumerated() {
    let rect = CGRect(
      x: hole.minX + bar.inset + bar.shift, y: hole.minY + gap + CGFloat(i) * (barH + gap),
      width: hole.width - bar.inset - 16, height: barH)
    rotated(bar.tilt, around: CGPoint(x: rect.midX, y: rect.midY)) {
      ctx.setFillColor(rgb(bar.color))
      ctx.fill(rect)
    }
  }
}
ctx.restoreGState()

// One bar fell out of the "o" and is lying below it, crooked.
rotated(-14, around: CGPoint(x: 708, y: 236)) {
  ctx.setFillColor(rgb(0x6A6868))
  ctx.fill(CGRect(x: 658, y: 214, width: 100, height: 44))
}

// Registration marks one cell outside each corner of where the "o" should be:
// one fine, one crooked, one missing and one drawn twice, slightly apart.
ctx.setStrokeColor(guide)
ctx.setLineWidth(5)
func mark(_ c: CGPoint, tilt: CGFloat = 0) {
  let t = tilt * .pi / 180
  let a = CGPoint(x: cos(t) * cell / 2, y: sin(t) * cell / 2)
  ctx.move(to: CGPoint(x: c.x - a.x, y: c.y - a.y))
  ctx.addLine(to: CGPoint(x: c.x + a.x, y: c.y + a.y))
  ctx.move(to: CGPoint(x: c.x + a.y, y: c.y - a.x))
  ctx.addLine(to: CGPoint(x: c.x - a.y, y: c.y + a.x))
}
mark(CGPoint(x: outer.minX - cell, y: outer.maxY + cell))
mark(CGPoint(x: outer.maxX + cell, y: outer.maxY + cell), tilt: 21)
mark(CGPoint(x: outer.maxX + cell, y: outer.minY - cell))
mark(CGPoint(x: outer.maxX + cell + 7, y: outer.minY - cell + 5))
ctx.strokePath()
ctx.restoreGState()

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
