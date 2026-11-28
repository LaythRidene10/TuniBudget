// Reads and checks the environment variables once, at start-up.
// The server refuses to start when a required value is missing or unsafe, and it never prints secret values.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

const PLACEHOLDERS = ["change-me", "changeme", "secret", "password", "your-secret", "replace-me"];

function int(env, name, fallback, { min, max }, errors) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return value;
}

/** Builds the config from an env object. Exported separately so it can be tested without process.env. */
export function buildConfig(env) {
  const errors = [];
  const warnings = [];
  const read = (name) => (env[name] === undefined ? "" : String(env[name]).trim());

  const nodeEnv = read("NODE_ENV") || "development";
  if (!["development", "production", "test"].includes(nodeEnv)) errors.push("NODE_ENV must be development, production or test.");
  const isProduction = nodeEnv === "production";

  // --- MongoDB ---
  const mongoUri = read("MONGODB_URI");
  if (!mongoUri) {
    errors.push("MONGODB_URI is missing (for example mongodb+srv://user:password@cluster.mongodb.net).");
  } else if (!/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
    errors.push("MONGODB_URI must start with mongodb:// or mongodb+srv://.");
  } else if (isProduction) {
    const local = /@?(localhost|127\.0\.0\.1|\[::1\])/.test(mongoUri);
    const hasCredentials = /^mongodb(\+srv)?:\/\/[^/@]+:[^/@]+@/.test(mongoUri);
    const usesTls = mongoUri.startsWith("mongodb+srv://") || /[?&](tls|ssl)=true/i.test(mongoUri);
    if (!hasCredentials) errors.push("In production, MONGODB_URI must contain a database user and password.");
    if (!usesTls && !local) errors.push("In production, MONGODB_URI must use TLS (mongodb+srv:// or ?tls=true).");
  }
  const mongoDb = read("MONGODB_DB") || "tunibudget";
  if (!/^[A-Za-z0-9_-]{1,38}$/.test(mongoDb)) errors.push("MONGODB_DB may only contain letters, digits, - and _.");

  // --- Secrets ---
  const sessionSecret = read("SESSION_SECRET");
  if (!sessionSecret) {
    errors.push("SESSION_SECRET is missing. Create one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"");
  } else if (sessionSecret.length < 32) {
    errors.push("SESSION_SECRET is too short: use at least 32 random characters.");
  } else if (PLACEHOLDERS.some((p) => sessionSecret.toLowerCase().includes(p))) {
    errors.push("SESSION_SECRET still contains a placeholder value: replace it with a random secret.");
  }

  // --- Public URL of the app (used for the Origin check and the reset links) ---
  const appUrlText = read("APP_URL") || (isProduction ? "" : "http://localhost:5173");
  let appOrigin = "";
  if (!appUrlText) {
    errors.push("APP_URL is missing (the public address of the app, for example https://tunibudget.example.com).");
  } else {
    try {
      const url = new URL(appUrlText);
      appOrigin = url.origin;
      if (isProduction && url.protocol !== "https:") errors.push("In production, APP_URL must start with https://.");
    } catch {
      errors.push("APP_URL is not a valid address.");
    }
  }

  // --- HTTPS ---
  const tlsCertFile = read("TLS_CERT_FILE");
  const tlsKeyFile = read("TLS_KEY_FILE");
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) errors.push("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.");
  if (tlsCertFile && !existsSync(tlsCertFile)) errors.push("TLS_CERT_FILE points to a file that does not exist.");
  if (tlsKeyFile && !existsSync(tlsKeyFile)) errors.push("TLS_KEY_FILE points to a file that does not exist.");
  // No payment provider is connected in this project. "test" confirms a payment immediately and
  // labels every payment record as test data; "disabled" closes the checkout entirely.
  const paymentMode = read("PAYMENT_MODE") || "test";
  if (!["test", "disabled"].includes(paymentMode)) errors.push("PAYMENT_MODE must be test or disabled.");

  const trustProxy = int(env, "TRUST_PROXY", 0, { min: 0, max: 5 }, errors);
  if (isProduction && !tlsCertFile && trustProxy === 0) {
    errors.push("In production, HTTPS is required: set TLS_CERT_FILE/TLS_KEY_FILE, or TRUST_PROXY=1 when a host or proxy terminates HTTPS for you.");
  }

  const config = {
    nodeEnv,
    isProduction,
    port: int(env, "PORT", 4000, { min: 1, max: 65535 }, errors),
    mongoUri,
    mongoDb,
    sessionSecret,
    appOrigin,
    appUrl: appOrigin,
    tlsCertFile,
    tlsKeyFile,
    paymentMode,
    trustProxy,
    sessionHours: int(env, "SESSION_TTL_HOURS", 8, { min: 1, max: 72 }, errors),
    sessionIdleMinutes: int(env, "SESSION_IDLE_MINUTES", 30, { min: 5, max: 1440 }, errors),
    resetTokenMinutes: int(env, "RESET_TOKEN_MINUTES", 15, { min: 5, max: 60 }, errors),
    adminIpAllowlist: read("ADMIN_IP_ALLOWLIST")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
    alertWebhookUrl: read("ALERT_WEBHOOK_URL"),
  };

  if (config.alertWebhookUrl && !config.alertWebhookUrl.startsWith("https://")) {
    errors.push("ALERT_WEBHOOK_URL must start with https://.");
  }
  if (isProduction && config.adminIpAllowlist.length === 0) {
    warnings.push("ADMIN_IP_ALLOWLIST is empty: admin routes are reachable from any IP (they still need an admin login).");
  }
  if (isProduction && !config.alertWebhookUrl) {
    warnings.push("ALERT_WEBHOOK_URL is empty: suspicious activity is only written to the logs and the database.");
  }
  if (isProduction && config.paymentMode === "test") {
    warnings.push("PAYMENT_MODE=test: subscription payments are simulated. Connect a real provider before charging users.");
  }

  return { config, errors, warnings };
}

/** Loads .env (if present), checks it, and stops the process with a clear list of problems. */
export function loadConfig() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const { config, errors, warnings } = buildConfig(process.env);
  for (const warning of warnings) console.warn("[config] warning: " + warning);
  if (errors.length) {
    console.error("[config] The server cannot start. Fix these environment variables (see .env.example):");
    for (const error of errors) console.error("  - " + error);
    process.exit(1);
  }
  return Object.freeze(config);
}
