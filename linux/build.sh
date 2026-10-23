#!/usr/bin/env bash
# Builds The Stupid Buddy for Linux (the Rust app in windows/, which builds for both) and packages it as
# dist/StupidBuddy-<version>-linux-amd64.deb. Stupid OS's updater finds the package in each GitHub release by that
# -linux-amd64.deb ending, so keep it. Needs: Rust, cargo-deb (cargo install cargo-deb), ImageMagick, and
# libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev pkg-config.
set -euo pipefail
cd "$(dirname "$0")/../windows"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
[ "$version" = "$(cat ../VERSION)" ] || echo "Note: Cargo.toml says $version, VERSION says $(cat ../VERSION); the package uses $version." >&2

cargo build --release
# The app icon in the sizes desktops look for, from the Mac icon art.
for s in 16 24 32 48 64 128 256 512; do
  mkdir -p "target/linux-icons/${s}x${s}/apps"
  convert ../mac/icon-1024.png -resize "${s}x${s}" "target/linux-icons/${s}x${s}/apps/stupid-buddy.png"
done
mkdir -p ../dist
cargo deb --no-build --output "../dist/StupidBuddy-$version-linux-amd64.deb"
ls -l "../dist/StupidBuddy-$version-linux-amd64.deb"
