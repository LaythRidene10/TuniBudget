// Express middleware that every request goes through.
import { randomUUID } from "node:crypto";
import { collections } from "../db.js";
import { sendError } from "../errors.js";
import { audit } from "./audit.js";
import { readSession } from "./sessions.js";
import { subscriptionState } from "../subscriptions.js";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

export function requestId(req, res, next) {
  req.id = randomUUID();
  res.set("X-Request-Id", req.id);
  next();
}

/**
 * HTTPS only, in production. req.secure is true for a direct TLS connection, or when a trusted
 * proxy (TRUST_PROXY) says the visitor used HTTPS. Pages are redirected; API calls are refused,
 * because redirecting a POST could leak its body over plain HTTP.
 */
export function requireHttps(config) {
  return (req, res, next) => {
    if (!config.isProduction || req.secure) return next();
    audit(req, "https_required", { level: "warn" });
    if (!req.path.startsWith("/api/") && SAFE_METHODS.includes(req.method)) {
      return res.redirect(308, config.appOrigin + req.originalUrl);
    }
    return sendError(res, "HTTPS_REQUIRED", "This API only answers over HTTPS.");
  };
}

/** API answers hold private data: never cache them. */
export function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
}

/**
 * CSRF protection, on top of the SameSite=Strict cookie:
 *  1. every write must carry the X-Requested-With header. Browsers do not let another site add a
 *     custom header without a CORS preflight, and this server never approves cross-site preflights;
 *  2. when the browser sends an Origin header, it must be this app's own address.
 */
export function csrfGuard(config) {
  return (req, res, next) => {
    if (SAFE_METHODS.includes(req.method)) return next();
    const origin = req.get("origin");
    const header = req.get("x-requested-with");
    if (header !== "TuniBudget" || (origin && origin !== config.appOrigin)) {
      audit(req, "csrf_blocked", { level: "warn", details: { origin: origin || null } });
      return sendError(res, "FORBIDDEN", "This request was blocked for your safety. Reload the page and try again.");
    }
    next();
  };
}

/**
 * NoSQL injection guard. MongoDB queries are built only from validated plain values (the
 * equivalent of parameterized SQL queries), and as a second barrier any key that looks like a
 * MongoDB operator ($gt, $where…), a dotted path, or a prototype key is refused outright.
 */
const FORBIDDEN_KEY = /[$.[\]]|^(__proto__|constructor|prototype)$/;
function findForbiddenKey(value, depth = 0) {
  if (depth > 6) return "too deep";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEY.test(key)) return key;
      const found = findForbiddenKey(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function injectionGuard(req, res, next) {
  const key = findForbiddenKey(req.body) || findForbiddenKey(req.query) || findForbiddenKey(req.params);
  if (key) {
    audit(req, "injection_blocked", { level: "warn", details: { key: String(key).slice(0, 40) } });
    return sendError(res, "INVALID_REQUEST", "The request contains forbidden characters.");
  }
  next();
}

/** Loads the logged-in user from the session cookie. */
export async function requireAuth(req, res, next) {
  const session = await readSession(req);
  if (!session) return sendError(res, "UNAUTHENTICATED", "Your session has ended. Please log in again.");
  const user = await collections.users.findOne({ _id: session.userId }, { projection: { passwordHash: 0 } });
  if (!user || user.disabled) return sendError(res, "UNAUTHENTICATED", "Your session has ended. Please log in again.");
  req.session = session;
  req.user = user;
  next();
}

/**
 * Premium routes. Access is read from the subscriptions collection on every request, so an
 * expired, cancelled (past its end date) or suspended subscription loses premium at once, even
 * if the browser still shows the premium buttons.
 */
export async function requirePremium(req, res, next) {
  const state = await subscriptionState(req.user._id);
  if (!state.isPremium) {
    audit(req, "premium_denied", { level: "warn" });
    return sendError(res, "PREMIUM_REQUIRED", "This feature needs an active Premium subscription.");
  }
  req.subscription = state.subscription;
  next();
}

/**
 * Admin routes. The role is read from the database on every request (never from the browser).
 * Non-admins get a 404, so they cannot even learn that the route exists. An optional IP
 * allowlist (ADMIN_IP_ALLOWLIST) adds a network barrier.
 */
export function requireAdmin(config) {
  return (req, res, next) => {
    const ipAllowed = config.adminIpAllowlist.length === 0 || config.adminIpAllowlist.includes(req.ip);
    if (!req.user || req.user.role !== "admin" || !ipAllowed) {
      audit(req, "admin_denied", { level: "warn", details: { ipAllowed } });
      return sendError(res, "NOT_FOUND", "Not found.");
    }
    audit(req, "admin_access", { level: "info" });
    next();
  };
}
