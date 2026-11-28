// Creates (or refreshes) the three ready-to-use demo accounts:
//   admin@demo.com    AdminDemo123!    admin role
//   premium@demo.com  PremiumDemo123!  active yearly Premium subscription
//   user@demo.com     UserDemo123!     free account
//
//   npm run seed:demo
//
// Only the data of these three demo users is replaced. Real users, their accounts and their
// transactions are never touched. Refused in production, because the passwords are public.
import { loadConfig } from "../config.js";
import { client, collections, connect } from "../db.js";
import { hashPassword } from "../security/password.js";
import { addDays, ensureDefaultPlans } from "../subscriptions.js";
import { categories as seedCategories } from "../../src/data.js";

const DEMO_USERS = [
  { _id: "usr_demo_admin", fullName: "Demo Admin", email: "admin@demo.com", password: "AdminDemo123!", role: "admin" },
  { _id: "usr_demo_premium", fullName: "Leila Ben Amor", email: "premium@demo.com", password: "PremiumDemo123!", role: "user" },
  { _id: "usr_demo_user", fullName: "Youssef Trabelsi", email: "user@demo.com", password: "UserDemo123!", role: "user" },
];

const DEMO_ACCOUNTS = {
  usr_demo_admin: [{ _id: "acc_demo_admin_checking", name: "Checking account", type: "checking", openingBalance: 0 }],
  usr_demo_premium: [
    { _id: "acc_demo_premium_checking", name: "Checking account", type: "checking", openingBalance: 3200000 },
    { _id: "acc_demo_premium_savings", name: "Savings", type: "savings", openingBalance: 12000000 },
    { _id: "acc_demo_premium_cash", name: "Cash", type: "cash", openingBalance: 250000 },
  ],
  usr_demo_user: [
    { _id: "acc_demo_user_checking", name: "Checking account", type: "checking", openingBalance: 1200000 },
    { _id: "acc_demo_user_savings", name: "Savings", type: "savings", openingBalance: 3500000 },
  ],
};

const NOW = new Date();

function at(monthsAgo, day, hour = 10) {
  const target = new Date(NOW.getFullYear(), NOW.getMonth() - monthsAgo, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  target.setHours(hour, 0, 0, 0);
  return target > NOW ? new Date(NOW.getTime() - 60000) : target;
}

function monthKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function futureDate(months, day = 1) {
  return new Date(NOW.getFullYear(), NOW.getMonth() + months, day).toISOString().slice(0, 10);
}

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return prefix + "_demo_" + String(counter).padStart(4, "0");
}

function tx(accountId, type, amount, categoryId, description, date, transferId = null) {
  return { _id: nextId("txn"), accountId, type, amount, categoryId, description, date, transferId };
}

function transferPair(fromId, toId, amount, fromName, toName, date) {
  const transferId = nextId("trf");
  return [
    tx(fromId, "debit", amount, "cat_transfer", "Transfer to " + toName, date, transferId),
    tx(toId, "credit", amount, "cat_transfer", "Transfer from " + fromName, date, transferId),
  ];
}

/** Several months of realistic movements for one profile. */
function buildHistory({ checking, savings, cash, months, salary, rent, withFreelance }) {
  const rows = [];
  for (let m = months; m >= 0; m -= 1) {
    rows.push(tx(checking, "credit", salary, "cat_salary", "Salary", at(m, 1, 8)));
    rows.push(tx(checking, "debit", rent, "cat_rent", "Rent", at(m, 2, 9)));
    rows.push(tx(checking, "debit", 185000 + ((m * 7000) % 40000), "cat_bills", "Electricity and water", at(m, 4, 10)));
    rows.push(tx(checking, "debit", 29900, "cat_bills", "Mobile internet plan", at(m, 5, 10)));
    rows.push(tx(checking, "debit", 45000, "cat_transport", "Monthly transport pass", at(m, 6, 10)));
    rows.push(tx(checking, "debit", 92000 + ((m * 9000) % 50000), "cat_food", "Groceries", at(m, 7, 10)));
    rows.push(tx(checking, "debit", 54000 + ((m * 5000) % 30000), "cat_leisure", "Cinema and coffee", at(m, 10, 18)));
    rows.push(tx(checking, "debit", 84000 + ((m * 8000) % 40000), "cat_food", "Weekly groceries", at(m, 14, 10)));
    rows.push(tx(checking, "debit", 138000 + ((m * 6000) % 60000), "cat_shopping", "Clothes and shoes", at(m, 16, 15)));
    rows.push(tx(checking, "debit", 41000 + ((m * 3000) % 20000), "cat_health", "Pharmacy", at(m, 18, 11)));
    rows.push(tx(checking, "debit", 38000 + ((m * 4000) % 25000), "cat_leisure", "Weekend outing", at(m, 20, 16)));
    rows.push(tx(checking, "debit", 88000 + ((m * 5000) % 35000), "cat_food", "Restaurant dinner", at(m, 24, 20)));
    rows.push(...transferPair(checking, savings, 400000, "Checking account", "Savings", at(m, 25, 10)));
    if (cash) {
      rows.push(...transferPair(checking, cash, 100000, "Checking account", "Cash", at(m, 11, 12)));
      rows.push(tx(cash, "debit", 18000 + ((m * 2000) % 12000), "cat_food", "Street food", at(m, 13, 13)));
      rows.push(tx(cash, "debit", 9000 + ((m * 1000) % 6000), "cat_transport", "Taxi (cash)", at(m, 22, 14)));
    }
    if (withFreelance && m % 2 === 0) {
      rows.push(tx(checking, "credit", 350000, "cat_freelance", "Freelance project", at(m, 12, 9)));
    }
  }
  return rows;
}

const PREMIUM_TRANSACTIONS = buildHistory({
  checking: "acc_demo_premium_checking",
  savings: "acc_demo_premium_savings",
  cash: "acc_demo_premium_cash",
  months: 8,
  salary: 2400000,
  rent: 750000,
  withFreelance: true,
});

const NORMAL_TRANSACTIONS = buildHistory({
  checking: "acc_demo_user_checking",
  savings: "acc_demo_user_savings",
  cash: null,
  months: 4,
  salary: 1600000,
  rent: 550000,
  withFreelance: false,
});

function ledger(userId, transactions) {
  const ordered = transactions
    .map((t, index) => ({ ...t, seq: index + 1 }))
    .sort((a, b) => a.date - b.date || a.seq - b.seq)
    .map((t, index) => ({ ...t, userId, seq: index + 1 }));
  return ordered;
}

function balancesFor(accounts, transactions) {
  const balances = Object.fromEntries(accounts.map((account) => [account._id, account.openingBalance]));
  for (const t of transactions) balances[t.accountId] += t.type === "credit" ? t.amount : -t.amount;
  return balances;
}

const DEMO_BUDGETS = {
  usr_demo_premium: [
    ["cat_food", 500000],
    ["cat_transport", 150000],
    ["cat_bills", 260000],
    ["cat_leisure", 160000],
    ["cat_shopping", 220000],
    ["cat_health", 100000],
  ],
  usr_demo_user: [
    ["cat_food", 320000],
    ["cat_transport", 110000],
    ["cat_bills", 200000],
    ["cat_leisure", 90000],
  ],
};

const DEMO_GOALS = [
  {
    _id: "goal_demo_emergency",
    userId: "usr_demo_premium",
    name: "Emergency fund",
    targetAmount: 6000000,
    savedAmount: 3200000,
    targetDate: futureDate(10),
    note: "Six months of essential expenses.",
    status: "active",
  },
  {
    _id: "goal_demo_trip",
    userId: "usr_demo_premium",
    name: "Trip to Istanbul",
    targetAmount: 2500000,
    savedAmount: 900000,
    targetDate: futureDate(6),
    note: "Flights and hotel for two.",
    status: "active",
  },
  {
    _id: "goal_demo_laptop",
    userId: "usr_demo_premium",
    name: "New laptop",
    targetAmount: 1800000,
    savedAmount: 1800000,
    targetDate: futureDate(-1),
    note: "Already fully saved.",
    status: "achieved",
  },
];

const config = loadConfig();
if (config.isProduction) {
  console.error("[seed:demo] Refused: never load demo users with known passwords into a production database.");
  process.exit(1);
}

await connect(config);
try {
  await ensureDefaultPlans();

  // Categories are shared by every user: add the missing ones, never delete existing ones.
  for (const category of seedCategories) {
    await collections.categories.updateOne(
      { _id: category._id },
      { $setOnInsert: { name: category.name, kind: category.kind } },
      { upsert: true }
    );
  }

  const now = new Date();
  const resolvedUsers = {};
  for (const demo of DEMO_USERS) {
    const passwordHash = await hashPassword(demo.password);
    const existing = await collections.users.findOne({ email: demo.email });
    if (existing) {
      await collections.users.updateOne(
        { _id: existing._id },
        { $set: { fullName: demo.fullName, passwordHash, role: demo.role, disabled: false } }
      );
      resolvedUsers[demo._id] = { ...demo, _id: existing._id };
    } else {
      await collections.users.insertOne({
        _id: demo._id,
        fullName: demo.fullName,
        email: demo.email,
        passwordHash,
        role: demo.role,
        createdAt: now,
        passwordChangedAt: now,
        lastLoginAt: null,
      });
      resolvedUsers[demo._id] = demo;
    }
  }

  for (const demo of DEMO_USERS) {
    const userId = resolvedUsers[demo._id]._id;
    // Replace only this demo user's data. Real users and other demo users are untouched.
    await Promise.all([
      collections.accounts.deleteMany({ userId }),
      collections.transactions.deleteMany({ userId }),
      collections.budgets.deleteMany({ userId }),
      collections.savingsGoals.deleteMany({ userId }),
      collections.subscriptions.deleteMany({ userId }),
      collections.payments.deleteMany({ userId }),
      collections.subscriptionEvents.deleteMany({ userId }),
    ]);

    const accounts = (DEMO_ACCOUNTS[demo._id] || []).map((account) => ({
      ...account,
      userId,
      openingBalance: account.openingBalance,
      currency: "TND",
      status: "active",
      closedAt: null,
      createdAt: now,
    }));
    const source = demo._id === "usr_demo_premium" ? PREMIUM_TRANSACTIONS : demo._id === "usr_demo_user" ? NORMAL_TRANSACTIONS : [];
    const transactions = ledger(userId, source);
    const balances = balancesFor(accounts, transactions);

    if (accounts.length) {
      await collections.accounts.insertMany(accounts.map((account) => ({ ...account, balance: balances[account._id] })));
    }
    if (transactions.length) await collections.transactions.insertMany(transactions);

    const budgets = (DEMO_BUDGETS[demo._id] || []).map(([categoryId, limit], index) => ({
      _id: "bud_demo_" + demo._id.replace("usr_demo_", "") + "_" + String(index + 1).padStart(2, "0"),
      userId,
      categoryId,
      month: monthKey(now),
      limit,
    }));
    if (budgets.length) await collections.budgets.insertMany(budgets);

    if (demo._id === "usr_demo_premium") {
      const startedAt = at(2, 15);
      const expiresAt = addDays(startedAt, 365);
      const payment = {
        _id: "pay_demo_premium",
        userId,
        subscriptionId: "sub_demo_premium",
        planId: "plan_yearly",
        amount: 120000,
        currency: "TND",
        provider: "test",
        providerRef: "test_demo_premium",
        status: "succeeded",
        testMode: true,
        paidAt: startedAt,
        createdAt: startedAt,
      };
      await collections.subscriptions.insertOne({
        _id: "sub_demo_premium",
        userId,
        planId: "plan_yearly",
        planCode: "yearly",
        planName: "Yearly Premium",
        price: 120000,
        currency: "TND",
        interval: "year",
        days: 365,
        status: "active",
        startedAt,
        expiresAt,
        autoRenew: true,
        cancelledAt: null,
        suspendedAt: null,
        lastPaymentId: payment._id,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      await collections.payments.insertOne(payment);
      await collections.subscriptionEvents.insertOne({
        _id: "sev_demo_premium_purchase",
        userId,
        subscriptionId: "sub_demo_premium",
        type: "purchased",
        at: startedAt,
        actorId: null,
        details: { planId: "plan_yearly", paymentId: payment._id, testMode: true },
      });
      await collections.savingsGoals.insertMany(
        DEMO_GOALS.map((goal) => ({
          ...goal,
          userId,
          targetDate: goal.targetDate,
          createdAt: now,
          updatedAt: now,
          lastContributionAt: now,
        }))
      );
    }
  }

  console.log("[seed:demo] Done. Only the three demo users were replaced; real users were kept.");
  console.log("[seed:demo] admin@demo.com / AdminDemo123!");
  console.log("[seed:demo] premium@demo.com / PremiumDemo123!");
  console.log("[seed:demo] user@demo.com / UserDemo123!");
} finally {
  await client.close();
}
