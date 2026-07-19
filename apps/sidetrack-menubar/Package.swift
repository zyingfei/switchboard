// swift-tools-version: 6.0
//
// Sidetrack menu-bar app — a native SwiftUI MenuBarExtra that makes the
// otherwise-invisible local companion daemon visible: is it up, which
// build is running, and one-click start/stop/restart.
//
// SwiftPM builds the executable; build.sh wraps the binary in a proper
// .app bundle (Info.plist with LSUIElement, bundle id
// local.sidetrack.menubar). See README.md.
//
// macOS 14+ is required for MenuBarExtra's `.window` style and the
// scene-based menu-bar API used here.

import PackageDescription

let package = Package(
    name: "Sidetrack",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "Sidetrack",
            path: "Sources/Sidetrack"
        )
    ]
)
