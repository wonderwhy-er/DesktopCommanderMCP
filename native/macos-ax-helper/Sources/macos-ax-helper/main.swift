import Foundation
import AppKit
import ApplicationServices
import CryptoKit

let helperVersion = "0.1.0"

let interactiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXSecureTextField",
    "AXComboBox", "AXPopUpButton", "AXSlider", "AXLink", "AXMenuItem", "AXMenuButton", "AXMenu",
    "AXMenuBar", "AXMenuBarItem", "AXTab", "AXTabGroup", "AXToolbar", "AXToolbarButton", "AXIncrementor",
    "AXColorWell", "AXDateField", "AXDisclosureTriangle", "AXList", "AXOutline", "AXTable", "AXCell",
    "AXRow", "AXColumn", "AXScrollBar", "AXSplitter", "AXSearchField", "AXSegmentedControl", "AXStepper",
    "AXSwitch", "AXToggle"
]

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28,
    "9": 25, "0": 29,
    " ": 49, "\n": 36, "\t": 48,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
    ",": 43, ".": 47, "/": 44, "`": 50,
    "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

let shiftChars: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
    "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`"
]

let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand,
    "shift": .maskShift,
    "alt": .maskAlternate,
    "ctrl": .maskControl,
]

enum HelperCode: String {
    case unsupportedPlatform = "UNSUPPORTED_PLATFORM"
    case permissionDenied = "PERMISSION_DENIED"
    case invalidArgument = "INVALID_ARGUMENT"
    case notFound = "NOT_FOUND"
    case timeout = "TIMEOUT"
    case actionFailed = "ACTION_FAILED"
    case internalError = "INTERNAL_ERROR"
}

func makeMeta(requestId: String?, startedAt: Date) -> [String: Any] {
    let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
    var meta: [String: Any] = ["durationMs": durationMs]
    if let requestId {
        meta["requestId"] = requestId
    }
    return meta
}

func printResponse(_ object: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        if let text = String(data: data, encoding: .utf8) {
            print(text)
        } else {
            print("{\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Failed to encode response\"}}")
        }
    } catch {
        print("{\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Response serialization failed\"}}")
    }
}

func successResponse(data: Any, requestId: String?, startedAt: Date) {
    printResponse([
        "ok": true,
        "data": data,
        "meta": makeMeta(requestId: requestId, startedAt: startedAt),
    ])
}

func errorResponse(code: HelperCode, message: String, details: [String: Any]? = nil, requestId: String?, startedAt: Date) {
    var errorObject: [String: Any] = [
        "code": code.rawValue,
        "message": message,
    ]

    if let details {
        errorObject["details"] = details
    }

    printResponse([
        "ok": false,
        "error": errorObject,
        "meta": makeMeta(requestId: requestId, startedAt: startedAt),
    ])
}

func isMacOS() -> Bool {
    #if os(macOS)
    return true
    #else
    return false
    #endif
}

func accessibilityTrusted(prompt: Bool = false) -> Bool {
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [promptKey: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func processInfoString() -> String {
    let executable = CommandLine.arguments.first ?? "unknown"
    return "PID: \(ProcessInfo.processInfo.processIdentifier), Executable: \(executable)"
}

func axGetAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if error == .success, let value {
        return value as AnyObject
    }
    return nil
}

func axGetAttributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let error = AXUIElementCopyAttributeNames(element, &names)
    if error == .success, let names {
        return names as? [String] ?? []
    }
    return []
}

func axGetActions(_ element: AXUIElement) -> [String] {
    var actions: CFArray?
    let error = AXUIElementCopyActionNames(element, &actions)
    if error == .success, let actions {
        return actions as? [String] ?? []
    }
    return []
}

func axElement(from value: AnyObject?) -> AXUIElement? {
    guard let value else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func axPerformAction(_ element: AXUIElement, _ action: String) -> Bool {
    AXUIElementPerformAction(element, action as CFString) == .success
}

func axPoint(from value: AnyObject?) -> CGPoint? {
    guard let value else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    if AXValueGetType(axValue) != .cgPoint { return nil }
    var point = CGPoint.zero
    if AXValueGetValue(axValue, .cgPoint, &point) {
        return point
    }
    return nil
}

func axSize(from value: AnyObject?) -> CGSize? {
    guard let value else { return nil }
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    if AXValueGetType(axValue) != .cgSize { return nil }
    var size = CGSize.zero
    if AXValueGetValue(axValue, .cgSize, &size) {
        return size
    }
    return nil
}

func isElementVisibleOnScreen(bounds: CGRect) -> Bool {
    if bounds.width <= 0 || bounds.height <= 0 {
        return false
    }

    for screen in NSScreen.screens {
        if screen.frame.intersects(bounds) {
            return true
        }
    }

    return false
}

func elementTitle(role: String, title: String, value: AnyObject?) -> String {
    if !title.isEmpty {
        return title
    }

    if let stringValue = value as? String, !stringValue.isEmpty {
        return String(stringValue.prefix(120))
    }

    if role == "AXRow" || role == "AXCell" || role == "AXGroup" {
        return ""
    }

    return ""
}

func firstStaticTextValue(in element: AXUIElement, maxDepth: Int = 2, currentDepth: Int = 0) -> String? {
    if currentDepth > maxDepth {
        return nil
    }

    let children = axGetAttribute(element, kAXChildrenAttribute as String) as? [AnyObject] ?? []
    for child in children {
        guard CFGetTypeID(child) == AXUIElementGetTypeID() else {
            continue
        }

        let childElement = child as! AXUIElement
        let childRole = (axGetAttribute(childElement, kAXRoleAttribute as String) as? String) ?? ""
        if childRole == "AXStaticText",
           let value = axGetAttribute(childElement, kAXValueAttribute as String) as? String,
           !value.isEmpty {
            return String(value.prefix(120))
        }

        if let nested = firstStaticTextValue(in: childElement, maxDepth: maxDepth, currentDepth: currentDepth + 1) {
            return nested
        }
    }

    return nil
}

func boolLikeValue(_ value: AnyObject?) -> Bool? {
    if let boolValue = value as? Bool {
        return boolValue
    }

    if let numberValue = value as? NSNumber {
        return numberValue.intValue != 0
    }

    return nil
}

func stableElementId(pid: pid_t, role: String, title: String, bounds: CGRect) -> String {
    let payload = "\(pid):\(role):\(title):\(Int(bounds.origin.x)):\(Int(bounds.origin.y)):\(Int(bounds.width)):\(Int(bounds.height))"
    let digest = SHA256.hash(data: Data(payload.utf8))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return "\(pid)-\(hex.prefix(12))"
}

func visibleWindowOwnerPIDs() -> Set<pid_t> {
    var pids = Set<pid_t>()

    guard let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return pids
    }

    for window in windowList {
        if let ownerPID = window[kCGWindowOwnerPID as String] as? NSNumber {
            pids.insert(pid_t(ownerPID.int32Value))
        }
    }

    return pids
}

func runningApps(visibleOnly: Bool = false) -> [NSRunningApplication] {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    guard visibleOnly else {
        return apps
    }

    let visiblePIDs = visibleWindowOwnerPIDs()
    return apps.filter { visiblePIDs.contains($0.processIdentifier) }
}

func appName(_ app: NSRunningApplication) -> String {
    app.localizedName ?? "Unknown"
}

func parseAppIdentifier(_ value: Any?) -> String? {
    if let string = value as? String, !string.isEmpty {
        return string
    }
    if let number = value as? NSNumber {
        return String(number.intValue)
    }
    return nil
}

func findApp(_ identifier: String) -> NSRunningApplication? {
    let apps = runningApps()

    if let pid = Int32(identifier) {
        return apps.first(where: { $0.processIdentifier == pid })
    }

    let lower = identifier.lowercased()
    if let exact = apps.first(where: { (appName($0)).lowercased() == lower }) {
        return exact
    }

    return apps.first(where: { appName($0).lowercased().contains(lower) })
}

func appWindows(_ axApp: AXUIElement) -> [AXUIElement] {
    let values = axGetAttribute(axApp, kAXWindowsAttribute as String) as? [AnyObject] ?? []
    return values.compactMap { value in
        if CFGetTypeID(value) == AXUIElementGetTypeID() {
            return (value as! AXUIElement)
        }
        return nil
    }
}

func mainOrFrontWindow(_ axApp: AXUIElement) -> AXUIElement? {
    if let focused = axElement(from: axGetAttribute(axApp, kAXFocusedWindowAttribute as String)) {
        return focused
    }

    let windows = appWindows(axApp)
    if windows.isEmpty {
        return nil
    }

    for window in windows {
        if let isMain = axGetAttribute(window, kAXMainAttribute as String) as? Bool, isMain {
            return window
        }
    }

    for window in windows {
        if let minimized = axGetAttribute(window, kAXMinimizedAttribute as String) as? Bool, minimized {
            continue
        }
        return window
    }

    return windows.first
}

struct ElementQuery {
    let text: String?
    let roles: Set<String>?
    let depth: Int
    let limit: Int
}

func matchesQuery(_ element: [String: Any], query: ElementQuery) -> Bool {
    if let roles = query.roles, let role = element["role"] as? String, !roles.contains(role) {
        return false
    }

    if let text = query.text?.lowercased(), !text.isEmpty {
        let haystack = [
            element["title"] as? String ?? "",
            element["desc"] as? String ?? "",
            element["label"] as? String ?? "",
            element["text"] as? String ?? "",
        ].joined(separator: " ").lowercased()

        return haystack.contains(text)
    }

    return true
}

func elementInfo(
    element: AXUIElement,
    appName: String,
    pid: pid_t,
    focusedElement: AXUIElement?
) -> [String: Any]? {
    let role = (axGetAttribute(element, kAXRoleAttribute as String) as? String) ?? ""
    if role.isEmpty || !interactiveRoles.contains(role) {
        return nil
    }

    if let enabled = axGetAttribute(element, kAXEnabledAttribute as String) as? Bool, !enabled {
        return nil
    }

    if let hidden = axGetAttribute(element, kAXHiddenAttribute as String) as? Bool, hidden {
        return nil
    }

    let point = axPoint(from: axGetAttribute(element, kAXPositionAttribute as String)) ?? .zero
    let size = axSize(from: axGetAttribute(element, kAXSizeAttribute as String)) ?? .zero
    let bounds = CGRect(origin: point, size: size)

    if !isElementVisibleOnScreen(bounds: bounds) {
        return nil
    }

    let rawTitle = (axGetAttribute(element, kAXTitleAttribute as String) as? String) ?? ""
    let description = (axGetAttribute(element, kAXDescriptionAttribute as String) as? String) ?? ""
    let roleDescription = (axGetAttribute(element, kAXRoleDescriptionAttribute as String) as? String) ?? ""
    let label = (axGetAttribute(element, "AXLabel") as? String) ?? ""
    let value = axGetAttribute(element, kAXValueAttribute as String)
    let textValue: String? = {
        if let stringValue = value as? String {
            return stringValue
        }
        if let numberValue = value as? NSNumber {
            return numberValue.stringValue
        }
        return nil
    }()

    var title = elementTitle(role: role, title: rawTitle, value: value)
    if title.isEmpty && (role == "AXRow" || role == "AXCell" || role == "AXGroup") {
        title = firstStaticTextValue(in: element) ?? ""
    }
    let id = stableElementId(pid: pid, role: role, title: title, bounds: bounds)
    let actions = axGetActions(element)

    var result: [String: Any] = [
        "id": id,
        "app": appName,
        "pid": Int(pid),
        "role": role,
        "bounds": [
            Int(bounds.origin.x.rounded()),
            Int(bounds.origin.y.rounded()),
            Int(bounds.width.rounded()),
            Int(bounds.height.rounded()),
        ]
    ]

    if !title.isEmpty {
        result["title"] = title
    }
    let effectiveDescription = !description.isEmpty ? description : roleDescription
    if !effectiveDescription.isEmpty {
        result["desc"] = effectiveDescription
    }
    if !label.isEmpty {
        result["label"] = label
    }
    if let textValue, !textValue.isEmpty {
        result["text"] = textValue
    }
    if !actions.isEmpty {
        result["actions"] = actions
    }

    if let focusedElement, CFEqual(element, focusedElement) {
        result["focused"] = true
    }

    if let selected = axGetAttribute(element, kAXSelectedAttribute as String) as? Bool, selected {
        result["selected"] = true
    }

    if ["AXSwitch", "AXCheckBox", "AXToggle", "AXRadioButton"].contains(role), let boolValue = boolLikeValue(value) {
        result["checked"] = boolValue
    }

    return result
}

func walkTree(
    element: AXUIElement,
    appName: String,
    pid: pid_t,
    focusedElement: AXUIElement?,
    query: ElementQuery,
    depth: Int,
    seen: inout Set<String>,
    results: inout [[String: Any]]
) {
    if depth > query.depth || results.count >= query.limit {
        return
    }

    if let info = elementInfo(element: element, appName: appName, pid: pid, focusedElement: focusedElement) {
        let id = info["id"] as? String ?? ""
        if !id.isEmpty && !seen.contains(id) && matchesQuery(info, query: query) {
            seen.insert(id)
            results.append(info)
            if results.count >= query.limit {
                return
            }
        }
    }

    let children = axGetAttribute(element, kAXChildrenAttribute as String) as? [AnyObject] ?? []
    for child in children {
        if results.count >= query.limit {
            return
        }
        if CFGetTypeID(child) == AXUIElementGetTypeID() {
            walkTree(
                element: (child as! AXUIElement),
                appName: appName,
                pid: pid,
                focusedElement: focusedElement,
                query: query,
                depth: depth + 1,
                seen: &seen,
                results: &results
            )
        }
    }

    let visibleChildren = axGetAttribute(element, kAXVisibleChildrenAttribute as String) as? [AnyObject] ?? []
    for child in visibleChildren {
        if results.count >= query.limit {
            return
        }
        if CFGetTypeID(child) == AXUIElementGetTypeID() {
            walkTree(
                element: (child as! AXUIElement),
                appName: appName,
                pid: pid,
                focusedElement: focusedElement,
                query: query,
                depth: depth + 1,
                seen: &seen,
                results: &results
            )
        }
    }
}

func collectElements(
    scope: String,
    appIdentifier: String?,
    text: String?,
    roles: [String]?,
    depth: Int,
    limit: Int
) -> [[String: Any]] {
    var targets: [NSRunningApplication] = []

    switch scope {
    case "top_window":
        if let front = NSWorkspace.shared.frontmostApplication {
            targets = [front]
        }
    case "app":
        if let appIdentifier, let app = findApp(appIdentifier) {
            targets = [app]
        }
    default:
        targets = runningApps(visibleOnly: true)
    }

    if targets.isEmpty {
        return []
    }

    let query = ElementQuery(
        text: text,
        roles: roles != nil ? Set(roles!) : nil,
        depth: max(1, depth),
        limit: max(1, limit)
    )

    var seen = Set<String>()
    var results: [[String: Any]] = []

    for app in targets {
        if results.count >= query.limit {
            break
        }

        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        let focusedElement = axElement(from: axGetAttribute(appElement, kAXFocusedUIElementAttribute as String))

        let windows: [AXUIElement]
        if scope == "top_window", let oneWindow = mainOrFrontWindow(appElement) {
            windows = [oneWindow]
        } else {
            windows = appWindows(appElement)
        }

        for window in windows {
            if results.count >= query.limit {
                break
            }

            if let minimized = axGetAttribute(window, kAXMinimizedAttribute as String) as? Bool, minimized {
                continue
            }

            walkTree(
                element: window,
                appName: appName(app),
                pid: pid,
                focusedElement: focusedElement,
                query: query,
                depth: 0,
                seen: &seen,
                results: &results
            )
        }

        if results.count >= query.limit {
            break
        }

        if let menuBar = axElement(from: axGetAttribute(appElement, kAXMenuBarAttribute as String)) {
            walkTree(
                element: menuBar,
                appName: appName(app),
                pid: pid,
                focusedElement: focusedElement,
                query: query,
                depth: 0,
                seen: &seen,
                results: &results
            )
        }
    }

    return results
}

func parsePIDFromElementID(_ id: String) -> String? {
    guard let first = id.split(separator: "-").first, !first.isEmpty else {
        return nil
    }
    let value = String(first)
    return Int32(value) != nil ? value : nil
}

func boundsFromElementInfo(_ info: [String: Any]) -> CGRect? {
    guard let bounds = info["bounds"] as? [Any], bounds.count == 4 else {
        return nil
    }

    let x = (bounds[0] as? NSNumber)?.doubleValue ?? 0
    let y = (bounds[1] as? NSNumber)?.doubleValue ?? 0
    let w = (bounds[2] as? NSNumber)?.doubleValue ?? 0
    let h = (bounds[3] as? NSNumber)?.doubleValue ?? 0

    guard w > 0, h > 0 else {
        return nil
    }

    return CGRect(x: x, y: y, width: w, height: h)
}

func coordinateClick(point: CGPoint, clickCount: Int = 1) -> Bool {
    let count = max(1, clickCount)
    for index in 0..<count {
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: point,
            mouseButton: .left
        ), let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            return false
        }

        down.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    return true
}

func coordinateClickCenter(bounds: CGRect) -> Bool {
    let point = CGPoint(x: bounds.midX, y: bounds.midY)
    return coordinateClick(point: point)
}

func scrollAt(x: Double, y: Double, direction: String, amount: Int) -> Bool {
    let steps = max(1, amount)
    let delta = Int32(direction.lowercased() == "up" ? steps : -steps)

    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 1,
        wheel1: delta,
        wheel2: 0,
        wheel3: 0
    ) else {
        return false
    }

    event.location = CGPoint(x: x, y: y)
    event.post(tap: .cghidEventTap)
    return true
}

func findElementHandleById(
    in element: AXUIElement,
    targetId: String,
    appName: String,
    pid: pid_t,
    focusedElement: AXUIElement?,
    maxDepth: Int,
    depth: Int = 0
) -> (element: AXUIElement, info: [String: Any])? {
    if depth > maxDepth {
        return nil
    }

    if let info = elementInfo(element: element, appName: appName, pid: pid, focusedElement: focusedElement),
       let candidateId = info["id"] as? String,
       candidateId == targetId {
        return (element, info)
    }

    let childCollections = [
        axGetAttribute(element, kAXChildrenAttribute as String) as? [AnyObject] ?? [],
        axGetAttribute(element, kAXVisibleChildrenAttribute as String) as? [AnyObject] ?? [],
    ]

    for collection in childCollections {
        for child in collection {
            guard CFGetTypeID(child) == AXUIElementGetTypeID() else {
                continue
            }
            if let found = findElementHandleById(
                in: child as! AXUIElement,
                targetId: targetId,
                appName: appName,
                pid: pid,
                focusedElement: focusedElement,
                maxDepth: maxDepth,
                depth: depth + 1
            ) {
                return found
            }
        }
    }

    return nil
}

func clickElementById(_ id: String, appIdentifier: String?) -> (Bool, [String: Any]) {
    let appCandidates: [NSRunningApplication]
    if let appIdentifier, let app = findApp(appIdentifier) {
        appCandidates = [app]
    } else if let pidString = parsePIDFromElementID(id), let app = findApp(pidString) {
        appCandidates = [app]
    } else {
        appCandidates = runningApps(visibleOnly: true)
    }

    for app in appCandidates {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        let focusedElement = axElement(from: axGetAttribute(appElement, kAXFocusedUIElementAttribute as String))
        let appLabel = appName(app)

        let windows = appWindows(appElement).filter { window in
            !((axGetAttribute(window, kAXMinimizedAttribute as String) as? Bool) ?? false)
        }

        for window in windows {
            if let found = findElementHandleById(
                in: window,
                targetId: id,
                appName: appLabel,
                pid: pid,
                focusedElement: focusedElement,
                maxDepth: 12
            ) {
                let actions = axGetActions(found.element)
                let preferred = ["AXPress", "AXConfirm", "AXOpen", "AXPick"]
                let selectedAction = preferred.first(where: { actions.contains($0) }) ?? actions.first

                if let selectedAction, axPerformAction(found.element, selectedAction) {
                    return (true, [
                        "id": id,
                        "action": selectedAction,
                        "method": "ax_action",
                        "element": found.info,
                    ])
                }

                if let bounds = boundsFromElementInfo(found.info), coordinateClickCenter(bounds: bounds) {
                    return (true, [
                        "id": id,
                        "action": selectedAction ?? "AXPress",
                        "method": "coordinate_click_fallback",
                        "element": found.info,
                    ])
                }

                return (false, [
                    "code": HelperCode.actionFailed.rawValue,
                    "message": "Failed to perform click action on element: \(id)",
                    "element": found.info,
                ])
            }
        }

        if let menuBar = axElement(from: axGetAttribute(appElement, kAXMenuBarAttribute as String)),
           let found = findElementHandleById(
                in: menuBar,
                targetId: id,
                appName: appLabel,
                pid: pid,
                focusedElement: focusedElement,
                maxDepth: 12
           ) {
            let actions = axGetActions(found.element)
            let preferred = ["AXPress", "AXConfirm", "AXOpen", "AXPick"]
            let selectedAction = preferred.first(where: { actions.contains($0) }) ?? actions.first

            if let selectedAction, axPerformAction(found.element, selectedAction) {
                return (true, [
                    "id": id,
                    "action": selectedAction,
                    "method": "ax_action",
                    "element": found.info,
                ])
            }

            if let bounds = boundsFromElementInfo(found.info), coordinateClickCenter(bounds: bounds) {
                return (true, [
                    "id": id,
                    "action": selectedAction ?? "AXPress",
                    "method": "coordinate_click_fallback",
                    "element": found.info,
                ])
            }

            return (false, [
                "code": HelperCode.actionFailed.rawValue,
                "message": "Failed to perform click action on element: \(id)",
                "element": found.info,
            ])
        }
    }

    return (false, ["code": HelperCode.notFound.rawValue, "message": "Element not found: \(id)"])
}

func typeText(_ text: String) -> Bool {
    for char in text {
        let needsShift: Bool
        let baseChar: Character

        if let mapped = shiftChars[char] {
            needsShift = true
            baseChar = mapped
        } else if char.isUppercase {
            needsShift = true
            baseChar = Character(char.lowercased())
        } else {
            needsShift = false
            baseChar = char
        }

        guard let keyCode = keyCodes[String(baseChar)] else {
            continue
        }

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            continue
        }

        if needsShift {
            down.flags = [.maskShift]
            up.flags = [.maskShift]
        }

        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)

        usleep(20_000)
    }

    return true
}

func pressKey(_ key: String, modifiers: [String]) -> Bool {
    let normalized = key.lowercased()
    guard let keyCode = keyCodes[normalized] else {
        return false
    }

    var flags: CGEventFlags = []
    for modifier in modifiers {
        if let mapped = modifierFlags[modifier.lowercased()] {
            flags.insert(mapped)
        }
    }

    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        return false
    }

    down.flags = flags
    up.flags = flags

    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)

    return true
}

func activateApp(_ identifier: String) -> [String: Any]? {
    guard let app = findApp(identifier) else {
        return nil
    }

    let ok = app.activate(options: [.activateIgnoringOtherApps])
    if ok {
        return [
            "success": true,
            "app": appName(app),
            "pid": Int(app.processIdentifier),
        ]
    }

    return [
        "success": false,
        "app": appName(app),
        "pid": Int(app.processIdentifier),
    ]
}

func waitForElement(appIdentifier: String, text: String, roles: [String]?, timeoutMs: Int, depth: Int) -> [String: Any]? {
    let start = Date()
    let timeoutInterval = TimeInterval(timeoutMs) / 1000.0

    while Date().timeIntervalSince(start) < timeoutInterval {
        let elements = collectElements(
            scope: "app",
            appIdentifier: appIdentifier,
            text: text,
            roles: roles,
            depth: depth,
            limit: 20
        )

        if let first = elements.first {
            return first
        }

        usleep(300_000)
    }

    return nil
}

func findElements(appIdentifier: String, text: String?, roles: [String]?, depth: Int, limit: Int, index: Int = 0) -> [[String: Any]] {
    let safeIndex = max(0, index)
    let requestedLimit = max(safeIndex + 1, max(1, limit))
    let elements = collectElements(
        scope: "app",
        appIdentifier: appIdentifier,
        text: text,
        roles: roles,
        depth: depth,
        limit: requestedLimit
    )

    if safeIndex > 0 {
        if safeIndex < elements.count {
            return [elements[safeIndex]]
        }
        return []
    }

    return elements
}

func parseObjectArray(_ any: Any?) -> [[String: Any]]? {
    if let objects = any as? [[String: Any]] {
        return objects
    }

    if let list = any as? [Any] {
        return list.compactMap { $0 as? [String: Any] }
    }

    return nil
}

func parseInt(_ any: Any?, default defaultValue: Int) -> Int {
    if let value = any as? NSNumber {
        return value.intValue
    }
    if let value = any as? Int {
        return value
    }
    if let value = any as? String, let intValue = Int(value) {
        return intValue
    }
    return defaultValue
}

func parseDouble(_ any: Any?) -> Double? {
    if let value = any as? NSNumber {
        return value.doubleValue
    }
    if let value = any as? Double {
        return value
    }
    if let value = any as? String, let doubleValue = Double(value) {
        return doubleValue
    }
    return nil
}

func parseBool(_ any: Any?, default defaultValue: Bool = false) -> Bool {
    if let value = any as? Bool {
        return value
    }
    if let value = any as? NSNumber {
        return value.intValue != 0
    }
    if let value = any as? String {
        let lower = value.lowercased()
        if ["1", "true", "yes"].contains(lower) { return true }
        if ["0", "false", "no"].contains(lower) { return false }
    }
    return defaultValue
}

func executeBatchCommand(_ cmd: [String: Any]) -> [String: Any] {
    let action = ((cmd["action"] as? String) ?? "").lowercased()

    switch action {
    case "wait":
        let ms = max(0, parseInt(cmd["ms"], default: 500))
        usleep(useconds_t(ms * 1000))
        return ["action": "wait", "success": true, "ms": ms]

    case "activate":
        guard let app = parseAppIdentifier(cmd["app"]) else {
            return ["action": "activate", "success": false, "error": "Missing app"]
        }
        guard let result = activateApp(app) else {
            return ["action": "activate", "success": false, "error": "No application found matching \(app)"]
        }
        if (result["success"] as? Bool) == true {
            var response = result
            response["action"] = "activate"
            return response
        }
        return ["action": "activate", "success": false, "error": "Failed to activate app"]

    case "find", "get_state":
        guard let app = parseAppIdentifier(cmd["app"]) else {
            return ["action": action, "success": false, "error": "Missing app"]
        }

        let text = (cmd["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedText = (text?.isEmpty == false) ? text : nil
        let roles = parseStringArray(cmd["roles"] ?? cmd["role"])
        if normalizedText == nil && (roles == nil || roles?.isEmpty == true) {
            return ["action": action, "success": false, "error": "Provide text or role"]
        }

        let depth = max(1, parseInt(cmd["depth"], default: 10))
        let index = max(0, parseInt(cmd["index"], default: 0))
        let limit = max(1, parseInt(cmd["limit"], default: index + 1))
        let elements = findElements(appIdentifier: app, text: normalizedText, roles: roles, depth: depth, limit: limit, index: index)

        guard let element = elements.first else {
            return ["action": action, "success": false, "error": "No matching element found"]
        }

        if action == "get_state" {
            var response: [String: Any] = [
                "action": "get_state",
                "success": true,
                "element": element,
            ]
            if let checked = element["checked"] {
                response["checked"] = checked
            }
            if let selected = element["selected"] {
                response["selected"] = selected
            }
            if let textValue = element["text"] {
                response["text"] = textValue
            }
            return response
        }

        return [
            "action": "find",
            "success": true,
            "element": element,
        ]

    case "click", "find_and_click":
        let ifExists = parseBool(cmd["if_exists"], default: false)
        let explicitID = cmd["id"] as? String
        let appHint = parseAppIdentifier(cmd["app"])
        var targetElement: [String: Any]? = nil
        var targetID = explicitID

        if targetID == nil {
            guard let app = appHint else {
                return ["action": action, "success": false, "error": "Must provide id or app"]
            }

            let text = (cmd["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalizedText = (text?.isEmpty == false) ? text : nil
            let roles = parseStringArray(cmd["roles"] ?? cmd["role"])
            if normalizedText == nil && (roles == nil || roles?.isEmpty == true) {
                return ["action": action, "success": false, "error": "Provide text or role"]
            }

            let depth = max(1, parseInt(cmd["depth"], default: 10))
            let index = max(0, parseInt(cmd["index"], default: 0))
            let limit = max(1, parseInt(cmd["limit"], default: index + 1))
            let matches = findElements(appIdentifier: app, text: normalizedText, roles: roles, depth: depth, limit: limit, index: index)
            targetElement = matches.first
            targetID = targetElement?["id"] as? String
        }

        guard let resolvedID = targetID else {
            if ifExists {
                return ["action": action, "success": true, "skipped": true]
            }
            return ["action": action, "success": false, "error": "No matching element found"]
        }

        let (clickedOK, payload) = clickElementById(resolvedID, appIdentifier: appHint)
        if clickedOK {
            var response = payload
            response["action"] = action
            response["success"] = true
            if let targetElement {
                response["element"] = targetElement
            }
            return response
        }

        let helperMessage = payload["message"] as? String ?? "Click failed"
        let helperCode = payload["code"] as? String
        if ifExists && helperCode == HelperCode.notFound.rawValue {
            return ["action": action, "success": true, "skipped": true]
        }

        var response: [String: Any] = ["action": action, "success": false, "error": helperMessage]
        if let targetElement {
            response["element"] = targetElement
        }
        return response

    case "type":
        let text = (cmd["text"] as? String) ?? ""
        let ok = typeText(text)
        return ok
            ? ["action": "type", "success": true, "text": text, "length": text.count]
            : ["action": "type", "success": false, "error": "Type failed"]

    case "key":
        guard let key = cmd["key"] as? String, !key.isEmpty else {
            return ["action": "key", "success": false, "error": "Missing key"]
        }
        let modifiers = parseStringArray(cmd["modifiers"]) ?? []
        let ok = pressKey(key, modifiers: modifiers)
        return ok
            ? ["action": "key", "success": true, "key": key, "modifiers": modifiers]
            : ["action": "key", "success": false, "error": "Failed to press key: \(key)"]

    case "wait_for":
        guard let app = parseAppIdentifier(cmd["app"]),
              let text = cmd["text"] as? String, !text.isEmpty else {
            return ["action": "wait_for", "success": false, "error": "Missing app or text"]
        }
        let roles = parseStringArray(cmd["roles"] ?? cmd["role"])
        let timeoutMs = max(1, parseInt(cmd["timeout_ms"], default: 5000))
        let depth = max(1, parseInt(cmd["depth"], default: 10))
        if let element = waitForElement(appIdentifier: app, text: text, roles: roles, timeoutMs: timeoutMs, depth: depth) {
            return ["action": "wait_for", "success": true, "element": element]
        }
        return ["action": "wait_for", "success": false, "error": "Timed out waiting for element"]

    case "scroll":
        guard let x = parseDouble(cmd["x"]), let y = parseDouble(cmd["y"]) else {
            return ["action": "scroll", "success": false, "error": "Missing x or y"]
        }
        let direction = ((cmd["direction"] as? String) ?? "down").lowercased()
        let amount = max(1, parseInt(cmd["amount"], default: 3))
        let ok = scrollAt(x: x, y: y, direction: direction, amount: amount)
        return ok
            ? ["action": "scroll", "success": true, "x": x, "y": y, "direction": direction, "amount": amount]
            : ["action": "scroll", "success": false, "error": "Failed to scroll"]

    default:
        return ["action": action.isEmpty ? "unknown" : action, "success": false, "error": "Unknown action: \(action)"]
    }
}

func runBatchCommands(_ commands: [[String: Any]], stopOnError: Bool) -> [String: Any] {
    var results: [[String: Any]] = []
    var failedAt: Int? = nil

    for (index, cmd) in commands.enumerated() {
        let result = executeBatchCommand(cmd)
        results.append(result)

        let success = (result["success"] as? Bool) ?? false
        let skipped = (result["skipped"] as? Bool) ?? false
        if !success && !skipped {
            failedAt = index
            if stopOnError {
                break
            }
        }
    }

    return [
        "success": failedAt == nil,
        "results": results,
        "failedAt": failedAt != nil ? failedAt! : NSNull(),
        "completed": results.count,
        "total": commands.count,
    ]
}

func parseRequest() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else {
        throw NSError(domain: "macos-ax-helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty request payload"]) 
    }

    let object = try JSONSerialization.jsonObject(with: data, options: [])
    guard let request = object as? [String: Any] else {
        throw NSError(domain: "macos-ax-helper", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON object request"]) 
    }

    return request
}

func parseStringArray(_ any: Any?) -> [String]? {
    if let list = any as? [String] {
        return list
    }
    if let anyList = any as? [Any] {
        return anyList.map { String(describing: $0) }
    }
    return nil
}

let startedAt = Date()

if !isMacOS() {
    errorResponse(code: .unsupportedPlatform, message: "macos-ax-helper supports only macOS", requestId: nil, startedAt: startedAt)
    exit(0)
}

do {
    let request = try parseRequest()
    let command = (request["command"] as? String) ?? ""
    let requestId = request["requestId"] as? String
    let args = request["args"] as? [String: Any] ?? [:]

    switch command {
    case "status":
        let hasPermission = accessibilityTrusted(prompt: false)
        successResponse(data: [
            "platform": "darwin",
            "hasPermission": hasPermission,
            "helperVersion": helperVersion,
            "processInfo": processInfoString(),
        ], requestId: requestId, startedAt: startedAt)

    case "list_apps":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        let apps = runningApps(visibleOnly: true).map { app in
            [
                "name": appName(app),
                "pid": Int(app.processIdentifier),
                "bundleId": app.bundleIdentifier ?? "",
                "active": app.isActive,
            ] as [String : Any]
        }

        successResponse(data: ["apps": apps], requestId: requestId, startedAt: startedAt)

    case "list_elements":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        let scope = (args["scope"] as? String) ?? "top_window"
        let appIdentifier = parseAppIdentifier(args["app"])
        let text = args["text"] as? String
        let roles = parseStringArray(args["roles"])
        let depth = (args["depth"] as? Int) ?? 10
        let limit = (args["limit"] as? Int) ?? 250

        if scope == "app" && appIdentifier == nil {
            errorResponse(code: .invalidArgument, message: "list_elements with scope=app requires args.app", requestId: requestId, startedAt: startedAt)
            break
        }

        let elements = collectElements(
            scope: scope,
            appIdentifier: appIdentifier,
            text: text,
            roles: roles,
            depth: depth,
            limit: limit
        )

        successResponse(data: ["elements": elements], requestId: requestId, startedAt: startedAt)

    case "find":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let app = parseAppIdentifier(args["app"]) else {
            errorResponse(code: .invalidArgument, message: "find requires args.app", requestId: requestId, startedAt: startedAt)
            break
        }

        let text = (args["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedText = (text?.isEmpty == false) ? text : nil
        let roles = parseStringArray(args["roles"] ?? args["role"])
        if normalizedText == nil && (roles == nil || roles?.isEmpty == true) {
            errorResponse(code: .invalidArgument, message: "find requires args.text or args.role(s)", requestId: requestId, startedAt: startedAt)
            break
        }
        let depth = parseInt(args["depth"], default: 10)
        let index = max(0, parseInt(args["index"], default: 0))
        let limit = max(1, parseInt(args["limit"], default: index + 1))
        let elements = findElements(appIdentifier: app, text: normalizedText, roles: roles, depth: depth, limit: limit, index: index)
        successResponse(data: ["elements": elements], requestId: requestId, startedAt: startedAt)

    case "click":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let id = args["id"] as? String, !id.isEmpty else {
            errorResponse(code: .invalidArgument, message: "click requires args.id", requestId: requestId, startedAt: startedAt)
            break
        }

        let appIdentifier = parseAppIdentifier(args["app"])
        let (ok, payload) = clickElementById(id, appIdentifier: appIdentifier)

        if ok {
            successResponse(data: payload, requestId: requestId, startedAt: startedAt)
        } else {
            let codeRaw = payload["code"] as? String ?? HelperCode.actionFailed.rawValue
            let code = HelperCode(rawValue: codeRaw) ?? .actionFailed
            let message = payload["message"] as? String ?? "click failed"
            errorResponse(code: code, message: message, details: payload, requestId: requestId, startedAt: startedAt)
        }

    case "type_text":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let text = args["text"] as? String else {
            errorResponse(code: .invalidArgument, message: "type_text requires args.text", requestId: requestId, startedAt: startedAt)
            break
        }

        let ok = typeText(text)
        if ok {
            successResponse(data: ["success": true, "text": text, "length": text.count], requestId: requestId, startedAt: startedAt)
        } else {
            errorResponse(code: .actionFailed, message: "Failed to type text", requestId: requestId, startedAt: startedAt)
        }

    case "press_key":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let key = args["key"] as? String, !key.isEmpty else {
            errorResponse(code: .invalidArgument, message: "press_key requires args.key", requestId: requestId, startedAt: startedAt)
            break
        }

        let modifiers = parseStringArray(args["modifiers"]) ?? []
        let ok = pressKey(key, modifiers: modifiers)

        if ok {
            successResponse(data: ["success": true, "key": key, "modifiers": modifiers], requestId: requestId, startedAt: startedAt)
        } else {
            errorResponse(code: .actionFailed, message: "Failed to press key: \(key)", requestId: requestId, startedAt: startedAt)
        }

    case "activate":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let app = parseAppIdentifier(args["app"]) else {
            errorResponse(code: .invalidArgument, message: "activate requires args.app", requestId: requestId, startedAt: startedAt)
            break
        }

        guard let result = activateApp(app) else {
            errorResponse(code: .notFound, message: "No application found matching \(app)", requestId: requestId, startedAt: startedAt)
            break
        }

        if (result["success"] as? Bool) == true {
            successResponse(data: result, requestId: requestId, startedAt: startedAt)
        } else {
            errorResponse(code: .actionFailed, message: "Failed to activate app", details: result, requestId: requestId, startedAt: startedAt)
        }

    case "wait_for":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let app = parseAppIdentifier(args["app"]),
              let text = args["text"] as? String, !text.isEmpty else {
            errorResponse(code: .invalidArgument, message: "wait_for requires args.app and args.text", requestId: requestId, startedAt: startedAt)
            break
        }

        let roles = parseStringArray(args["roles"])
        let timeoutMs = (args["timeout_ms"] as? Int) ?? 5000
        let depth = (args["depth"] as? Int) ?? 10

        if let element = waitForElement(appIdentifier: app, text: text, roles: roles, timeoutMs: timeoutMs, depth: depth) {
            successResponse(data: ["element": element], requestId: requestId, startedAt: startedAt)
        } else {
            errorResponse(code: .timeout, message: "Timed out waiting for element", details: ["app": app, "text": text, "timeout_ms": timeoutMs], requestId: requestId, startedAt: startedAt)
        }

    case "scroll":
        guard accessibilityTrusted(prompt: false) else {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        guard let x = parseDouble(args["x"]),
              let y = parseDouble(args["y"]) else {
            errorResponse(code: .invalidArgument, message: "scroll requires args.x and args.y", requestId: requestId, startedAt: startedAt)
            break
        }

        let direction = ((args["direction"] as? String) ?? "down").lowercased()
        let amount = max(1, parseInt(args["amount"], default: 3))
        if scrollAt(x: x, y: y, direction: direction, amount: amount) {
            successResponse(data: ["success": true, "x": x, "y": y, "direction": direction, "amount": amount], requestId: requestId, startedAt: startedAt)
        } else {
            errorResponse(code: .actionFailed, message: "Failed to scroll", requestId: requestId, startedAt: startedAt)
        }

    case "batch":
        guard let commands = parseObjectArray(args["commands"]) else {
            errorResponse(code: .invalidArgument, message: "batch requires args.commands (array of objects)", requestId: requestId, startedAt: startedAt)
            break
        }

        let stopOnError = parseBool(args["stop_on_error"], default: true)
        let requiresPermission = commands.contains { command in
            let action = ((command["action"] as? String) ?? "").lowercased()
            return action != "wait"
        }

        if requiresPermission && !accessibilityTrusted(prompt: false) {
            errorResponse(
                code: .permissionDenied,
                message: "Accessibility permissions not granted",
                details: ["processInfo": processInfoString()],
                requestId: requestId,
                startedAt: startedAt
            )
            break
        }

        let result = runBatchCommands(commands, stopOnError: stopOnError)
        successResponse(data: result, requestId: requestId, startedAt: startedAt)

    default:
        errorResponse(code: .invalidArgument, message: "Unknown command: \(command)", requestId: requestId, startedAt: startedAt)
    }
} catch {
    errorResponse(code: .internalError, message: "Unhandled helper error: \(error.localizedDescription)", requestId: nil, startedAt: startedAt)
}
