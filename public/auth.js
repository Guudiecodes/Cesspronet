/* CessproNet shared sign-in helper (no dependencies).
 * Include on any page with:  <script src="/auth.js"></script>
 *
 *  - Keeps the signed-in session in localStorage ("sx_session").
 *  - On pages that buy things, it adds the session token to createOrder / claimStockCode requests,
 *    and when the server answers "login_required" it sends the visitor to /signin.html and brings them
 *    back to the exact page (path, query and hash) afterwards.
 *  - Adds a small "Sign in" / "Account" link to the page header.
 * Icons are from Lucide (ISC licence), inlined.
 */
(function () {
  "use strict";
  var KEY = "sx_session", w = window, SX = (w.SX = w.SX || {});
  var BUY = { createOrder: 1, claimStockCode: 1, verifyPayment: 1 };

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function write(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) {} }
  function here() { return location.pathname + location.search + location.hash; }
  // Only same-site paths are allowed as a return address (no open redirects).
  function safeNext(n) { n = String(n || ""); return /^\/(?!\/)[^\s\\]*$/.test(n) && n.indexOf("/signin.html") !== 0 ? n : ""; }
  function signInUrl(next, mode) { return "/signin.html?next=" + encodeURIComponent(safeNext(next || here()) || "/") + (mode ? "&mode=" + mode : ""); }

  SX.session = read;
  SX.token = function () { var s = read(); return s && s.token || ""; };
  SX.user = function () { var s = read(); return s && s.user || null; };
  SX.isIn = function () { return !!SX.token(); };
  SX.save = function (token, user) { write({ token: token, user: user }); };
  SX.clear = function () { write(null); };
  SX.safeNext = safeNext;
  SX.signInUrl = signInUrl;
  SX.requireSignIn = function (role) {
    var u = SX.user();
    if (!SX.token() || (role && (!u || u.role !== role))) { location.replace(signInUrl(here())); return false; }
    return true;
  };
  SX.post = function (action, data) {
    return w.fetch("/api", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(Object.assign({ action: action }, data || {})) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: "network", message: "Cannot reach the server. Check your internet connection and try again." }; });
  };
  SX.signOut = function (goTo) {
    var t = SX.token(); SX.clear();
    var done = function () { location.href = goTo || "/"; };
    if (!t) return done();
    SX.post("signOut", { token: t }).then(done, done);
  };

  // ---- add the token to purchase requests and react to "login_required"
  var nativeFetch = w.fetch;
  if (nativeFetch && !nativeFetch.__sx) {
    var wrapped = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var isApi = /^(https?:\/\/[^/]+)?\/api\/?(\?|$)/.test(url) && (!/^https?:/.test(url) || url.indexOf(location.origin) === 0);
      var body = init && typeof init.body === "string" ? init.body : null, action = "";
      if (isApi && body) {
        try {
          var o = JSON.parse(body); action = String(o.action || "");
          if (BUY[action] && !o.token && SX.token()) { o.token = SX.token(); init = Object.assign({}, init, { body: JSON.stringify(o) }); }
        } catch (e) {}
      }
      var p = nativeFetch.call(w, input, init);
      if (isApi && BUY[action]) {
        p.then(function (res) {
          res.clone().json().then(function (j) {
            if (j && j.error === "login_required") { SX.clear(); location.href = signInUrl(here()); }
          }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
    wrapped.__sx = true;
    w.fetch = wrapped;
  }

  // ---- header link
  var ICON_USER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  function chip() {
    if (document.querySelector("[data-sx-chip]") || /^\/(signin|account|admin)\.html/.test(location.pathname)) return;
    var u = SX.user(), host = document.querySelector("[data-sx-account]") || document.querySelector("header nav") || document.querySelector("nav");
    if (!host && location.pathname === "/buy-code.html") {      // this page has no header: add a slim bar
      host = document.createElement("div"); host.style.cssText = "display:flex;justify-content:flex-end;padding:8px 12px;max-width:560px;margin:0 auto";
      document.body.insertBefore(host, document.body.firstChild);
    }
    if (!host) return;
    var a = document.createElement("a");
    a.setAttribute("data-sx-chip", "1"); a.className = "sx-acct";
    a.href = u ? (u.role === "admin" ? "/admin.html" : "/account.html") : signInUrl("/account.html");
    a.innerHTML = ICON_USER + "<span>" + (u ? (u.role === "admin" ? "Admin" : "My account") : "Sign in") + "</span>";
    host.appendChild(a);
  }
  if (!document.querySelector('link[href$="account.css"]')) {
    var st = document.createElement("style");
    st.textContent = ".sx-acct{display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none;padding:8px 12px;border-radius:10px;font-weight:600}.sx-acct:hover{background:rgba(255,255,255,.08)}.sx-acct svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}";
    document.head.appendChild(st);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", chip); else chip();
})();
