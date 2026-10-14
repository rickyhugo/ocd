// Draws OCD's icon (1024×1024 PNG, transparent margin per the macOS icon grid):
// a supervisor hub wired to three workers, one per harness.
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

// Soft drop shadow under the body.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.35))
ctx.addPath(shape)
ctx.setFillColor(rgb(0x1E1B4B))
ctx.fillPath()
ctx.restoreGState()

// Background: indigo, lighter at the top.
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let bg = CGGradient(
  colorsSpace: space, colors: [rgb(0x6366F1), rgb(0x312E81), rgb(0x1E1B4B)] as CFArray,
  locations: [0, 0.55, 1])!
ctx.drawLinearGradient(
  bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
// A faint glow behind the hub.
let glow = CGGradient(
  colorsSpace: space, colors: [rgb(0xA5B4FC, 0.35), rgb(0xA5B4FC, 0)] as CFArray,
  locations: [0, 1])!
ctx.drawRadialGradient(
  glow, startCenter: CGPoint(x: 512, y: 512), startRadius: 0,
  endCenter: CGPoint(x: 512, y: 512), endRadius: 330, options: [])
ctx.restoreGState()

let hub = CGPoint(x: 512, y: 512)
// Workers: OpenCode (sky), Claude Code (amber), Codex (mint), evenly around the hub.
let workers: [(CGFloat, UInt32)] = [(90, 0x38BDF8), (210, 0xFBBF24), (330, 0x34D399)]
let orbit: CGFloat = 255
func point(_ degrees: CGFloat) -> CGPoint {
  let r = degrees * .pi / 180
  return CGPoint(x: hub.x + orbit * cos(r), y: hub.y + orbit * sin(r))
}

// The orbit the workers sit on.
ctx.setLineWidth(10)
ctx.setStrokeColor(rgb(0xE0E7FF, 0.16))
ctx.strokeEllipse(
  in: CGRect(x: hub.x - orbit, y: hub.y - orbit, width: orbit * 2, height: orbit * 2))

// Wires.
ctx.setLineCap(.round)
ctx.setLineWidth(30)
ctx.setStrokeColor(rgb(0xE0E7FF, 0.7))
for (deg, _) in workers {
  ctx.move(to: hub)
  ctx.addLine(to: point(deg))
}
ctx.strokePath()

// Worker nodes with a white rim.
for (deg, color) in workers {
  let p = point(deg)
  ctx.setFillColor(rgb(0xFFFFFF))
  ctx.fillEllipse(in: CGRect(x: p.x - 78, y: p.y - 78, width: 156, height: 156))
  ctx.setFillColor(rgb(color))
  ctx.fillEllipse(in: CGRect(x: p.x - 60, y: p.y - 60, width: 120, height: 120))
}

// Hub: white disc with an indigo core.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: rgb(0x000000, 0.3))
ctx.setFillColor(rgb(0xFFFFFF))
ctx.fillEllipse(in: CGRect(x: hub.x - 120, y: hub.y - 120, width: 240, height: 240))
ctx.restoreGState()
ctx.setFillColor(rgb(0x4338CA))
ctx.fillEllipse(in: CGRect(x: hub.x - 56, y: hub.y - 56, width: 112, height: 112))

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
