// The Express application: security layers first, then the API routes, then the built front-end.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { errorHandler, sendError } from "./errors.js";
import { csrfGuard, injectionGuard, noStore, requestId, requireAdmin, requireAuth, requireHttps, requirePremium } from "./security/middleware.js";
import { apiLimiter } from "./security/rateLimits.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/accounts.js";
import { categoryRoutes, transactionRoutes } from "./routes/transactions.js";
import { transferRoutes } from "./routes/transfers.js";
import { budgetRoutes } from "./routes/budgets.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { adminRoutes } from "./routes/admin.js";
import { subscriptionRoutes } from "./routes/subscriptions.js";
import { premiumRoutes } from "./routes/premium.js";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

export function createApp(config) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy); // needed to read the real visitor IP and protocol behind a proxy
  app.set("query parser", "simple"); // ?a[b]=c stays a plain string: no nested objects from the URL

  app.use(requestId);
  app.use(requireHttps(config));

  // Security headers. The Content-Security-Policy only allows scripts, styles and data from this
  // server, which blocks injected scripts (XSS) even if one ever slipped into a page.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.isProduction ? { maxAge: 365 * 24 * 3600, includeSubDomains: true } : false,
      referrerPolicy: { policy: "no-referrer" }, // reset links never leak through the Referer header
      crossOriginResourcePolicy: { policy: "same-origin" },
    })
  );

  // --- API ---
  app.use("/api", noStore, apiLimiter, express.json({ limit: "10kb", strict: true }), injectionGuard, csrfGuard(config));
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRoutes(config));
  app.use("/api/accounts", requireAuth, accountRoutes());
  app.use("/api/categories", requireAuth, categoryRoutes());
  app.use("/api/transactions", requireAuth, transactionRoutes());
  app.use("/api/transfers", requireAuth, transferRoutes());
  app.use("/api/budgets", requireAuth, budgetRoutes());
  app.use("/api/analytics", requireAuth, analyticsRoutes());
  app.use("/api/subscriptions", requireAuth, subscriptionRoutes(config));
  app.use("/api/premium", requireAuth, requirePremium, premiumRoutes());
  app.use("/api/admin", requireAuth, requireAdmin(config), adminRoutes());
  app.use("/api", (req, res) => sendError(res, "NOT_FOUND", "This API route does not exist."));

  // --- Front-end (after `npm run build`). In development Vite serves it instead. ---
  if (existsSync(DIST)) {
    app.use(express.static(DIST, { index: false, maxAge: "1h" }));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.sendFile("index.html", { root: DIST });
    });
  }

  app.use(errorHandler);
  return app;
}
