# @p2p/sdk-bridge

The contract between the bank's mobile app (host) and the embedded P2P web app. Types and the web-side
implementation are in `src/index.ts`; native SDKs implement the same protocol. In the prototype the native
SDKs are the stubs below and `apps/demo-host` plays the bank app in a browser.

## Flow

```
bank app                         web app (WebView)
   │  open WebView at the P2P URL
   │ ◀──────────────── ready {version}
   │  ask bank backend for a launch token (RS256 JWT, ≤60s, one-time)
   │ init {launchToken, locale, safeArea} ─▶  POST /v1/session
   │                                        …
   │ ◀──────────────── tokenExpired           (API answered 401)
   │ refreshToken {launchToken} ──────────▶  POST /v1/session, retry
   │ back ────────────────────────────────▶  close sheet / previous tab / close
   │ ◀──────────────── openBankScreen {screen: openFxAccount, params}
   │ ◀──────────────── analyticsEvent {name, props}
   │ ◀──────────────── close
```

Every message is wrapped as `{ "protocol": "p2pfx.bridge", "version": 1, "message": { "type": … } }`.
The web app sends it as an object to `window.webkit.messageHandlers.p2pfx` (iOS), as a JSON string to
`window.P2PFXAndroid.postMessage` (Android) or `window.ReactNativeWebView.postMessage` (React Native), and to
`window.parent` when it runs in an iframe. Hosts deliver messages by calling `window.__p2pfxReceive(json)`.

The launch token must come from the bank's backend; the bank app never holds the signing key.

## iOS (stub)

```swift
final class P2PExchange: NSObject, WKScriptMessageHandler {
  let webView: WKWebView
  let tokenProvider: () async throws -> String   // calls the bank backend

  init(url: URL, tokenProvider: @escaping () async throws -> String) {
    let config = WKWebViewConfiguration()
    webView = WKWebView(frame: .zero, configuration: config)
    self.tokenProvider = tokenProvider
    super.init()
    config.userContentController.add(self, name: "p2pfx")
    webView.load(URLRequest(url: url))
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let env = m.body as? [String: Any], let msg = env["message"] as? [String: Any],
          let type = msg["type"] as? String else { return }
    switch type {
    case "ready":        Task { send(["type": "init", "launchToken": try await tokenProvider(), "locale": "tr-TR"]) }
    case "tokenExpired": Task { send(["type": "refreshToken", "launchToken": try await tokenProvider()]) }
    case "close":        dismiss()
    case "openBankScreen", "analyticsEvent": route(msg)
    default: break
    }
  }

  func send(_ message: [String: Any]) {
    let env: [String: Any] = ["protocol": "p2pfx.bridge", "version": 1, "message": message]
    let json = String(data: try! JSONSerialization.data(withJSONObject: env), encoding: .utf8)!
    webView.evaluateJavaScript("window.__p2pfxReceive(\(json))")
  }
}
```

## Android (stub)

```kotlin
class P2PExchange(private val webView: WebView, private val tokens: suspend () -> String, private val scope: CoroutineScope) {
  init {
    webView.settings.javaScriptEnabled = true
    webView.addJavascriptInterface(object {
      @JavascriptInterface fun postMessage(json: String) = onMessage(JSONObject(json).getJSONObject("message"))
    }, "P2PFXAndroid")
  }

  private fun onMessage(msg: JSONObject) = when (msg.getString("type")) {
    "ready" -> scope.launch { send(JSONObject().put("type", "init").put("launchToken", tokens()).put("locale", "tr-TR")) }
    "tokenExpired" -> scope.launch { send(JSONObject().put("type", "refreshToken").put("launchToken", tokens())) }
    "close" -> close()
    else -> route(msg)  // openBankScreen, analyticsEvent
  }

  fun back() = send(JSONObject().put("type", "back"))  // from OnBackPressedCallback

  private fun send(message: JSONObject) {
    val env = JSONObject().put("protocol", "p2pfx.bridge").put("version", 1).put("message", message)
    webView.post { webView.evaluateJavascript("window.__p2pfxReceive($env)", null) }
  }
}
```

## React Native (stub)

```tsx
<WebView
  ref={ref}
  source={{ uri: P2P_URL }}
  onMessage={async (e) => {
    const m = unwrap<WebMessage>(e.nativeEvent.data);
    if (m?.type === 'ready') send({ type: 'init', launchToken: await getLaunchToken(), locale: 'tr-TR' });
    if (m?.type === 'tokenExpired') send({ type: 'refreshToken', launchToken: await getLaunchToken() });
    if (m?.type === 'close') navigation.goBack();
  }}
/>
// send = (m: HostMessage) => ref.current?.injectJavaScript(`window.__p2pfxReceive(${JSON.stringify(wrap(m))});true;`)
```
