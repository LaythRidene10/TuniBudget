// Non-destructive database migration for the premium release.
//   npm run migrate
// Adds the new collections and indexes, creates the two default plans when they are missing, and
// gives a role to users created before roles existed. Existing users and financial data are kept.
import { loadConfig } from "../config.js";
import { client, collections, connect } from "../db.js";
import { ensureDefaultPlans } from "../subscriptions.js";

const config = loadConfig();

await connect(config);
try {
  await ensureDefaultPlans();
  const roleFix = await collections.users.updateMany(
    { $or: [{ role: { $exists: false } }, { role: null }] },
    { $set: { role: "user" } }
  );
  const plans = await collections.subscriptionPlans.countDocuments();
  console.log(`[migrate] Done. Plans: ${plans}. Users given the default role: ${roleFix.modifiedCount}.`);
  console.log("[migrate] New collections: subscriptionPlans, subscriptions, payments, subscriptionEvents, savingsGoals.");
} finally {
  await client.close();
}
