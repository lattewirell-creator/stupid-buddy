#!/usr/bin/env bash
# Builds mac/build.noindex/The Stupid Buddy.app (one app for Apple chip and Intel; ".noindex" keeps Spotlight and
# Launchpad from listing build copies as extra apps). Usage: bash mac/build.sh
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(cat ../VERSION 2>/dev/null || echo 0.1.0)
APP="build.noindex/The Stupid Buddy.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos14.0" -o "build.noindex/StupidBuddy-$arch" Sources/*.swift -framework Cocoa -framework WebKit -framework PDFKit
done
lipo -create -output "$APP/Contents/MacOS/StupidBuddy" build.noindex/StupidBuddy-arm64 build.noindex/StupidBuddy-x86_64
rm -f build.noindex/StupidBuddy-arm64 build.noindex/StupidBuddy-x86_64
cp -R ../ui "$APP/Contents/Resources/ui"
[ -f icon.icns ] && cp icon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>The Stupid Buddy</string>
  <key>CFBundleDisplayName</key><string>The Stupid Buddy</string>
  <key>CFBundleIdentifier</key><string>com.emil.stupidbuddy</string>
  <key>CFBundleExecutable</key><string>StupidBuddy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSDesktopFolderUsageDescription</key><string>Buddy can sort and find files on your Desktop when you ask.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Buddy can find, read and tidy documents when you ask.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Buddy can tidy and find things in Downloads when you ask.</string>
</dict></plist>
EOF
codesign --force --deep --sign - "$APP"
echo "built $APP"
