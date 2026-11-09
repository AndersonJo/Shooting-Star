// shooting-star 네이티브 macOS 셸: 로컬 서버(node)를 띄우고 WKWebView 로 보여 준다.
// 자체 프로세스라서 Dock 에 shooting-star 아이콘/이름으로 표시된다. (install.sh 가 swiftc 로 빌드)
import Cocoa
import WebKit
import ImageIO

struct Config: Decodable {
    let node: String?     // dev 설치: 고정 경로. 없으면 실행 시점에 찾는다.
    let server: String?   // dev 설치: 저장소의 server.js. 없으면 앱 안에 번들된 서버를 쓴다.
    let port: Int
}

// 파일을 끌어다 놓을 때 웹 UI 에 실제 경로를 알려 준다 (웹의 File 객체에는 경로가 없다). 놓기 처리 자체는 그대로 웹이 한다.
// 반대로 갤러리 이미지를 끌어 나갈 때는 실제 파일로 끌어 준다 (Finder 에서 끄는 것과 같아서 Chrome 업로드 칸·Finder·다른 앱에 그대로 놓인다).
final class DropWebView: WKWebView {
    let fileDrag = FileDragSource()

    // 자기 창에 도로 놓으면 아무 일도 하지 않는다 (취소와 같음). 웹 UI 의 '놓으면 바로 보기' 안내도 띄우지 않는다.
    func isOwnDrag(_ s: NSDraggingInfo) -> Bool { s.draggingSource is FileDragSource }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if isOwnDrag(sender) { return [] }
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if let d = try? JSONSerialization.data(withJSONObject: urls.map { $0.path }), let j = String(data: d, encoding: .utf8) {
            evaluateJavaScript("window.ssDragPaths = \(j)", completionHandler: nil)
        }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { isOwnDrag(sender) ? [] : super.draggingUpdated(sender) }
    override func draggingExited(_ sender: NSDraggingInfo?) { if let s = sender, isOwnDrag(s) { return }; super.draggingExited(sender) }

    // 웹 UI 가 dragstart 를 막고 경로를 보내 오면 (버튼을 누른 채 끌고 있는 중) 그 자리에서 네이티브 끌기를 시작한다
    func dragFiles(_ paths: [String]) {
        guard NSEvent.pressedMouseButtons & 1 != 0, let w = window else { return }   // 메시지가 오기 전에 이미 놓았으면 끌지 않는다
        let urls = paths.map { URL(fileURLWithPath: $0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
        guard !urls.isEmpty else { return }
        let loc = w.mouseLocationOutsideOfEventStream, at = convert(loc, from: nil)
        let items = urls.enumerated().map { i, u -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: u as NSURL)
            let img = dragThumb(u.path), o = CGFloat(i) * 6
            item.setDraggingFrame(NSRect(x: at.x - img.size.width / 2 + o, y: at.y - img.size.height / 2 + o, width: img.size.width, height: img.size.height), contents: img)
            return item
        }
        guard let ev = NSEvent.mouseEvent(with: .leftMouseDragged, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
        fileDrag.view = self
        let s = beginDraggingSession(with: items, event: ev, source: fileDrag)
        s.animatesToStartingPositionsOnCancelOrFail = true
    }
    // 끌기가 끝나면 마우스 놓기는 끌기 세션이 가져가서 WebKit 은 버튼이 계속 눌린 줄 안다 → 놓기를 대신 알려 준다
    func releaseMouse() {
        guard let w = window, let ev = NSEvent.mouseEvent(with: .leftMouseUp, location: w.mouseLocationOutsideOfEventStream, modifierFlags: [],
                                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                                          context: nil, eventNumber: 0, clickCount: 1, pressure: 0) else { return }
        mouseUp(with: ev)
    }
}

// 끌기 미리보기: 축소본 (큰 이미지도 ImageIO 가 줄여서 디코딩해 빠르다). 못 읽는 형식이면 파일 아이콘.
func dragThumb(_ path: String, side: CGFloat = 160) -> NSImage {
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: side * 2]
    if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
       let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary), cg.width > 0, cg.height > 0 {
        let k = side / CGFloat(max(cg.width, cg.height))
        return NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) * k, height: CGFloat(cg.height) * k))
    }
    let ic = NSWorkspace.shared.icon(forFile: path); ic.size = NSSize(width: 64, height: 64); return ic
}

// 끌어 나가는 파일의 출처. 복사만 허용 (Finder 에 놓아도 원본이 옮겨지지 않는다), 앱 안으로는 허용하지 않는다.
// WKWebView 자체도 끌기 출처 메서드를 갖고 있어서 따로 둔다 (덮어쓰면 편집기의 글자 끌기 등이 깨진다).
final class FileDragSource: NSObject, NSDraggingSource {
    weak var view: DropWebView?
    func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : []
    }
    func draggingSession(_ s: NSDraggingSession, endedAt p: NSPoint, operation: NSDragOperation) { view?.releaseMouse() }
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
        conf.userContentController.add(self, name: "edit")         // 웹 UI 의 우클릭 메뉴: 잘라내기/복사/붙여넣기/전체 선택
        conf.userContentController.add(self, name: "dragFile")     // 갤러리 이미지를 실제 파일로 끌어 나가기 (경로 배열)
        let wv = DropWebView(frame: .zero, configuration: conf)
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
        if m.name == "dragFile" { (m.webView as? DropWebView)?.dragFiles(m.body as? [String] ?? []); return }
        if m.name == "edit", let cmd = m.body as? String {   // 편집 메뉴와 같은 명령을 보낸다 (붙여넣기는 웹 API 로는 권한 팝업이 뜬다)
            let sel: [String: Selector] = ["paste": #selector(NSText.paste(_:)), "copy": #selector(NSText.copy(_:)), "cut": #selector(NSText.cut(_:)), "selectAll": #selector(NSText.selectAll(_:))]
            if let s = sel[cmd] { NSApp.sendAction(s, to: nil, from: nil) }
            return
        }
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
