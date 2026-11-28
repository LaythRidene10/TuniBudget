// MongoDB connection, collections and indexes.
import dns from "node:dns";
import { MongoClient } from "mongodb";

export let client = null;
export const collections = {};

const NAMES = [
  "users",
  "accounts",
  "categories",
  "transactions",
  "budgets",
  "subscriptionPlans",
  "subscriptions",
  "payments",
  "subscriptionEvents",
  "savingsGoals",
  "sessions",
  "passwordResets",
  "loginThrottle",
  "auditLogs",
  "idempotencyKeys",
];

function newClient(config) {
  return new MongoClient(config.mongoUri, {
    appName: "tunibudget",
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });
}

// mongodb+srv:// addresses need a DNS "SRV" lookup. Some home routers and internet providers
// refuse it (error "querySrv ECONNREFUSED"). In that case, retry once through public DNS servers.
function isSrvLookupError(err) {
  return err && err.syscall === "querySrv" && ["ECONNREFUSED", "ETIMEOUT", "ESERVFAIL", "ENOTFOUND"].includes(err.code);
}

export async function connect(config) {
  client = newClient(config);
  try {
    await client.connect();
  } catch (err) {
    if (!config.mongoUri.startsWith("mongodb+srv://") || !isSrvLookupError(err)) throw err;
    console.warn("[db] Your network's DNS refused the MongoDB address lookup. Retrying with public DNS (1.1.1.1, 8.8.8.8).");
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
    dns.promises.setServers(["1.1.1.1", "8.8.8.8"]);
    client = newClient(config);
    await client.connect();
  }
  const db = client.db(config.mongoDb);
  for (const name of NAMES) collections[name] = db.collection(name);

  // Transfers need multi-document transactions, which only work on a replica set (Atlas always is one).
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    throw new Error(
      "MongoDB is running as a standalone server, so transactions are not available. " +
        "Use MongoDB Atlas, or start mongod with --replSet rs0 and run rs.initiate() once."
    );
  }

  await createIndexes();
  return db;
}

async function createIndexes() {
  const c = collections;
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.accounts.createIndex({ userId: 1, status: 1 }),
    c.transactions.createIndex({ userId: 1, date: -1, seq: -1 }),
    c.transactions.createIndex({ accountId: 1, date: -1 }),
    c.budgets.createIndex({ userId: 1, categoryId: 1, month: 1 }, { unique: true }),
    c.subscriptionPlans.createIndex({ sortOrder: 1, createdAt: 1 }),
    c.subscriptions.createIndex({ userId: 1, createdAt: -1 }),
    c.subscriptions.createIndex({ userId: 1, status: 1, expiresAt: -1 }),
    c.subscriptions.createIndex({ status: 1, expiresAt: 1 }),
    c.payments.createIndex({ userId: 1, paidAt: -1 }),
    c.payments.createIndex({ status: 1, paidAt: -1 }),
    c.subscriptionEvents.createIndex({ userId: 1, at: -1 }),
    c.subscriptionEvents.createIndex({ subscriptionId: 1, at: -1 }),
    c.savingsGoals.createIndex({ userId: 1, status: 1, createdAt: -1 }),
    // Expired documents are deleted by MongoDB itself (TTL indexes).
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.sessions.createIndex({ userId: 1 }),
    c.passwordResets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.passwordResets.createIndex({ userId: 1 }),
    c.loginThrottle.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.idempotencyKeys.createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 }),
    c.auditLogs.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }),
    c.auditLogs.createIndex({ ip: 1, event: 1, at: -1 }),
    c.auditLogs.createIndex({ level: 1, at: -1 }),
  ]);
}

/** Runs `work(session)` inside one ACID transaction. MongoDB retries it on a write conflict. */
export async function inTransaction(work) {
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" }
    );
    return result;
  } finally {
    await session.endSession();
  }
}
