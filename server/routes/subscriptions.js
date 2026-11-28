// Subscription plans, checkout, renewal, cancellation and the user's own subscription history.
// No payment provider is connected: PAYMENT_MODE=test confirms the payment immediately and every
// payment record is marked testMode:true, so a real integration can replace it later.
import express from "express";
import { collections, inTransaction } from "../db.js";
import { ApiError } from "../errors.js";
import { audit } from "../security/audit.js";
import { moneyLimiter } from "../security/rateLimits.js";
import { newId, randomToken } from "../security/tokens.js";
import * as v from "../validate.js";
import {
  addDays,
  findPlan,
  publicPayment,
  publicPlan,
  publicSubscription,
  subscriptionState,
} from "../subscriptions.js";

function paymentRecord({ userId, subscriptionId, plan, now }) {
  return {
    _id: newId("pay"),
    userId,
    subscriptionId,
    planId: plan._id,
    amount: plan.price,
    currency: plan.currency || "TND",
    provider: "test",
    providerRef: "test_" + randomToken(6),
    status: "succeeded",
    testMode: true,
    paidAt: now,
    createdAt: now,
  };
}

function eventRecord({ userId, subscriptionId, type, planId, actorId = null, details = {}, now }) {
  return {
    _id: newId("sev"),
    userId,
    subscriptionId,
    type,
    at: now,
    actorId,
    details: { planId, ...details },
  };
}

export function subscriptionRoutes(config) {
  const router = express.Router();

  router.get("/plans", async (req, res) => {
    const plans = await collections.subscriptionPlans.find({ active: true }).sort({ sortOrder: 1, price: 1 }).toArray();
    res.json({ plans: plans.map(publicPlan), paymentMode: config.paymentMode });
  });

  router.get("/me", async (req, res) => {
    const state = await subscriptionState(req.user._id);
    const [events, payments] = await Promise.all([
      collections.subscriptionEvents.find({ userId: req.user._id }).sort({ at: -1 }).limit(20).toArray(),
      collections.payments.find({ userId: req.user._id }).sort({ paidAt: -1 }).limit(10).toArray(),
    ]);
    res.json({
      ...state,
      paymentMode: config.paymentMode,
      history: events.map((event) => ({
        _id: event._id,
        type: event.type,
        at: event.at,
        details: event.details || {},
      })),
      payments: payments.map(publicPayment),
    });
  });

  // Test checkout: the "payment" succeeds at once, then the subscription is written in the same
  // database transaction as its payment record and history event.
  router.post("/checkout", moneyLimiter, async (req, res) => {
    if (config.paymentMode !== "test") throw new ApiError("PAYMENT_FAILED", "Payments are currently disabled.");
    const body = v.onlyFields(req.body, ["planId"]);
    const planId = v.id(body.planId, { prefix: "plan", code: "PLAN_NOT_FOUND", message: "Choose a subscription plan." });
    const plan = await findPlan(planId);
    if (plan.active === false) throw new ApiError("PLAN_NOT_FOUND", "This subscription plan is not available.");

    const current = await subscriptionState(req.user._id);
    if (current.isPremium) {
      throw new ApiError("VALIDATION_ERROR", "You already have an active subscription. Use Renew to extend it.");
    }

    const now = new Date();
    const reuse = current.subscription && current.subscription.status === "expired" ? current.subscription._id : null;
    const subscriptionId = reuse || newId("sub");
    const payment = paymentRecord({ userId: req.user._id, subscriptionId, plan, now });

    await inTransaction(async (session) => {
      await collections.payments.insertOne(payment, { session });
      if (reuse) {
        await collections.subscriptions.updateOne(
          { _id: reuse, userId: req.user._id },
          {
            $set: {
              planId: plan._id,
              planCode: plan.code,
              planName: plan.name,
              price: plan.price,
              currency: plan.currency || "TND",
              interval: plan.interval,
              days: plan.days,
              status: "active",
              startedAt: now,
              expiresAt: addDays(now, plan.days),
              autoRenew: true,
              cancelledAt: null,
              suspendedAt: null,
              lastPaymentId: payment._id,
              updatedAt: now,
            },
          },
          { session }
        );
      } else {
        await collections.subscriptions.insertOne(
          {
            _id: subscriptionId,
            userId: req.user._id,
            planId: plan._id,
            planCode: plan.code,
            planName: plan.name,
            price: plan.price,
            currency: plan.currency || "TND",
            interval: plan.interval,
            days: plan.days,
            status: "active",
            startedAt: now,
            expiresAt: addDays(now, plan.days),
            autoRenew: true,
            cancelledAt: null,
            suspendedAt: null,
            lastPaymentId: payment._id,
            createdAt: now,
            updatedAt: now,
          },
          { session }
        );
      }
      await collections.subscriptionEvents.insertOne(
        eventRecord({
          userId: req.user._id,
          subscriptionId,
          type: "purchased",
          planId: plan._id,
          details: { paymentId: payment._id, testMode: true },
          now,
        }),
        { session }
      );
    });

    await audit(req, "subscription_purchased", { details: { planId: plan._id, testMode: true } });
    const state = await subscriptionState(req.user._id);
    res.status(201).json({ ...state, payment: publicPayment(payment) });
  });

  // Extends the current subscription. From the expiry date when it is still running, from today
  // when it has already expired.
  router.post("/renew", moneyLimiter, async (req, res) => {
    if (config.paymentMode !== "test") throw new ApiError("PAYMENT_FAILED", "Payments are currently disabled.");
    const body = v.onlyFields(req.body, ["planId"]);
    const state = await subscriptionState(req.user._id);
    if (!state.subscription) throw new ApiError("SUBSCRIPTION_NOT_FOUND", "You do not have a subscription yet.");
    if (state.subscription.status === "suspended") {
      throw new ApiError("FORBIDDEN", "This subscription was suspended by an administrator.");
    }

    const planId = body.planId
      ? v.id(body.planId, { prefix: "plan", code: "PLAN_NOT_FOUND", message: "Choose a subscription plan." })
      : state.subscription.planId;
    const plan = await findPlan(planId);
    if (plan.active === false) throw new ApiError("PLAN_NOT_FOUND", "This subscription plan is not available.");

    const now = new Date();
    const base = state.subscription.expiresAt > now ? new Date(state.subscription.expiresAt) : now;
    const expiresAt = addDays(base, plan.days);
    const payment = paymentRecord({ userId: req.user._id, subscriptionId: state.subscription._id, plan, now });

    await inTransaction(async (session) => {
      await collections.payments.insertOne(payment, { session });
      await collections.subscriptions.updateOne(
        { _id: state.subscription._id, userId: req.user._id },
        {
          $set: {
            planId: plan._id,
            planCode: plan.code,
            planName: plan.name,
            price: plan.price,
            currency: plan.currency || "TND",
            interval: plan.interval,
            days: plan.days,
            status: "active",
            expiresAt,
            autoRenew: true,
            cancelledAt: null,
            lastPaymentId: payment._id,
            updatedAt: now,
          },
        },
        { session }
      );
      await collections.subscriptionEvents.insertOne(
        eventRecord({
          userId: req.user._id,
          subscriptionId: state.subscription._id,
          type: "renewed",
          planId: plan._id,
          details: { paymentId: payment._id, expiresAt, testMode: true },
          now,
        }),
        { session }
      );
    });

    await audit(req, "subscription_renewed", { details: { planId: plan._id, testMode: true } });
    const next = await subscriptionState(req.user._id);
    res.json({ ...next, payment: publicPayment(payment) });
  });

  // Cancellation stops the renewal: premium access remains until expiresAt, then expires by itself.
  router.post("/cancel", async (req, res) => {
    const state = await subscriptionState(req.user._id);
    if (!state.isPremium) throw new ApiError("SUBSCRIPTION_NOT_FOUND", "You do not have an active subscription.");
    if (state.subscription.status === "cancelled") {
      throw new ApiError("VALIDATION_ERROR", "This subscription is already cancelled.");
    }
    const now = new Date();
    await collections.subscriptions.updateOne(
      { _id: state.subscription._id, userId: req.user._id, status: "active" },
      { $set: { status: "cancelled", autoRenew: false, cancelledAt: now, updatedAt: now } }
    );
    await collections.subscriptionEvents.insertOne(
      eventRecord({
        userId: req.user._id,
        subscriptionId: state.subscription._id,
        type: "cancelled",
        planId: state.subscription.planId,
        details: { accessUntil: state.subscription.expiresAt },
        now,
      })
    );
    await audit(req, "subscription_cancelled", { level: "warn" });
    res.json(await subscriptionState(req.user._id));
  });

  return router;
}

/** Re-exported so the admin panel can build the same shape for a subscription it changes. */
export { publicSubscription };
