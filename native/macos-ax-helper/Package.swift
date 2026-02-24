// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "macos-ax-helper",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "macos-ax-helper", targets: ["macos-ax-helper"])
    ],
    targets: [
        .executableTarget(
            name: "macos-ax-helper",
            path: "Sources/macos-ax-helper"
        )
    ]
)
