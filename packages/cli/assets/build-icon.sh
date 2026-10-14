#!/bin/sh
# Regenerates ocd.icns (macOS, every size) and ocd-icon.png (Linux, 256px)
# from make-icon.swift. macOS only: needs swift, sips and iconutil.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swift "$here/make-icon.swift" "$work/icon.png"
set_dir="$work/ocd.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
	sips -z $size $size "$work/icon.png" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
	double=$((size * 2))
	sips -z $double $double "$work/icon.png" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$here/ocd.icns"
sips -z 256 256 "$work/icon.png" --out "$here/ocd-icon.png" >/dev/null
echo "wrote $here/ocd.icns and $here/ocd-icon.png"
