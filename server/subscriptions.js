// Subscription helpers shared by the routes, the auth layer and the admin panel.
// The subscriptions collection is the single source of truth for premium access: the role sent to
// the browser is only a display value, and every premium route checks the database again.
import { collections } from "./db.js";
import { ApiError, validationError } from "./errors.js";
import { newId } from "./security/tokens.js";
import * as v from "./validate.js";

export const ACTIVE_STATUSES = ["active", "cancelled"];
export const PLAN_INTERVALS = ["month", "year"];

export const DEFAULT_PLANS = [
  {
    _id: "plan_monthly",
    code: "monthly",
    name: "Monthly Premium",
    price: 12000,
    currency: "TND",
    interval: "month",
    days: 30,
    description: "All premium tools, billed every month.",
    badge: "",
    features: [
      "Advanced analytics and monthly comparisons",
      "Detailed spending reports and CSV downloads",
      "Savings goals with progress tracking",
      "Advanced transaction search",
      "Financial insights and recommendations",
    ],
    active: true,
    sortOrder: 1,
  },
  {
    _id: "plan_yearly",
    code: "yearly",
    name: "Yearly Premium",
    price: 120000,
    currency: "TND",
    interval: "year",
    days: 365,
    description: "Two months free compared with the monthly plan.",
    badge: "Best value",
    features: [
      "Everything in Monthly Premium",
      "Two months free",
      "Yearly financial comparison",
      "Priority access to new premium tools",
    ],
    active: true,
    sortOrder: 2,
  },
];

export function isSubscriptionActive(subscription, now = new Date()) {
  return Boolean(subscription) && ACTIVE_STATUSES.includes(subscription.status) && subscription.expiresAt > now;
}

export function publicPlan(plan) {
  if (!plan) return null;
  return {
    _id: plan._id,
    code: plan.code,
    name: plan.name,
    price: plan.price,
    currency: plan.currency || "TND",
    interval: plan.interval,
    days: plan.days,
    description: plan.description || "",
    badge: plan.badge || "",
    features: plan.features || [],
    active: plan.active !== false,
    sortOrder: plan.sortOrder || 0,
  };
}

export function publicSubscription(subscription, plan = null) {
  if (!subscription) return null;
  return {
    _id: subscription._id,
    planId: subscription.planId,
    planCode: subscription.planCode,
    planName: subscription.planName,
    price: subscription.price,
    currency: subscription.currency || "TND",
    interval: subscription.interval,
    status: subscription.status,
    startedAt: subscription.startedAt,
    expiresAt: subscription.expiresAt,
    autoRenew: subscription.autoRenew !== false,
    cancelledAt: subscription.cancelledAt || null,
    suspendedAt: subscription.suspendedAt || null,
    isPremium: isSubscriptionActive(subscription),
    plan: plan ? publicPlan(plan) : null,
  };
}

export function publicPayment(payment) {
  if (!payment) return null;
  return {
    _id: payment._id,
    planId: payment.planId,
    subscriptionId: payment.subscriptionId,
    amount: payment.amount,
    currency: payment.currency || "TND",
    provider: payment.provider,
    status: payment.status,
    testMode: Boolean(payment.testMode),
    reference: payment.providerRef || payment.reference,
    paidAt: payment.paidAt,
  };
}

/** Creates the two default plans if they are missing. Never overwrites an admin's price change. */
export async function ensureDefaultPlans() {
  for (const plan of DEFAULT_PLANS) {
    await collections.subscriptionPlans.updateOne(
      { _id: plan._id },
      { $setOnInsert: { ...plan, createdAt: new Date(), updatedAt: new Date() } },
      { upsert: true }
    );
  }
}

/**
 * Marks every subscription whose expiry date has passed as expired and records it once.
 * Called on each premium check, so access disappears at the first request after expiry even
 * without a background job.
 */
export async function expireDueSubscriptions(userId = null) {
  const now = new Date();
  const filter = { status: { $in: ACTIVE_STATUSES }, expiresAt: { $lte: now } };
  if (userId) filter.userId = userId;
  const due = await collections.subscriptions.find(filter, { projection: { _id: 1, userId: 1, planId: 1 } }).toArray();
  for (const subscription of due) {
    const result = await collections.subscriptions.updateOne(
      { _id: subscription._id, status: { $in: ACTIVE_STATUSES }, expiresAt: { $lte: now } },
      { $set: { status: "expired", updatedAt: now } }
    );
    if (result.modifiedCount === 1) {
      await collections.subscriptionEvents.insertOne({
        _id: newId("sev"),
        userId: subscription.userId,
        subscriptionId: subscription._id,
        type: "expired",
        at: now,
        actorId: null,
        details: { planId: subscription.planId },
      });
    }
  }
  return due.length;
}

/** Current subscription and premium state of one user. */
export async function subscriptionState(userId) {
  await expireDueSubscriptions(userId);
  const now = new Date();
  const active = await collections.subscriptions.findOne(
    { userId, status: { $in: ACTIVE_STATUSES }, expiresAt: { $gt: now } },
    { sort: { expiresAt: -1 } }
  );
  const latest = active || (await collections.subscriptions.findOne({ userId }, { sort: { createdAt: -1 } }));
  const plan = latest ? await collections.subscriptionPlans.findOne({ _id: latest.planId }) : null;
  return {
    isPremium: Boolean(active),
    subscription: publicSubscription(latest, plan),
    plan: plan ? publicPlan(plan) : null,
  };
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

/** Validates a plan body. `partial` is used by PATCH: missing fields keep their value. */
export function validatePlanInput(body, { partial = false } = {}) {
  const data = v.onlyFields(body, ["code", "name", "price", "interval", "days", "features", "description", "badge", "active", "sortOrder"]);
  const out = {};
  const required = (field) => {
    if (!partial && data[field] === undefined) throw validationError("This field is required.");
  };

  required("code");
  required("name");
  required("price");
  required("interval");
  required("days");

  if (data.code !== undefined) {
    if (typeof data.code !== "string" || !/^[a-z][a-z0-9_]{2,20}$/.test(data.code)) {
      throw validationError("The plan code must be 3 to 21 lowercase letters, digits or _.");
    }
    out.code = data.code;
  }
  if (data.name !== undefined) out.name = v.text(data.name, { min: 2, max: 60, message: "The plan name needs 2 to 60 characters." });
  if (data.price !== undefined) out.price = v.millimes(data.price, { message: "The price must be greater than 0." });
  if (data.interval !== undefined) out.interval = v.oneOf(data.interval, PLAN_INTERVALS, "Choose month or year.");
  if (data.days !== undefined) out.days = v.integer(data.days, { min: 1, max: 4000, message: "The duration must be 1 to 4000 days." });
  if (data.features !== undefined) out.features = v.featureList(data.features);
  if (data.description !== undefined) out.description = v.text(data.description, { min: 0, max: 200, message: "The description can have at most 200 characters." });
  if (data.badge !== undefined) out.badge = v.text(data.badge, { min: 0, max: 24, message: "The badge can have at most 24 characters." });
  if (data.active !== undefined) out.active = v.bool(data.active);
  if (data.sortOrder !== undefined) out.sortOrder = v.integer(data.sortOrder, { min: 0, max: 999, message: "The order must be 0 to 999." });
  return out;
}

export async function findPlan(planId) {
  const plan = await collections.subscriptionPlans.findOne({ _id: planId });
  if (!plan) throw new ApiError("PLAN_NOT_FOUND", "This subscription plan does not exist.");
  return plan;
}
