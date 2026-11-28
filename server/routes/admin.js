// Admin routes: security monitoring and user support. Mounted behind requireAuth + requireAdmin,
// so they need a logged-in admin (role read from the database) and, optionally, an allowed IP.
// Every admin action is written to the security log. Admins never see password hashes.
import express from "express";
import { collections } from "../db.js";
import { ApiError } from "../errors.js";
import { audit } from "../security/audit.js";
import { endAllSessions } from "../security/sessions.js";
import { newId, sha256 } from "../security/tokens.js";
import * as v from "../validate.js";
import {
  ACTIVE_STATUSES,
  addDays,
  expireDueSubscriptions,
  publicPlan,
  publicSubscription,
  validatePlanInput,
} from "../subscriptions.js";

const LEVELS = ["info", "warn", "alert"];

export function adminRoutes() {
  const router = express.Router();

  // Counts of security events over the last 24 hours, and the latest alerts.
  router.get("/security-summary", async (req, res) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [byEvent, alerts, activeSessions] = await Promise.all([
      collections.auditLogs.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: "$event", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
      collections.auditLogs.find({ level: "alert" }).sort({ at: -1 }).limit(20).toArray(),
      collections.sessions.countDocuments({ expiresAt: { $gt: new Date() } }),
    ]);
    res.json({ since, events: byEvent.map((e) => ({ event: e._id, count: e.count })), alerts, activeSessions });
  });

  router.get("/audit-logs", async (req, res) => {
    const filter = {};
    if (req.query.level) filter.level = v.oneOf(req.query.level, LEVELS, "Unknown level.");
    if (req.query.event) {
      if (typeof req.query.event !== "string" || !/^[a-z_]{3,40}$/.test(req.query.event)) throw new ApiError("VALIDATION_ERROR", "Unknown event.");
      filter.event = req.query.event;
    }
    const page = v.intParam(req.query.page, { fallback: 1, min: 1, max: 10000 });
    const limit = v.intParam(req.query.limit, { fallback: 50, min: 1, max: 200 });
    const items = await collections.auditLogs.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    res.json({ items, page, limit });
  });

  router.get("/users", async (req, res) => {
    const users = await collections.users
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    res.json(users);
  });

  // Logs a user out of every device (for example after a suspected account takeover).
  router.post("/users/:userId/revoke-sessions", async (req, res) => {
    const userId = v.id(req.params.userId, { prefix: "usr", code: "NOT_FOUND", message: "This user does not exist." });
    const closed = await endAllSessions(userId);
    await audit(req, "admin_revoked_sessions", { level: "warn", details: { targetUserId: userId, sessionsClosed: closed } });
    res.json({ sessionsClosed: closed });
  });

  // Blocks or unblocks a user. A disabled user cannot log in and all their sessions end.
  router.post("/users/:userId/disable", async (req, res) => {
    const userId = v.id(req.params.userId, { prefix: "usr", code: "NOT_FOUND", message: "This user does not exist." });
    const body = v.onlyFields(req.body, ["disabled"]);
    const disabled = v.bool(body.disabled);
    if (userId === req.user._id) throw new ApiError("VALIDATION_ERROR", "You cannot disable your own account.");
    const result = await collections.users.updateOne({ _id: userId }, { $set: { disabled } });
    if (result.matchedCount === 0) throw new ApiError("NOT_FOUND", "This user does not exist.");
    if (disabled) await endAllSessions(userId);
    await audit(req, disabled ? "admin_disabled_user" : "admin_enabled_user", { level: "warn", details: { targetUserId: userId } });
    res.json({ _id: userId, disabled });
  });

  // Lifts a login lock (5 failed attempts) for one email.
  router.post("/unlock-login", async (req, res) => {
    const body = v.onlyFields(req.body, ["email"]);
    const mail = v.email(body.email);
    await collections.loginThrottle.deleteOne({ _id: sha256(mail) });
    await audit(req, "admin_unlocked_login", { level: "warn" });
    res.json({ unlocked: true });
  });

  // ---------- subscription statistics and management ----------

  router.get("/subscriptions/stats", async (req, res) => {
    await expireDueSubscriptions();
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const activeFilter = { status: { $in: ACTIVE_STATUSES }, expiresAt: { $gt: now } };

    const [totalUsers, admins, premiumUserIds, active, cancelled, suspended, expired, expiringSoon, revenue, recentRevenue, byPlan] =
      await Promise.all([
        collections.users.countDocuments(),
        collections.users.countDocuments({ role: "admin" }),
        collections.subscriptions.distinct("userId", activeFilter),
        collections.subscriptions.countDocuments(activeFilter),
        collections.subscriptions.countDocuments({ status: "cancelled", expiresAt: { $gt: now } }),
        collections.subscriptions.countDocuments({ status: "suspended" }),
        collections.subscriptions.countDocuments({ status: "expired" }),
        collections.subscriptions.countDocuments({ status: { $in: ACTIVE_STATUSES }, expiresAt: { $gt: now, $lte: soon } }),
        collections.payments.aggregate([{ $match: { status: "succeeded" } }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]).toArray(),
        collections.payments.aggregate([{ $match: { status: "succeeded", paidAt: { $gte: monthAgo } } }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]).toArray(),
        collections.payments
          .aggregate([
            { $match: { status: "succeeded" } },
            { $group: { _id: "$planId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
            { $sort: { total: -1 } },
          ])
          .toArray(),
      ]);

    const plans = await collections.subscriptionPlans.find({}).toArray();
    const planNames = Object.fromEntries(plans.map((plan) => [plan._id, plan.name]));
    const recentPayments = await collections.payments.find({ status: "succeeded" }).sort({ paidAt: -1 }).limit(10).toArray();
    const userIds = [...new Set(recentPayments.map((payment) => payment.userId))];
    const users = await collections.users.find({ _id: { $in: userIds } }, { projection: { fullName: 1, email: 1 } }).toArray();
    const userNames = Object.fromEntries(users.map((user) => [user._id, user]));

    res.json({
      users: { total: totalUsers, admins, premium: premiumUserIds.length, free: totalUsers - admins - premiumUserIds.length },
      subscriptions: { active, cancelled, suspended, expired, expiringSoon },
      revenue: {
        total: (revenue[0] && revenue[0].total) || 0,
        payments: (revenue[0] && revenue[0].count) || 0,
        last30Days: (recentRevenue[0] && recentRevenue[0].total) || 0,
        last30DaysPayments: (recentRevenue[0] && recentRevenue[0].count) || 0,
        byPlan: byPlan.map((row) => ({ planId: row._id, planName: planNames[row._id] || row._id, total: row.total, count: row.count })),
      },
      recentPayments: recentPayments.map((payment) => ({
        _id: payment._id,
        amount: payment.amount,
        currency: payment.currency,
        planId: payment.planId,
        planName: planNames[payment.planId] || payment.planId,
        testMode: Boolean(payment.testMode),
        paidAt: payment.paidAt,
        user: userNames[payment.userId] || { fullName: "Unknown", email: "" },
      })),
    });
  });

  router.get("/subscriptions", async (req, res) => {
    await expireDueSubscriptions();
    const status = req.query.status ? v.oneOf(req.query.status, ["active", "cancelled", "suspended", "expired"], "Unknown status.") : "";
    const page = v.intParam(req.query.page, { fallback: 1, min: 1, max: 10000 });
    const limit = v.intParam(req.query.limit, { fallback: 100, min: 1, max: 200 });
    const filter = status ? { status } : {};
    const total = await collections.subscriptions.countDocuments(filter);
    const subscriptions = await collections.subscriptions
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    const userIds = [...new Set(subscriptions.map((subscription) => subscription.userId))];
    const planIds = [...new Set(subscriptions.map((subscription) => subscription.planId))];
    const [users, plans] = await Promise.all([
      collections.users.find({ _id: { $in: userIds } }, { projection: { fullName: 1, email: 1, role: 1 } }).toArray(),
      collections.subscriptionPlans.find({ _id: { $in: planIds } }).toArray(),
    ]);
    const userById = Object.fromEntries(users.map((user) => [user._id, user]));
    const planById = Object.fromEntries(plans.map((plan) => [plan._id, plan]));
    res.json({
      items: subscriptions.map((subscription) => ({
        ...publicSubscription(subscription, planById[subscription.planId]),
        user: userById[subscription.userId] || { fullName: "Unknown", email: "", role: "user" },
      })),
      total,
      page,
      limit,
    });
  });

  router.post("/subscriptions/:subscriptionId/suspend", async (req, res) => {
    const subscriptionId = v.id(req.params.subscriptionId, { prefix: "sub", code: "SUBSCRIPTION_NOT_FOUND", message: "This subscription does not exist." });
    const now = new Date();
    const subscription = await collections.subscriptions.findOneAndUpdate(
      { _id: subscriptionId },
      { $set: { status: "suspended", suspendedAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!subscription) throw new ApiError("SUBSCRIPTION_NOT_FOUND", "This subscription does not exist.");
    await collections.subscriptionEvents.insertOne({
      _id: newId("sev"),
      userId: subscription.userId,
      subscriptionId,
      type: "admin_suspended",
      at: now,
      actorId: req.user._id,
      details: { planId: subscription.planId },
    });
    await audit(req, "admin_suspended_subscription", { level: "warn", details: { targetUserId: subscription.userId } });
    res.json(publicSubscription(subscription));
  });

  router.post("/subscriptions/:subscriptionId/activate", async (req, res) => {
    const subscriptionId = v.id(req.params.subscriptionId, { prefix: "sub", code: "SUBSCRIPTION_NOT_FOUND", message: "This subscription does not exist." });
    const subscription = await collections.subscriptions.findOne({ _id: subscriptionId });
    if (!subscription) throw new ApiError("SUBSCRIPTION_NOT_FOUND", "This subscription does not exist.");
    const plan = await collections.subscriptionPlans.findOne({ _id: subscription.planId });
    const now = new Date();
    const expiresAt = subscription.expiresAt > now ? subscription.expiresAt : addDays(now, plan ? plan.days : subscription.days || 30);
    const updated = await collections.subscriptions.findOneAndUpdate(
      { _id: subscriptionId },
      { $set: { status: "active", expiresAt, autoRenew: true, cancelledAt: null, suspendedAt: null, updatedAt: now } },
      { returnDocument: "after" }
    );
    await collections.subscriptionEvents.insertOne({
      _id: newId("sev"),
      userId: subscription.userId,
      subscriptionId,
      type: "admin_activated",
      at: now,
      actorId: req.user._id,
      details: { planId: subscription.planId, expiresAt },
    });
    await audit(req, "admin_activated_subscription", { level: "warn", details: { targetUserId: subscription.userId } });
    res.json(publicSubscription(updated, plan));
  });

  router.post("/subscriptions/:subscriptionId/deactivate", async (req, res) => {
    const subscriptionId = v.id(req.params.subscriptionId, { prefix: "sub", code: "SUBSCRIPTION_NOT_FOUND", message: "This subscription does not exist." });
    const now = new Date();
    const subscription = await collections.subscriptions.findOneAndUpdate(
      { _id: subscriptionId },
      { $set: { status: "expired", expiresAt: now, autoRenew: false, updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!subscription) throw new ApiError("SUBSCRIPTION_NOT_FOUND", "This subscription does not exist.");
    await collections.subscriptionEvents.insertOne({
      _id: newId("sev"),
      userId: subscription.userId,
      subscriptionId,
      type: "admin_deactivated",
      at: now,
      actorId: req.user._id,
      details: { planId: subscription.planId },
    });
    await audit(req, "admin_deactivated_subscription", { level: "warn", details: { targetUserId: subscription.userId } });
    res.json(publicSubscription(subscription));
  });

  // Gives a user a subscription without a payment (support gesture, demo, refund compensation).
  router.post("/users/:userId/subscription", async (req, res) => {
    const userId = v.id(req.params.userId, { prefix: "usr", code: "NOT_FOUND", message: "This user does not exist." });
    const body = v.onlyFields(req.body, ["planId"]);
    const planId = v.id(body.planId, { prefix: "plan", code: "PLAN_NOT_FOUND", message: "Choose a subscription plan." });
    const [user, plan] = await Promise.all([
      collections.users.findOne({ _id: userId }),
      collections.subscriptionPlans.findOne({ _id: planId }),
    ]);
    if (!user) throw new ApiError("NOT_FOUND", "This user does not exist.");
    if (!plan) throw new ApiError("PLAN_NOT_FOUND", "This subscription plan does not exist.");
    const now = new Date();
    const latest = await collections.subscriptions.findOne({ userId }, { sort: { createdAt: -1 } });
    const fields = {
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
      autoRenew: false,
      cancelledAt: null,
      suspendedAt: null,
      updatedAt: now,
    };
    let subscription;
    if (latest) {
      subscription = await collections.subscriptions.findOneAndUpdate({ _id: latest._id }, { $set: fields }, { returnDocument: "after" });
    } else {
      subscription = { _id: newId("sub"), userId, createdAt: now, ...fields };
      await collections.subscriptions.insertOne(subscription);
    }
    await collections.subscriptionEvents.insertOne({
      _id: newId("sev"),
      userId,
      subscriptionId: subscription._id,
      type: "admin_granted",
      at: now,
      actorId: req.user._id,
      details: { planId: plan._id, expiresAt: fields.expiresAt },
    });
    await audit(req, "admin_granted_subscription", { level: "warn", details: { targetUserId: userId, planId: plan._id } });
    res.json(publicSubscription(subscription, plan));
  });

  router.get("/plans", async (req, res) => {
    const plans = await collections.subscriptionPlans.find({}).sort({ sortOrder: 1, price: 1 }).toArray();
    res.json(plans.map(publicPlan));
  });

  router.post("/plans", async (req, res) => {
    const data = validatePlanInput(req.body);
    if (await collections.subscriptionPlans.findOne({ code: data.code })) {
      throw new ApiError("VALIDATION_ERROR", "A plan with this code already exists.");
    }
    const now = new Date();
    const plan = {
      _id: newId("plan"),
      currency: "TND",
      description: "",
      badge: "",
      active: true,
      sortOrder: 0,
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    await collections.subscriptionPlans.insertOne(plan);
    await audit(req, "admin_created_plan", { level: "warn", details: { planId: plan._id } });
    res.status(201).json(publicPlan(plan));
  });

  router.patch("/plans/:planId", async (req, res) => {
    const planId = v.id(req.params.planId, { prefix: "plan", code: "PLAN_NOT_FOUND", message: "This plan does not exist." });
    const data = validatePlanInput(req.body, { partial: true });
    if (Object.keys(data).length === 0) throw new ApiError("VALIDATION_ERROR", "Nothing to change.");
    if (data.code) {
      const other = await collections.subscriptionPlans.findOne({ code: data.code, _id: { $ne: planId } });
      if (other) throw new ApiError("VALIDATION_ERROR", "A plan with this code already exists.");
    }
    const plan = await collections.subscriptionPlans.findOneAndUpdate(
      { _id: planId },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!plan) throw new ApiError("PLAN_NOT_FOUND", "This plan does not exist.");
    await audit(req, "admin_updated_plan", { level: "warn", details: { planId } });
    res.json(publicPlan(plan));
  });

  return router;
}
