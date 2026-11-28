// Admin API. The server checks the admin role on every call: hiding the page is only for comfort.
import { request } from "./api.js";

export function getSecuritySummary() {
  return request("GET", "/admin/security-summary");
}

export function getAdminUsers() {
  return request("GET", "/admin/users");
}

/** level: "" (all), "info", "warn" or "alert". */
export function getAuditLogs({ level = "", page = 1, limit = 25 } = {}) {
  return request("GET", "/admin/audit-logs", { query: { level, page, limit } });
}

export function revokeUserSessions(userId) {
  return request("POST", "/admin/users/" + encodeURIComponent(userId) + "/revoke-sessions");
}

export function setUserDisabled(userId, disabled) {
  return request("POST", "/admin/users/" + encodeURIComponent(userId) + "/disable", { body: { disabled } });
}

// ---------- subscriptions and plans ----------

export function getAdminSubscriptionStats() {
  return request("GET", "/admin/subscriptions/stats");
}

export function getAdminSubscriptions({ status = "", page = 1, limit = 100 } = {}) {
  return request("GET", "/admin/subscriptions", { query: { status, page, limit } });
}

export function suspendAdminSubscription(subscriptionId) {
  return request("POST", "/admin/subscriptions/" + encodeURIComponent(subscriptionId) + "/suspend");
}

export function activateAdminSubscription(subscriptionId) {
  return request("POST", "/admin/subscriptions/" + encodeURIComponent(subscriptionId) + "/activate");
}

export function deactivateAdminSubscription(subscriptionId) {
  return request("POST", "/admin/subscriptions/" + encodeURIComponent(subscriptionId) + "/deactivate");
}

/** Gives a user a plan without a payment (support gesture, demo, refund compensation). */
export function grantSubscription(userId, planId) {
  return request("POST", "/admin/users/" + encodeURIComponent(userId) + "/subscription", { body: { planId } });
}

export function getAdminPlans() {
  return request("GET", "/admin/plans");
}

export function createAdminPlan(plan) {
  return request("POST", "/admin/plans", { body: plan });
}

export function updateAdminPlan(planId, changes) {
  return request("PATCH", "/admin/plans/" + encodeURIComponent(planId), { body: changes });
}
