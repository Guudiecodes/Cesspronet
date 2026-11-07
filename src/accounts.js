/**
 * CessproNet accounts: one sign-in for customers and admins, separate accounts per role.
 *
 *  - Customers sign up on /signin.html with email + password, buy plans and see their codes on /account.html.
 *  - Admins use the SAME page. Their email must be listed in the ADMIN_EMAILS secret; that is what makes
 *    an account an admin account. The first time, they press "Email me a code" and then choose a password.
 *  - Sessions live in their own table and carry a role, so a customer token can never open admin actions
 *    and an admin token is never mixed up with a customer's.
 *
 * Everything lives in this file so worker.js only needs a few one-line hooks (see _fix/apply.mjs).
 */

const PBKDF2_ITER = 100000;                  // Workers cap PBKDF2 at 100k iterations
const CUSTOMER_SESSION_MS = 30 * 86400e3;
const ADMIN_SESSION_MS = 12 * 3600e3;
const CODE_TTL_MS = 15 * 60e3;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;

let READY = false;
export async function ensureAccounts(db) {
  if (READY) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', pass_hash TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'customer', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (tok_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, via TEXT NOT NULL DEFAULT 'password', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_links (user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, ref))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_links_user ON user_links(user_id, created_at)")
  ]);
  READY = true;
}

// ------------------------------------------------------------------ password hashing
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function derive(pw, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return "pbkdf2$" + PBKDF2_ITER + "$" + b64(salt) + "$" + b64(await derive(pw, salt, PBKDF2_ITER));
}
const DUMMY = "pbkdf2$" + PBKDF2_ITER + "$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
async function checkPassword(lib, pw, stored) {
  const parts = String(stored || DUMMY).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const got = b64(await derive(pw, unb64(parts[2]), Math.min(+parts[1] || PBKDF2_ITER, PBKDF2_ITER)));
  return !!stored && lib.safeEq(got, parts[3]);
}

// ------------------------------------------------------------------ helpers
const isAdminEmail = (lib, env, email) => lib.adminEmails(env).includes(email);
const cleanEmail = v => String(v || "").trim().toLowerCase();
const cleanName = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
const cleanPhone = v => String(v || "").replace(/[^\d+]/g, "").slice(0, 16);
const pubUser = (u, role) => ({ name: u.name || "", email: u.email, phone: u.phone || "", role: role || u.role });

async function tokenHash(lib, env, tok) { return lib.sha256((env.OTP_SALT || "dev") + "|sess|" + tok); }

async function makeSession(lib, db, env, user, role, via) {
  const tok = lib.randHex(32);
  const now = lib.nowMs();
  await lib.run(db, "INSERT INTO sessions(tok_hash,user_id,role,via,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",
    await tokenHash(lib, env, tok), user.id, role, via, now, now + (role === "admin" ? ADMIN_SESSION_MS : CUSTOMER_SESSION_MS));
  await lib.run(db, "UPDATE users SET last_login_at=?1 WHERE id=?2", lib.nowIso(), user.id);
  // opportunistic cleanup of expired sessions
  if (Math.random() < 0.05) await lib.run(db, "DELETE FROM sessions WHERE expires_at<?1", now);
  return tok;
}

/** Returns { id, email, name, phone, role, via } for a valid session token, otherwise null. */
export async function sessionUser(lib, db, env, token) {
  token = String(token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  await ensureAccounts(db);
  const s = await lib.one(db, "SELECT s.user_id,s.role,s.via,s.expires_at,u.email,u.name,u.phone,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.tok_hash=?1", await tokenHash(lib, env, token));
  if (!s || s.expires_at < lib.nowMs() || s.disabled) return null;
  // the role is re-checked on every request: removing an email from ADMIN_EMAILS revokes admin at once
  const role = isAdminEmail(lib, env, s.email) ? "admin" : "customer";
  if (s.role === "admin" && role !== "admin") return null;
  return { id: s.user_id, email: s.email, name: s.name, phone: s.phone, role: s.role === "admin" ? "admin" : "customer", via: s.via };
}

const loginResult = (lib, tok, user, role) => lib.json({ ok: true, token: tok, user: pubUser(user, role), redirect: role === "admin" ? "/admin.html" : "/account.html" });

// failure throttling (re-uses the existing otp table: sends = failures, sent_at = last failure)
async function throttled(lib, db, key, max) {
  const row = await lib.one(db, "SELECT sends,sent_at FROM otp WHERE email=?1", key);
  return !!row && row.sends >= max && lib.nowMs() - row.sent_at < 15 * 60e3;
}
async function noteFailure(lib, db, key) {
  const row = await lib.one(db, "SELECT sends,sent_at FROM otp WHERE email=?1", key);
  const fresh = !row || lib.nowMs() - row.sent_at >= 15 * 60e3;
  await lib.run(db, "INSERT INTO otp(email,code_hash,expires_at,attempts,sends,sent_at) VALUES(?1,'',0,0,1,?2) ON CONFLICT(email) DO UPDATE SET sends=" + (fresh ? "1" : "sends+1") + ",sent_at=?2", key, lib.nowMs());
}
const clearFailures = (lib, db, key) => lib.run(db, "DELETE FROM otp WHERE email=?1", key);

async function sendMail(lib, env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
    return r.ok;
  } catch (e) { return false; }
}

// ------------------------------------------------------------------ hooks used by worker.js
/** Runs for every POST /api: makes sure tables exist, resolves the signed-in user and flags same-site requests. */
export async function attachUser(lib, env, req, url, b) {
  await ensureAccounts(env.DB);
  // A request counts as "from the website" when it comes from this site or from any https site that
  // fronts it (for example a Vercel domain). The router's WiFi pages are served over plain http, so they
  // are exempt; if yours use https, list their origin(s) in the PORTAL_ORIGINS variable (comma-separated).
  // Set by the server, never trusted from the request body.
  const origin = req.headers.get("Origin") || "";
  const portals = String(env.PORTAL_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  b.__web = origin === url.origin || (/^https:\/\//.test(origin) && !portals.includes(origin));
  b.__ip = (req.headers.get("CF-Connecting-IP") || "x").slice(0, 45);
  b.__user = b.token ? await sessionUser(lib, env.DB, env, b.token) : null;
}

export async function accountRequired(lib, db) {
  const row = await lib.one(db, "SELECT value FROM settings WHERE key='require_account'");
  return !row || String(row.value) !== "0";         // on unless the admin switched it off
}

export async function linkOrder(lib, db, userId, orderId) {
  await lib.run(db, "INSERT OR IGNORE INTO user_links(user_id,kind,ref,created_at) VALUES(?1,'order',?2,?3)", userId, orderId, lib.nowIso());
}
export async function linkStockSale(lib, db, user, reference) {
  if (!user) return;
  const ref = String(reference || "").trim();
  try {
    const sold = await lib.one(db, "SELECT 1 x FROM code_stock WHERE sale_ref=?1", ref);
    if (sold) await lib.run(db, "INSERT OR IGNORE INTO user_links(user_id,kind,ref,created_at) VALUES(?1,'stock',?2,?3)", user.id, ref, lib.nowIso());
  } catch (e) { /* code_stock not created yet: nothing sold */ }
}

// ------------------------------------------------------------------ actions
export async function accountRoute(action, ctx) {
  const { env, b, lib } = ctx, db = env.DB;
  switch (action) {
    case "signUp": return await signUp(lib, db, env, b);
    case "signIn": return await signIn(lib, db, env, b);
    case "forgotPassword": return await forgotPassword(lib, db, env, b);
    case "resetPassword": return await resetPassword(lib, db, env, b);
    case "signOut": return await signOut(lib, db, env, b);
    case "accountMe": return await accountMe(lib, db, env, b);
    case "updateProfile": return await updateProfile(lib, db, env, b);
    case "setPassword": return await setPassword(lib, db, env, b);
  }
  return null;
}

async function signUp(lib, db, env, b) {
  const email = cleanEmail(b.email), name = cleanName(b.name), phone = cleanPhone(b.phone), pw = String(b.password || "");
  if (!name) return lib.err("invalid_name", "Enter your name.");
  if (!EMAIL_RE.test(email)) return lib.err("invalid_email", "Enter a valid email address, for example name@example.com.");
  if (phone && !/^\+?\d{7,15}$/.test(phone)) return lib.err("invalid_phone", "That phone number does not look right. Use digits only, for example 08031234567, or leave it empty.");
  if (pw.length < 8 || pw.length > 72) return lib.err("invalid_password", "Choose a password of 8 to 72 characters.");
  if (isAdminEmail(lib, env, email)) return lib.err("email_reserved", "This email belongs to the staff team. Use a different email to buy WiFi, or press \u201CEmail me a code\u201D to sign in as staff.");
  const key = "signup:" + (b.__ip || "x");
  if (await throttled(lib, db, key, 12)) return lib.err("too_many_attempts", "Too many sign-up attempts from this connection. Wait 15 minutes and try again.");
  if (await lib.one(db, "SELECT 1 x FROM users WHERE email=?1", email)) { await noteFailure(lib, db, key); return lib.err("email_taken", "That email already has an account. Sign in instead, or reset your password."); }
  const id = lib.randHex(8);
  await lib.run(db, "INSERT INTO users(id,email,name,phone,pass_hash,role,created_at) VALUES(?1,?2,?3,?4,?5,'customer',?6)", id, email, name, phone, await hashPassword(pw), lib.nowIso());
  await noteFailure(lib, db, key);                       // counts towards the per-connection sign-up limit
  await lib.audit(db, email, "signUp", "customer account created");
  lib.notify(env, "\u{1F464} New customer account: " + name + " <" + email + ">");
  const user = { id, email, name, phone, role: "customer" };
  return loginResult(lib, await makeSession(lib, db, env, user, "customer", "password"), user, "customer");
}

async function signIn(lib, db, env, b) {
  const email = cleanEmail(b.email), pw = String(b.password || "");
  const key = "login:" + email;
  if (await throttled(lib, db, key, 8)) return lib.err("too_many_attempts", "Too many wrong passwords for this email. Wait 15 minutes, or reset your password with an emailed code.");
  const u = await lib.one(db, "SELECT * FROM users WHERE email=?1", email);
  const good = await checkPassword(lib, pw, u && u.pass_hash);   // runs even when the account does not exist (same timing)
  if (!u || !good || u.disabled) {
    await noteFailure(lib, db, key);
    return lib.err("invalid_credentials", u && u.disabled ? "This account has been disabled. Contact support." : "Wrong email or password. If you forgot it, use \u201CForgot password\u201D below.");
  }
  await clearFailures(lib, db, key);
  const role = isAdminEmail(lib, env, email) ? "admin" : "customer";
  if (u.role !== role) await lib.run(db, "UPDATE users SET role=?1 WHERE id=?2", role, u.id);
  await lib.audit(db, email, "signIn", role);
  return loginResult(lib, await makeSession(lib, db, env, u, role, "password"), u, role);
}

async function forgotPassword(lib, db, env, b) {
  const email = cleanEmail(b.email);
  const generic = lib.json({ ok: true });
  if (!EMAIL_RE.test(email)) return generic;
  const key = "code:" + email;
  if (await throttled(lib, db, "codesend:" + email, 5)) return lib.err("too_many_attempts", "Too many codes requested for this email. Wait 15 minutes and try again.");
  const admin = isAdminEmail(lib, env, email);
  const u = await lib.one(db, "SELECT id FROM users WHERE email=?1", email);
  if (!admin && !u) return generic;                        // never reveal which emails have accounts
  if (!admin && !(env.RESEND_API_KEY && env.MAIL_FROM)) return lib.err("email_not_configured", "Password reset by email is not switched on yet. Please contact support to reset your password.");
  await noteFailure(lib, db, "codesend:" + email);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  await lib.run(db, "INSERT INTO otp(email,code_hash,expires_at,attempts,sends,sent_at) VALUES(?1,?2,?3,0,1,?4) ON CONFLICT(email) DO UPDATE SET code_hash=?2,expires_at=?3,attempts=0,sent_at=?4",
    key, await lib.sha256((env.OTP_SALT || "dev") + "|reset|" + email + "|" + code), lib.nowMs() + CODE_TTL_MS, lib.nowMs());
  const text = "Your CessproNet " + (admin ? "staff " : "") + "code is " + code + ". It works for 15 minutes. If you did not ask for it, ignore this message.";
  if (!(await sendMail(lib, env, email, "Your CessproNet code " + code, text)) && admin) {
    // staff fallback: same channels the old admin sign-in used (Telegram, then the Worker log)
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) lib.notify(env, email + " - " + text); else console.log("[CODE] " + email + " -> " + code);
  }
  return generic;
}

async function resetPassword(lib, db, env, b) {
  const email = cleanEmail(b.email), code = String(b.code || "").trim(), pw = String(b.password || "");
  if (pw.length < 8 || pw.length > 72) return lib.err("invalid_password", "Choose a password of 8 to 72 characters.");
  const key = "code:" + email;
  const row = await lib.one(db, "SELECT * FROM otp WHERE email=?1", key);
  if (!row || row.expires_at < lib.nowMs()) return lib.err("code_expired", "That code has expired or was never sent. Request a new one. Codes last 15 minutes.");
  if (row.attempts >= 5) return lib.err("code_locked", "Too many wrong codes. Request a new one.");
  if (!lib.safeEq(row.code_hash, await lib.sha256((env.OTP_SALT || "dev") + "|reset|" + email + "|" + code))) {
    await lib.run(db, "UPDATE otp SET attempts=attempts+1 WHERE email=?1", key);
    return lib.err("wrong_code", "Wrong code. " + Math.max(0, 4 - row.attempts) + " attempt(s) left before this code locks.");
  }
  await lib.run(db, "DELETE FROM otp WHERE email=?1", key);
  const admin = isAdminEmail(lib, env, email);
  let u = await lib.one(db, "SELECT * FROM users WHERE email=?1", email);
  if (!u && !admin) return lib.err("code_expired", "That code has expired or was never sent. Request a new one.");
  const hash = await hashPassword(pw);
  if (!u) {
    u = { id: lib.randHex(8), email, name: "Staff", phone: "", role: "admin", disabled: 0 };
    await lib.run(db, "INSERT INTO users(id,email,name,phone,pass_hash,role,created_at) VALUES(?1,?2,'Staff','',?3,'admin',?4)", u.id, email, hash, lib.nowIso());
  } else {
    await lib.run(db, "UPDATE users SET pass_hash=?1,role=?2 WHERE id=?3", hash, admin ? "admin" : "customer", u.id);
    await lib.run(db, "DELETE FROM sessions WHERE user_id=?1", u.id);        // a reset signs out every other device
    await clearFailures(lib, db, "login:" + email);
  }
  if (u.disabled) return lib.err("invalid_credentials", "This account has been disabled. Contact support.");
  const role = admin ? "admin" : "customer";
  await lib.audit(db, email, "resetPassword", role);
  return loginResult(lib, await makeSession(lib, db, env, u, role, "code"), u, role);
}

async function signOut(lib, db, env, b) {
  const tok = String(b.token || "");
  if (/^[0-9a-f]{64}$/.test(tok)) await lib.run(db, "DELETE FROM sessions WHERE tok_hash=?1", await tokenHash(lib, env, tok));
  return lib.json({ ok: true });
}

async function accountMe(lib, db, env, b) {
  const me = b.__user;
  if (!me) return lib.err("unauthorized", "Your session has ended. Sign in again.");
  let orders = [], codes = [];
  if (me.role === "customer") {
    orders = await lib.q(db, "SELECT o.order_id,o.status,o.id_type,o.identifier,o.created_at,o.paid_at,o.activated_at,o.expires_at,COALESCE(o.amount_paid,p.price,0) amount,p.name plan,p.validity,p.rate_limit FROM user_links l JOIN orders o ON o.order_id=l.ref LEFT JOIN plans p ON p.plan_id=o.plan_id WHERE l.user_id=?1 AND l.kind='order' ORDER BY o.created_at DESC LIMIT 100", me.id);
    try {
      codes = await lib.q(db, "SELECT s.code,s.sold_at,s.amount,s.sale_ref ref,p.name plan,p.validity,p.rate_limit FROM user_links l JOIN code_stock s ON s.sale_ref=l.ref LEFT JOIN plans p ON p.plan_id=s.plan_id WHERE l.user_id=?1 AND l.kind='stock' ORDER BY s.sold_at DESC LIMIT 100", me.id);
    } catch (e) { codes = []; }
  }
  return lib.json({ ok: true, user: pubUser(me), orders, codes });
}

async function updateProfile(lib, db, env, b) {
  const me = b.__user;
  if (!me) return lib.err("unauthorized", "Your session has ended. Sign in again.");
  const name = cleanName(b.name), phone = cleanPhone(b.phone);
  if (!name) return lib.err("invalid_name", "Enter your name.");
  if (phone && !/^\+?\d{7,15}$/.test(phone)) return lib.err("invalid_phone", "That phone number does not look right. Use digits only, or leave it empty.");
  await lib.run(db, "UPDATE users SET name=?1,phone=?2 WHERE id=?3", name, phone, me.id);
  return lib.json({ ok: true, user: pubUser({ ...me, name, phone }) });
}

async function setPassword(lib, db, env, b) {
  const me = b.__user;
  if (!me) return lib.err("unauthorized", "Your session has ended. Sign in again.");
  const pw = String(b.password || "");
  if (pw.length < 8 || pw.length > 72) return lib.err("invalid_password", "Choose a password of 8 to 72 characters.");
  const u = await lib.one(db, "SELECT pass_hash FROM users WHERE id=?1", me.id);
  if (u && u.pass_hash && !(await checkPassword(lib, String(b.current || ""), u.pass_hash))) return lib.err("invalid_credentials", "Your current password is not right.");
  await lib.run(db, "UPDATE users SET pass_hash=?1 WHERE id=?2", await hashPassword(pw), me.id);
  const keep = await tokenHash(lib, env, String(b.token));
  await lib.run(db, "DELETE FROM sessions WHERE user_id=?1 AND tok_hash!=?2", me.id, keep);   // other devices are signed out
  await lib.audit(db, me.email, "setPassword", me.role);
  return lib.json({ ok: true });
}

// ------------------------------------------------------------------ admin: customer list
export async function adminCustomers(lib, db, b) {
  await ensureAccounts(db);
  const term = String(b.q || "").trim().toLowerCase();
  const rows = await lib.q(db, "SELECT u.id,u.email,u.name,u.phone,u.role,u.disabled,u.created_at,u.last_login_at,(SELECT COUNT(*) FROM user_links l WHERE l.user_id=u.id) purchases FROM users u " + (term ? "WHERE lower(u.email) LIKE ?1 OR lower(u.name) LIKE ?1 OR u.phone LIKE ?1 " : "WHERE ?1='' ") + "ORDER BY u.created_at DESC LIMIT 300", term ? "%" + term + "%" : "");
  const total = (await lib.one(db, "SELECT COUNT(*) c FROM users WHERE role='customer'")).c;
  return lib.json({ ok: true, total, users: rows });
}
export async function adminCustomerOp(lib, db, b, who) {
  await ensureAccounts(db);
  const id = String(b.id || "");
  const u = await lib.one(db, "SELECT id,email,role FROM users WHERE id=?1", id);
  if (!u) return lib.err("not_found", "That account no longer exists.");
  if (u.role === "admin") return lib.err("bad_op", "Staff accounts are managed with the ADMIN_EMAILS secret, not here.");
  if (b.op === "disable" || b.op === "enable") {
    await lib.run(db, "UPDATE users SET disabled=?1 WHERE id=?2", b.op === "disable" ? 1 : 0, id);
    if (b.op === "disable") await lib.run(db, "DELETE FROM sessions WHERE user_id=?1", id);
    await lib.audit(db, who, "customer_" + b.op, u.email);
    return lib.json({ ok: true });
  }
  return lib.err("bad_op");
}
