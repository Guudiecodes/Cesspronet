/**
 * Router management for the admin panel (CessproNet / CessproNet WiFi).
 * Kept in its own module so it can be added without touching the proven sync code in worker.js.
 *
 * Admin API (token-checked by worker.js before it gets here):
 *   adminRouterInfo    -> live status, checks, settings, ready-to-paste install command
 *   adminRouterSave    -> save router settings (interfaces, PCQ, sync interval, walled-garden hosts)
 *   adminRouterAction  -> op: test | refresh_portal | clear_log
 * Router API:
 *   GET /router/setup?token=ROUTER_TOKEN   installer script generated from the saved settings
 */

const CORS = { "Access-Control-Allow-Origin": "*" };
const jres = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", ...CORS } });
const fail = (error, message) => jres({ ok: false, error, message });
const nowIso = () => new Date().toISOString();

const DEFAULT_CFG = { wan_if: "ether1", lan_if: "wlan1", pcq: true, interval: 25, walled: [] };
const IF_RE = /^[A-Za-z0-9._-]{1,24}$/;
const HOST_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const BASE_WALLED = ["js.paystack.co", "api.paystack.co", "checkout.flutterwave.com", "api.flutterwave.com", "wa.me"];

const getState = async (db, key) => { const r = await db.prepare("SELECT value FROM router_state WHERE key=?1").bind(key).first(); return r ? r.value : null; };
const putState = (db, key, value) => db.prepare("INSERT INTO router_state(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2").bind(key, value).run();
const delState = (db, key) => db.prepare("DELETE FROM router_state WHERE key=?1").bind(key).run();
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const audit = (db, who, action, detail) => db.prepare("INSERT INTO audit(at,who,action,detail) VALUES(?1,?2,?3,?4)").bind(nowIso(), who, action, String(detail || "").slice(0, 400)).run();
const origin = (env) => String(env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const tokenOk = (env) => !!(env.ROUTER_TOKEN && env.ROUTER_TOKEN.length >= 16 && !env.ROUTER_TOKEN.startsWith("AKfy"));

async function loadCfg(db) {
  const c = parse(await getState(db, "router_cfg"), {});
  return {
    wan_if: IF_RE.test(c.wan_if || "") ? c.wan_if : DEFAULT_CFG.wan_if,
    lan_if: IF_RE.test(c.lan_if || "") ? c.lan_if : DEFAULT_CFG.lan_if,
    pcq: c.pcq === undefined ? DEFAULT_CFG.pcq : !!c.pcq,
    interval: Number.isFinite(+c.interval) && +c.interval >= 15 && +c.interval <= 120 ? Math.round(+c.interval) : DEFAULT_CFG.interval,
    walled: Array.isArray(c.walled) ? c.walled.filter(h => HOST_RE.test(h)).slice(0, 30) : []
  };
}

// ---------------------------------------------------------------- installer script
export function buildSetupRsc(env, cfg) {
  const api = origin(env) || "https://cesspro-wifi.cesspronet-wifi.workers.dev";
  const host = new URL(api).host;
  const walled = [host, ...BASE_WALLED, ...cfg.walled.filter(h => h !== host && !BASE_WALLED.includes(h))];
  const rsc = [
          "# CessproNet clean-slate installer v3 - generated " + nowIso(),
          "# 1) remove every trace of old + broken sornix/sx objects",
          '/system scheduler remove [find where on-event~"sornix"]',
          '/system scheduler remove [find where name="sx-sync"]',
          '/system script remove [find where name="sornix"]',
          '/system script remove [find where name="sx-config"]',
          '/system script remove [find where name="sx-sync"]',
          '/ip hotspot walled-garden remove [find where comment="sx"]',
          ':foreach f in={sxboot.rsc;sxcmd.rsc;sxrep.txt;sx-sync.rsc;sx-sync-new.rsc;t1.txt;t2.txt;t3.txt;t4.txt;t5.txt;t6.txt;hotspot/t6.html;flash/hotspot/login.html;flash/hotspot/alogin.html;flash/hotspot/error.html;flash/hotspot/logout.html;flash/hotspot/redirect.html;flash/hotspot/status.html;flash/hotspot/sx.css} do={ /file remove [find where name=$f] }',
          "# 2) globals",
          ':global sxApi "' + api + '"',
          ':global sxTok "' + env.ROUTER_TOKEN + '"',
          ':global sxTick 0',
          ':global sxBusy "0"',
          ':global sxBusyTick 0',
          "# 3) sx-config script",
          '/system script add name="sx-config" source=":global sxApi \\"' + api + '\\"\\n:global sxTok \\"' + env.ROUTER_TOKEN + '\\"\\n:global sxTick 0\\n:global sxBusy \\"0\\"\\n:global sxBusyTick 0"',
          "# 4) fresh sync script (v7 fetch semantics)",
          ':do { /tool fetch url="' + api + '/router/files/sx-sync.rsc?token=' + env.ROUTER_TOKEN + '" dst-path="sx-sync-new.rsc" as-value; :log info "sx-bootstrap: got sx-sync" } on-error={ :log error "sx-bootstrap: FAILED sx-sync.rsc" }',
          '/system script add name="sx-sync" source=[/file get [find where name="sx-sync-new.rsc"] contents]',
          "# 5) scheduler",
          '/system scheduler add name="sx-sync" interval=' + cfg.interval + 's start-time=startup on-event="/system script run sx-config\\n/system script run sx-sync"',
          "# 6) walled garden (deduped)",
          ...walled.map(h => '/ip hotspot walled-garden add dst-host="' + h + '" comment="sx"'),
          "# 7) captive-portal pages (literal lines, no loops)",
          ':do { /tool fetch url="' + api + '/router/files/login.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/login.html" as-value; :log info "sx-bootstrap: got login.html" } on-error={ :log error "sx-bootstrap: FAILED login.html" }',
          ':do { /tool fetch url="' + api + '/router/files/alogin.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/alogin.html" as-value; :log info "sx-bootstrap: got alogin.html" } on-error={ :log error "sx-bootstrap: FAILED alogin.html" }',
          ':do { /tool fetch url="' + api + '/router/files/error.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/error.html" as-value; :log info "sx-bootstrap: got error.html" } on-error={ :log error "sx-bootstrap: FAILED error.html" }',
          ':do { /tool fetch url="' + api + '/router/files/logout.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/logout.html" as-value; :log info "sx-bootstrap: got logout.html" } on-error={ :log error "sx-bootstrap: FAILED logout.html" }',
          ':do { /tool fetch url="' + api + '/router/files/redirect.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/redirect.html" as-value; :log info "sx-bootstrap: got redirect.html" } on-error={ :log error "sx-bootstrap: FAILED redirect.html" }',
          ':do { /tool fetch url="' + api + '/router/files/status.html?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/status.html" as-value; :log info "sx-bootstrap: got status.html" } on-error={ :log error "sx-bootstrap: FAILED status.html" }',
          ':do { /tool fetch url="' + api + '/router/files/sx.css?token=' + env.ROUTER_TOKEN + '" dst-path="flash/hotspot/sx.css" as-value; :log info "sx-bootstrap: got sx.css" } on-error={ :log error "sx-bootstrap: FAILED sx.css" }',
          ...(cfg.pcq ? [
            "# 7b) PCQ per-address fairness (heavy users cannot hog a congested link;",
            "#     per-user speed caps still come from the hotspot profiles)",
            ':do { /queue type add name=sx-pcq-down kind=pcq pcq-classifier=dst-address } on-error={ }',
            ':do { /queue type add name=sx-pcq-up kind=pcq pcq-classifier=src-address } on-error={ }',
            ':do { /queue tree add parent=' + cfg.lan_if + ' name=sx-fair-down queue=sx-pcq-down } on-error={ }',
            ':do { /queue tree add parent=' + cfg.wan_if + ' name=sx-fair-up queue=sx-pcq-up } on-error={ }'
          ] : [
            "# 7b) PCQ fairness disabled in admin > Router setup"
          ]),
          "# 8) first run",
          "/system script run sx-config",
          "/system script run sx-sync",
          ':log info "sx-bootstrap: done"',
          ""
  ].join("\n");
  return rsc;
}

export async function routerSetup(env, url) {
  const tok = url.searchParams.get("token") || "";
  const bad = !env.ROUTER_TOKEN || tok.length !== env.ROUTER_TOKEN.length || tok !== env.ROUTER_TOKEN;
  if (bad) return new Response("# bad or missing router token - the token in this URL must match the ROUTER_TOKEN secret on the Worker\n", { status: 403, headers: { "Content-Type": "text/plain" } });
  const cfg = await loadCfg(env.DB);
  return new Response(buildSetupRsc(env, cfg), { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", ...CORS } });
}

// ---------------------------------------------------------------- status
const DIAG_HINTS = [
  [/^ERR-selfupdate-fetch/, "The router could not download the newer sync script from the Worker."],
  [/^ERR-selfupdate/, "The router could not install the newer sync script."],
  [/^ERR-page-/, "A login page could not be downloaded to the router (check internet/DNS on the router)."],
  [/^ERR-uadd-/, "A customer account could not be created on the router (check the hotspot is set up and the licence level allows enough users)."],
  [/^ERR-/, "A router command failed."]
];
const hint = (m) => { for (const [re, t] of DIAG_HINTS) if (re.test(m)) return t; return ""; };

async function expectedSyncVersion(env) {
  try {
    const r = await env.ASSETS.fetch(new Request("https://assets.internal/mikrotik/sx-sync.rsc"));
    if (!r.ok) return null;
    const m = (await r.text()).match(/"S (\d+)\\n"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function info(env) {
  const db = env.DB;
  const cfg = await loadCfg(db);
  const lastSeen = +(await getState(db, "last_seen")) || 0;
  const ageSec = lastSeen ? Math.max(0, Math.round((Date.now() - lastSeen) / 1000)) : null;
  const online = ageSec != null && ageSec < 180;
  const sxver = await getState(db, "sxver");
  const expected = await expectedSyncVersion(env);
  const diag = parse(await getState(db, "rdiag"), []);
  const counts = parse(await getState(db, "counts"), null);
  const wifi = parse(await getState(db, "wifi_info"), null);
  const sessions = parse(await getState(db, "active_sessions"), []);
  const pending = parse(await getState(db, "pending_cmds"), []);
  const portalGen = await getState(db, "portal_gen");
  const test = parse(await getState(db, "router_test"), null);
  const errs = diag.filter(d => /^ERR-/.test(d.m)).slice(-6).map(d => ({ at: d.at, m: d.m, hint: hint(d.m) }));
  const tOk = tokenOk(env);
  const base = origin(env);
  const cmd = tOk && base ? '/tool fetch url="' + base + "/router/setup?token=" + env.ROUTER_TOKEN + '" dst-path=sxboot.rsc; /import file-name=sxboot.rsc' : "";
  const checks = [
    { id: "token", ok: tOk, title: "Router token is set on the Worker", fix: "In PowerShell run: npx wrangler secret put ROUTER_TOKEN (paste 32+ random characters), then npx wrangler deploy." },
    { id: "origin", ok: /^https:\/\//.test(base), title: "Public address is configured", fix: "Set PUBLIC_ORIGIN in wrangler.toml to your https Worker address, then deploy." },
    { id: "contact", ok: !!lastSeen, title: "Router has contacted this server", fix: "Run the install command (Step 1) in the router terminal." },
    { id: "live", ok: online, title: "Router is syncing right now", note: ageSec != null ? "last sync " + ageSec + " s ago" : "", fix: "The router has not synced for over 3 minutes. Check its internet, the date/time, and that the sx-sync scheduler is enabled." },
    { id: "ver", ok: !!lastSeen && (!expected || sxver === expected), title: "Sync script is up to date", note: sxver ? "router v" + sxver + (expected ? " / server v" + expected : "") : "", fix: "It updates itself on the next sync. If it stays old, run the install command again." },
    { id: "portal", ok: !!portalGen, title: "Login pages are on the router", note: portalGen ? "generation " + portalGen : "", fix: "Use Tools > Re-send login pages." },
    { id: "errs", ok: errs.length === 0, title: "No router-side errors reported", fix: "See the error list below." }
  ];
  return {
    ok: true, token_ok: tOk, origin: base, cfg, online, age_sec: ageSec, last_seen: lastSeen ? new Date(lastSeen).toISOString() : null,
    router: await getState(db, "version"), sxver, expected_sxver: expected, sxtick: await getState(db, "sxtick"),
    counts, wifi, sessions: sessions.length, pending: pending.length, portal_gen: portalGen, errors: errs,
    diag: diag.slice(-25).reverse(), checks, install_cmd: cmd, token_masked: tOk ? env.ROUTER_TOKEN.slice(0, 4) + "…" + env.ROUTER_TOKEN.slice(-4) : "",
    test, base_walled: [host0(base), ...BASE_WALLED]
  };
}
const host0 = (b) => { try { return new URL(b).host; } catch { return ""; } };

// ---------------------------------------------------------------- actions
async function save(env, b, who) {
  const c = b.cfg || {};
  const wan = String(c.wan_if || "").trim(), lan = String(c.lan_if || "").trim();
  if (!IF_RE.test(wan)) return fail("invalid_interface", "Internet (WAN) interface name is not valid. Use the exact name from the router, for example ether1.");
  if (!IF_RE.test(lan)) return fail("invalid_interface", "WiFi/hotspot interface name is not valid. Use the exact name from the router, for example wlan1 or bridge1.");
  const interval = Math.round(Number(c.interval));
  if (!(interval >= 15 && interval <= 120)) return fail("invalid_interval", "Sync interval must be between 15 and 120 seconds.");
  const walled = [...new Set(String(Array.isArray(c.walled) ? c.walled.join("\n") : c.walled || "").split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
  const badHost = walled.find(h => !HOST_RE.test(h));
  if (badHost) return fail("invalid_host", "“" + badHost + "” is not a valid website address. Use names like cdn.example.com (no https://, no path).");
  if (walled.length > 30) return fail("invalid_host", "Too many extra walled-garden hosts (maximum 30).");
  await putState(env.DB, "router_cfg", JSON.stringify({ wan_if: wan, lan_if: lan, pcq: !!c.pcq, interval, walled }));
  await audit(env.DB, who, "routerSettings", "wan=" + wan + " lan=" + lan + " pcq=" + (!!c.pcq) + " interval=" + interval + " walled=" + walled.length);
  return jres({ ok: true });
}

async function queue(db, ...cmds) {
  const pc = parse(await getState(db, "pending_cmds"), []);
  const arr = Array.isArray(pc) ? pc : [];
  arr.push(...cmds);
  await putState(db, "pending_cmds", JSON.stringify(arr));
}

async function action(env, b, who) {
  const db = env.DB, op = String(b.op || "");
  if (op === "test") {
    if (!tokenOk(env)) return fail("token_missing", "ROUTER_TOKEN is not set on the Worker yet, so the router cannot be reached.");
    const id = Math.random().toString(36).slice(2, 8).toUpperCase();
    const beacon = '/tool fetch url="' + origin(env) + "/router/diag?token=" + env.ROUTER_TOKEN + "&m=ADMIN-TEST-" + id + '" http-method=post http-data="b" output=none as-value';
    await queue(db, ':log info "sx: admin test ' + id + '"', beacon);
    await putState(db, "router_test", JSON.stringify({ id, sent: nowIso() }));
    await audit(db, who, "routerTest", id);
    return jres({ ok: true, id });
  }
  if (op === "refresh_portal") {
    await putState(db, "portal_gen", "0");
    await audit(db, who, "routerRefreshPortal", "");
    return jres({ ok: true });
  }
  if (op === "clear_log") { await delState(db, "rdiag"); return jres({ ok: true }); }
  return fail("bad_op", "That router operation is not supported.");
}

export async function routerAdmin(act, env, b, who) {
  try {
    if (act === "adminRouterInfo") return jres(await info(env));
    if (act === "adminRouterSave") return await save(env, b, who);
    if (act === "adminRouterAction") return await action(env, b, who);
  } catch (e) { return fail("internal_error", "Router panel error: " + String(e && e.message || e).slice(0, 160)); }
  return fail("unknown_action", "Unknown router action.");
}
