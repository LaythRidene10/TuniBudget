import { request } from "./api.js";

/** Active plans with their price and benefits. */
export function getSubscriptionPlans() {
  return request("GET", "/subscriptions/plans");
}

/** The logged-in user's subscription, payment history and subscription events. */
export function getMySubscription() {
  return request("GET", "/subscriptions/me");
}

/** Test checkout: the server confirms the payment and activates premium in one transaction. */
export function checkout(planId) {
  return request("POST", "/subscriptions/checkout", { body: { planId } });
}

export function renewSubscription(planId) {
  return request("POST", "/subscriptions/renew", { body: planId ? { planId } : {} });
}

export function cancelSubscription() {
  return request("POST", "/subscriptions/cancel");
}
