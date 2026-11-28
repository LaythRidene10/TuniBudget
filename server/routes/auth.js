// Register, log in, log out, current user, and password reset.
import express from "express";
import { collections } from "../db.js";
import { ApiError } from "../errors.js";
import { sendPasswordResetEmail } from "../mailer.js";
import { audit } from "../security/audit.js";
import { burnTime, hashPassword, needsRehash, verifyPassword } from "../security/password.js";
import { loginLimiter, registerLimiter, resetLimiter } from "../security/rateLimits.js";
import { endAllSessions, endSession, startSession } from "../security/sessions.js";
import { requireAuth } from "../security/middleware.js";
import { newId, randomToken, sha256 } from "../security/tokens.js";
import { subscriptionState } from "../subscriptions.js";
import * as v from "../validate.js";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

// The role sent to the browser is a display value derived from the database on every call:
// admins keep the admin role, a user with an active subscription is "premium", the others "user".
export async function publicUser(user) {
  const state = await subscriptionState(user._id);
  const baseRole = user.role === "admin" ? "admin" : "user";
  return {
    _id: user._id,
    fullName: user.fullName,
    email: user.email,
    role: baseRole === "admin" ? "admin" : state.isPremium ? "premium" : "user",
    baseRole,
    isPremium: state.isPremium,
    subscription: state.subscription,
  };
}

// Failed logins are counted per email (even for emails that do not exist, so the lock does not
// reveal which emails are registered). After 5 failures the email is locked for 15 minutes.
async function lockedUntil(mail) {
  const entry = await collections.loginThrottle.findOne({ _id: sha256(mail) });
  return entry && entry.lockedUntil && entry.lockedUntil > new Date() ? entry.lockedUntil : null;
}

async function recordFailure(req, mail, userId) {
  const now = new Date();
  const entry = await collections.loginThrottle.findOneAndUpdate(
    { _id: sha256(mail) },
    { $inc: { failures: 1 }, $set: { expiresAt: new Date(now.getTime() + 24 * 3600 * 1000) } },
    { upsert: true, returnDocument: "after" }
  );
  await audit(req, "login_failed", { level: "warn", userId, details: { failures: entry.failures } });
  if (entry.failures >= MAX_FAILURES) {
    await collections.loginThrottle.updateOne(
      { _id: sha256(mail) },
      { $set: { failures: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) } }
    );
    await audit(req, "account_locked", { level: "warn", userId, details: { minutes: LOCK_MINUTES } });
  }
}

export function authRoutes(config) {
  const router = express.Router();

  router.post("/register", registerLimiter, async (req, res) => {
    const body = v.onlyFields(req.body, ["fullName", "email", "password"]);
    const fullName = v.text(body.fullName, { min: 2, max: 80, message: "Enter your full name (2 to 80 characters)." });
    const mail = v.email(body.email);
    const password = v.newPassword(body.password, { email: mail });

    const now = new Date();
    const user = {
      _id: newId("usr"),
      fullName,
      email: mail,
      passwordHash: await hashPassword(password),
      role: "user", // never taken from the request: admins are made with `npm run make-admin`
      createdAt: now,
      passwordChangedAt: now,
      lastLoginAt: now, // registering logs the new user in
    };
    try {
      await collections.users.insertOne(user);
    } catch (err) {
      if (err.code === 11000) throw new ApiError("EMAIL_TAKEN", "An account with this email already exists.");
      throw err;
    }
    await collections.accounts.insertOne({
      _id: newId("acc"),
      userId: user._id,
      name: "Checking account",
      type: "checking",
      openingBalance: 0,
      balance: 0,
      currency: "TND",
      status: "active",
      closedAt: null,
      createdAt: now,
    });
    await audit(req, "user_registered", { userId: user._id });
    await startSession(req, res, user);
    res.status(201).json({ user: await publicUser(user) });
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const body = v.onlyFields(req.body, ["email", "password"]);
    const password = v.loginPassword(body.password);
    let mail;
    try {
      mail = v.email(body.email);
    } catch {
      throw new ApiError("INVALID_CREDENTIALS", "Incorrect email or password.");
    }

    const until = await lockedUntil(mail);
    if (until) {
      await audit(req, "login_failed", { level: "warn", details: { reason: "locked" } });
      const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));
      throw new ApiError("ACCOUNT_LOCKED", `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`);
    }

    const user = await collections.users.findOne({ email: mail });
    const ok = user && !user.disabled ? await verifyPassword(password, user.passwordHash) : (await burnTime(password), false);
    if (!ok) {
      await recordFailure(req, mail, user ? user._id : null);
      throw new ApiError("INVALID_CREDENTIALS", "Incorrect email or password.");
    }

    await collections.loginThrottle.deleteOne({ _id: sha256(mail) });
    if (needsRehash(user.passwordHash)) {
      await collections.users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
    }
    await collections.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    await startSession(req, res, user);
    await audit(req, "login_succeeded", { userId: user._id });
    res.json({ user: await publicUser(user) });
  });

  router.post("/logout", async (req, res) => {
    await endSession(req, res);
    res.status(204).end();
  });

  router.get("/me", requireAuth, async (req, res) => {
    res.json({ user: await publicUser(req.user) });
  });

  // Step 1: ask for a link. The answer is always the same, so nobody can test which emails exist.
  router.post("/password-reset/request", resetLimiter, async (req, res) => {
    const body = v.onlyFields(req.body, ["email"]);
    const mail = v.email(body.email);
    const user = await collections.users.findOne({ email: mail });
    if (user && !user.disabled) {
      const token = randomToken(32);
      const now = new Date();
      await collections.passwordResets.deleteMany({ userId: user._id }); // only the newest link works
      await collections.passwordResets.insertOne({
        _id: sha256(token), // only the fingerprint is stored
        userId: user._id,
        createdAt: now,
        expiresAt: new Date(now.getTime() + config.resetTokenMinutes * 60 * 1000),
        usedAt: null,
        ip: req.ip,
      });
      await sendPasswordResetEmail({
        to: user.email,
        fullName: user.fullName,
        link: `${config.appUrl}/?reset=${token}`,
        minutes: config.resetTokenMinutes,
      });
      await audit(req, "password_reset_requested", { userId: user._id });
    } else {
      await audit(req, "password_reset_requested", { details: { unknownEmail: true } });
    }
    res.json({ message: "If an account exists for this email, a reset link is on its way. It expires in " + config.resetTokenMinutes + " minutes." });
  });

  // Step 2: use the link. It works once, before it expires, then every session of the user is closed.
  router.post("/password-reset/confirm", resetLimiter, async (req, res) => {
    const body = v.onlyFields(req.body, ["token", "password"]);
    const token = v.token(body.token);
    const password = v.newPassword(body.password); // checked first, so a weak password does not burn the link
    const now = new Date();
    // Atomic "check and mark used": two clicks on the same link cannot both succeed.
    const reset = await collections.passwordResets.findOneAndUpdate(
      { _id: sha256(token), usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } }
    );
    if (!reset) {
      await audit(req, "reset_link_invalid", { level: "warn" });
      throw new ApiError("RESET_LINK_INVALID", "This reset link is invalid or has expired. Ask for a new one.");
    }
    const user = await collections.users.findOne({ _id: reset.userId });
    if (!user) throw new ApiError("RESET_LINK_INVALID", "This reset link is invalid or has expired. Ask for a new one.");

    await collections.users.updateOne(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(password), passwordChangedAt: now } }
    );
    await collections.passwordResets.deleteMany({ userId: user._id });
    await collections.loginThrottle.deleteOne({ _id: sha256(user.email) });
    const closed = await endAllSessions(user._id);
    await audit(req, "password_reset_completed", { userId: user._id, details: { sessionsClosed: closed } });
    res.json({ message: "Your password has been changed. Log in with your new password." });
  });

  return router;
}
