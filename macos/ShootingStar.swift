// shooting-star 네이티브 macOS 셸: 로컬 서버(node)를 띄우고 WKWebView 로 보여 준다.
// 자체 프로세스라서 Dock 에 shooting-star 아이콘/이름으로 표시된다. (install.sh 가 swiftc 로 빌드)
import Cocoa
import WebKit

struct Config: Decodable {
    let node: String?     // dev 설치: 고정 경로. 없으면 실행 시점에 찾는다.
    let server: String?   // dev 설치: 저장소의 server.js. 없으면 앱 안에 번들된 서버를 쓴다.
    let port: Int
}

func loadConfig() -> Config {
    let url = Bundle.main.resourceURL!.appendingPathComponent("config.json")
    return try! JSONDecoder().decode(Config.self, from: try! Data(contentsOf: url))
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    let cfg = loadConfig()
    var ready = false                 // 서버가 떠서 창을 열 수 있는 상태
    var pending: [URL] = []           // 서버 준비 전에 요청된 URL
    var windows: [NSWindow] = []
    var titleObservers: [NSKeyValueObservation] = []
    let dirtyJS = "typeof state !== 'undefined' && state.tabs.some(dirty)"

    var activePort: Int?   // 서버가 실제로 쓰는 포트 (선호 포트가 다른 프로그램에 쓰이면 서버가 다른 포트를 고른다)
    var base: String { "http://127.0.0.1:\(activePort ?? cfg.port)" }

    // 로컬 서버 주소만 허용 (선호 포트부터 20개 범위)
    func isLocal(_ u: URL) -> Bool {
        guard u.host == "127.0.0.1" || u.host == "localhost", let p = u.port else { return false }
        return (cfg.port...(cfg.port + 20)).contains(p)
    }

    var stateDir: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".shooting-star") }
    func readServerPort() -> Int? {
        guard let d = try? Data(contentsOf: stateDir.appendingPathComponent("server.json")),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return j["port"] as? Int
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

    // Node 실행 파일 찾기: 설정값 → Homebrew → 시스템 → nvm/volta/asdf. (GUI 앱은 셸 PATH 를 못 받는다)
    func findNode() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var c: [String] = []
        if let n = cfg.node { c.append(n) }
        c += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "\(home)/.volta/bin/node", "\(home)/.asdf/shims/node"]
        let nvm = "\(home)/.nvm/versions/node"
        if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            for v in vs.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) { c.append("\(nvm)/\(v)/bin/node") }
        }
        return c.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    var serverPath: String { cfg.server ?? Bundle.main.resourceURL!.appendingPathComponent("app/server.js").path }

    func alertNodeMissing() {
        let a = NSAlert()
        a.messageText = "Node.js 가 필요합니다"
        a.informativeText = "shooting-star 는 Node.js 18 이상으로 동작합니다.\n터미널에서 `brew install node` 를 실행하거나 nodejs.org 에서 설치한 뒤 다시 열어 주세요."
        a.addButton(withTitle: "nodejs.org 열기"); a.addButton(withTitle: "닫기")
        if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!) }
    }

    // 서버가 없으면 백그라운드로 띄운다 (server.js 의 기본 동작: 이미 있으면 재사용하고 바로 종료)
    func ensureServer() {
        guard let node = findNode() else {
            DispatchQueue.main.async { self.alertNodeMissing(); NSApp.terminate(nil) }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [serverPath, "--no-open", "--port", String(cfg.port)]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let err = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = err
        try? p.run()
        p.waitUntilExit()
        activePort = readServerPort() ?? (p.terminationStatus == 0 ? cfg.port : nil)   // 상태 파일이 없는 이전 버전 서버는 선호 포트
        if p.terminationStatus != 0 || activePort == nil {   // 서버가 안 떴으면 이유를 알려 준다 (다른 프로그램의 화면이 열리는 것을 막는다)
            let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                let a = NSAlert()
                a.messageText = "서버를 시작하지 못했습니다"
                a.informativeText = (msg.isEmpty ? "" : msg + "\n") + "로그: ~/.shooting-star/server.log\n터미널에서 `ss --status` 로 상태를 확인할 수 있습니다."
                a.runModal(); NSApp.terminate(nil)
            }
        }
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && ready { open(URL(string: base + "/")!) }   // Dock 아이콘 클릭 등
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // MARK: 창
    func open(_ url: URL) {
        let conf = WKWebViewConfiguration()
        conf.userContentController.add(self, name: "theme")        // 웹 UI 의 테마 변경 알림
        conf.userContentController.add(self, name: "fullscreen")   // 이미지 뷰어의 전체화면 요청
        let wv = WKWebView(frame: .zero, configuration: conf)
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
        win.collectionBehavior.insert(.fullScreenPrimary)   // 창 전체화면 허용
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

    // MARK: 테마 — 웹이 "dark|light,#rrggbb" 를 보내면 창의 밝기와 배경색을 맞춘다 (제목 표시줄/깜빡임 방지)
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "fullscreen" { (m.webView?.window)?.toggleFullScreen(nil); return }   // 이미지 뷰어: 창 전체화면 토글
        guard m.name == "theme", let s = m.body as? String else { return }
        let parts = s.split(separator: ",").map(String.init)
        guard parts.count == 2 else { return }
        let appearance = NSAppearance(named: parts[0] == "light" ? .aqua : .darkAqua)
        let hex = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        var rgb: UInt64 = 0
        guard hex.count == 6, Scanner(string: hex).scanHexInt64(&rgb) else { return }
        let color = NSColor(srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
        for w in windows { w.appearance = appearance; w.backgroundColor = color }
    }

    // 전체화면 상태를 웹 UI 에 알린다 (창 버튼/⌃⌘F 로 바뀌는 경우도 동기화)
    func notifyFullscreen(_ n: Notification, _ on: Bool) {
        ((n.object as? NSWindow)?.contentView as? WKWebView)?.evaluateJavaScript("window.onNativeFullscreen && window.onNativeFullscreen(\(on))", completionHandler: nil)
    }
    // 다른 앱을 쓰다 돌아오면(앱 활성화 / 창이 key 가 될 때) 웹 UI 가 파일을 다시 읽도록 알린다.
    // WKWebView 는 앱 전환 시 window 'focus' 이벤트를 안정적으로 주지 않는다.
    func notifyActivated(_ w: NSWindow?) {
        (w?.contentView as? WKWebView)?.evaluateJavaScript("window.onNativeActivate && window.onNativeActivate()", completionHandler: nil)
    }
    func applicationDidBecomeActive(_ n: Notification) { notifyActivated(NSApp.keyWindow) }
    func windowDidBecomeKey(_ n: Notification) { notifyActivated(n.object as? NSWindow) }
    func windowDidEnterFullScreen(_ n: Notification) { notifyFullscreen(n, true) }
    func windowDidExitFullScreen(_ n: Notification) { notifyFullscreen(n, false) }

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
        // 경로가 잘려 보이지 않도록 기본 텍스트 길이에 맞춰 입력창을 넓힘 (420 ~ 900pt)
        let w = min(900, max(420, CGFloat((defaultText ?? "").count) * 8 + 40))
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: w, height: 24))
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
            mi("전체 화면", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
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
