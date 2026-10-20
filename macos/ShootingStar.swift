// shooting-star 네이티브 macOS 셸: 로컬 서버(node)를 띄우고 WKWebView 로 보여 준다.
// 자체 프로세스라서 Dock 에 shooting-star 아이콘/이름으로 표시된다. (install.sh 가 swiftc 로 빌드)
import Cocoa
import WebKit

struct Config: Decodable {
    let node: String
    let server: String
    let port: Int
}

func loadConfig() -> Config {
    let url = Bundle.main.resourceURL!.appendingPathComponent("config.json")
    return try! JSONDecoder().decode(Config.self, from: try! Data(contentsOf: url))
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate {
    let cfg = loadConfig()
    var ready = false                 // 서버가 떠서 창을 열 수 있는 상태
    var pending: [URL] = []           // 서버 준비 전에 요청된 URL
    var windows: [NSWindow] = []
    var titleObservers: [NSKeyValueObservation] = []
    let dirtyJS = "typeof state !== 'undefined' && state.tabs.some(dirty)"

    var base: String { "http://127.0.0.1:\(cfg.port)" }

    func isLocal(_ u: URL) -> Bool {
        (u.host == "127.0.0.1" || u.host == "localhost") && u.port == cfg.port
    }

    // MARK: 시작 / URL 스킴 (shooting-star://open?url=<http url>)
    func applicationWillFinishLaunching(_ n: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handleURL(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let comps = URLComponents(string: s),
              let t = comps.queryItems?.first(where: { $0.name == "url" })?.value,
              let target = URL(string: t), isLocal(target) else { return }   // 로컬 서버 주소만 허용
        if ready { open(target) } else { pending.append(target) }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.global().async {
            self.ensureServer()
            DispatchQueue.main.async {
                self.ready = true
                let urls = self.pending.isEmpty ? [URL(string: self.base + "/")!] : self.pending
                self.pending = []
                urls.forEach { self.open($0) }
            }
        }
    }

    // 서버가 없으면 백그라운드로 띄운다 (server.js 의 기본 동작: 이미 있으면 재사용하고 바로 종료)
    func ensureServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cfg.node)
        p.arguments = [cfg.server, "--no-open", "--port", String(cfg.port)]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && ready { open(URL(string: base + "/")!) }   // Dock 아이콘 클릭 등
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // MARK: 창
    func open(_ url: URL) {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.uiDelegate = self
        wv.navigationDelegate = self
        wv.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { wv.isInspectable = true }

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.contentView = wv
        win.title = "shooting-star"
        win.backgroundColor = NSColor(srgbRed: 0.078, green: 0.086, blue: 0.102, alpha: 1)
        win.appearance = NSAppearance(named: .darkAqua)
        win.isReleasedWhenClosed = false
        win.tabbingMode = .disallowed
        win.delegate = self
        if let last = windows.last {     // 두 번째 창부터는 살짝 어긋나게
            win.setContentSize(last.contentLayoutRect.size)
            win.setFrameOrigin(NSPoint(x: last.frame.origin.x + 28, y: last.frame.origin.y - 28))
        } else {
            win.center()
            win.setFrameAutosaveName("shooting-star-main")   // 마지막 창 크기/위치 기억
        }
        titleObservers.append(wv.observe(\.title) { [weak win] w, _ in
            if let t = w.title, !t.isEmpty { win?.title = t }
        })
        windows.append(win)
        wv.load(URLRequest(url: url))
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ n: Notification) {
        if let w = n.object as? NSWindow { windows.removeAll { $0 === w } }
    }

    // 저장하지 않은 탭이 있으면 닫기 전에 확인
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let wv = sender.contentView as? WKWebView else { return true }
        wv.evaluateJavaScript(dirtyJS) { r, _ in
            if (r as? Bool) != true || self.confirmDiscard() { sender.close() }
        }
        return false
    }
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        let wvs = windows.compactMap { $0.contentView as? WKWebView }
        if wvs.isEmpty { return .terminateNow }
        let group = DispatchGroup(); var anyDirty = false
        for wv in wvs {
            group.enter()
            wv.evaluateJavaScript(dirtyJS) { r, _ in if (r as? Bool) == true { anyDirty = true }; group.leave() }
        }
        group.notify(queue: .main) { NSApp.reply(toApplicationShouldTerminate: !anyDirty || self.confirmDiscard()) }
        return .terminateLater
    }
    func confirmDiscard() -> Bool {
        let a = NSAlert()
        a.messageText = "저장하지 않은 변경이 있습니다"
        a.informativeText = "그래도 닫을까요?"
        a.addButton(withTitle: "닫기"); a.addButton(withTitle: "취소")
        return a.runModal() == .alertFirstButtonReturn
    }

    // MARK: WKUIDelegate — alert / confirm / prompt (웹 UI 가 confirm(), prompt() 를 쓴다)
    func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }
    func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ wv: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")
        a.window.initialFirstResponder = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
    // target=_blank / window.open → 기본 브라우저
    func webView(_ wv: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    // 로컬 서버 밖으로 나가는 이동은 기본 브라우저로
    func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, action.targetFrame?.isMainFrame ?? true,
           u.scheme == "http" || u.scheme == "https", !isLocal(u) {
            NSWorkspace.shared.open(u); decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    // MARK: 메뉴 — ⌘C/V/Z 등 표준 편집 단축키용. ⌘S/P/O/B/E/W/,/+/-/0 는 웹 UI 가 처리하므로 메뉴에 두지 않는다 (⌘+/-/0 은 본문 글자만 바뀐다).
    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(); main.addItem(item)
            let m = NSMenu(title: title); items.forEach { m.addItem($0) }; item.submenu = m
        }
        func mi(_ t: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: sel, keyEquivalent: key); i.keyEquivalentModifierMask = mods; return i
        }
        add("shooting-star", [
            mi("shooting-star 정보", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            mi("shooting-star 숨기기", #selector(NSApplication.hide(_:)), "h"),
            mi("다른 앱 숨기기", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            mi("shooting-star 종료", #selector(NSApplication.terminate(_:)), "q"),
        ])
        add("편집", [
            mi("실행 취소", Selector(("undo:")), "z"),
            mi("다시 실행", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            mi("오려두기", #selector(NSText.cut(_:)), "x"),
            mi("복사하기", #selector(NSText.copy(_:)), "c"),
            mi("붙여넣기", #selector(NSText.paste(_:)), "v"),
            mi("전체 선택", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("보기", [
            mi("새로고침", #selector(reloadPage), "r"),
        ])
        add("윈도우", [
            mi("최소화", #selector(NSWindow.performMiniaturize(_:)), "m"),
            mi("확대/축소", #selector(NSWindow.performZoom(_:))),
            mi("윈도우 닫기", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]),
        ])
        NSApp.mainMenu = main
    }
    var keyWV: WKWebView? { NSApp.keyWindow?.contentView as? WKWebView }
    @objc func reloadPage() { keyWV?.reload() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
