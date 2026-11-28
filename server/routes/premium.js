// Premium-only endpoints. Mounted behind requireAuth + requirePremium, so every call is checked
// against the subscriptions collection: hiding a button in the browser is never enough.
import express from "express";
import { collections } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../security/tokens.js";
import * as v from "../validate.js";
import { categoryNames, monthTotals } from "./analytics.js";
import { findOwnedAccount } from "./accounts.js";

const pad = (n) => String(n).padStart(2, "0");
const monthKey = (date) => date.getFullYear() + "-" + pad(date.getMonth() + 1);
const dayKey = (date) => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());

function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function startOfDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function endOfDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function percentChange(current, previous) {
  if (!previous) return null;
  return (current - previous) / previous;
}

/** Income, expenses and net per month between two dates, excluding transfers. */
async function monthlySeries(userId, start, end) {
  const rows = await collections.transactions
    .aggregate([
      { $match: { userId, transferId: null, date: { $gte: start, $lt: end } } },
      { $group: { _id: { month: { $dateToString: { format: "%Y-%m", date: "$date" } }, type: "$type" }, total: { $sum: "$amount" } } },
    ])
    .toArray();
  const map = {};
  for (const row of rows) {
    const month = row._id.month;
    if (!map[month]) map[month] = { income: 0, expenses: 0 };
    if (row._id.type === "credit") map[month].income += row.total;
    else map[month].expenses += row.total;
  }
  return map;
}

function fillMonths(keys, map) {
  return keys.map((month) => {
    const values = map[month] || { income: 0, expenses: 0 };
    return {
      month,
      income: values.income,
      expenses: values.expenses,
      net: values.income - values.expenses,
      savingsRate: values.income > 0 ? (values.income - values.expenses) / values.income : null,
    };
  });
}

function sumTotals(months) {
  const income = months.reduce((sum, m) => sum + m.income, 0);
  const expenses = months.reduce((sum, m) => sum + m.expenses, 0);
  return { income, expenses, net: income - expenses, savingsRate: income > 0 ? (income - expenses) / income : null };
}

function publicGoal(goal) {
  const percent = goal.targetAmount > 0 ? Math.min(100, Math.floor((goal.savedAmount / goal.targetAmount) * 100)) : 0;
  return {
    _id: goal._id,
    name: goal.name,
    targetAmount: goal.targetAmount,
    savedAmount: goal.savedAmount,
    remaining: Math.max(0, goal.targetAmount - goal.savedAmount),
    percent,
    targetDate: goal.targetDate || null,
    note: goal.note || "",
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    lastContributionAt: goal.lastContributionAt || null,
  };
}

async function reportData(userId, from, to) {
  const filter = { userId, date: { $gte: startOfDay(from), $lte: endOfDay(to) } };
  const [transactions, accounts, names] = await Promise.all([
    collections.transactions.find(filter).sort({ date: 1, seq: 1 }).limit(5000).toArray(),
    collections.accounts.find({ userId }).toArray(),
    categoryNames(),
  ]);
  const accountName = Object.fromEntries(accounts.map((a) => [a._id, a.name]));
  const items = transactions.map((t) => ({
    _id: t._id,
    date: t.date,
    description: t.description,
    accountId: t.accountId,
    accountName: accountName[t.accountId] || "Unknown",
    categoryId: t.categoryId,
    categoryName: names[t.categoryId] || "Unknown",
    type: t.type,
    amount: t.amount,
    transferId: t.transferId,
    balanceAfter: t.balanceAfter,
  }));

  let income = 0;
  let expenses = 0;
  const byCategory = {};
  const byAccount = {};
  const byMonth = {};
  for (const t of items) {
    const key = monthKey(new Date(t.date));
    if (!byMonth[key]) byMonth[key] = { month: key, income: 0, expenses: 0 };
    if (!byAccount[t.accountId]) byAccount[t.accountId] = { accountId: t.accountId, accountName: t.accountName, income: 0, expenses: 0 };
    if (t.transferId) continue;
    if (t.type === "credit") {
      income += t.amount;
      byAccount[t.accountId].income += t.amount;
      byMonth[key].income += t.amount;
    } else {
      expenses += t.amount;
      byAccount[t.accountId].expenses += t.amount;
      byMonth[key].expenses += t.amount;
      byCategory[t.categoryId] = byCategory[t.categoryId] || { categoryId: t.categoryId, categoryName: t.categoryName, total: 0 };
      byCategory[t.categoryId].total += t.amount;
    }
  }

  return {
    from,
    to,
    items,
    summary: {
      income,
      expenses,
      net: income - expenses,
      savingsRate: income > 0 ? (income - expenses) / income : null,
      count: items.length,
    },
    byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
    byAccount: Object.values(byAccount).map((a) => ({ ...a, net: a.income - a.expenses })).sort((a, b) => b.net - a.net),
    byMonth: Object.values(byMonth).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? "" : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function premiumRoutes() {
  const router = express.Router();

  router.get("/analytics", async (req, res) => {
    const months = v.intParam(req.query.months, { fallback: 12, min: 2, max: 24 });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const keys = [];
    for (let i = 0; i < months; i += 1) keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1)));
    const series = fillMonths(keys, await monthlySeries(req.user._id, start, end));
    const totals = sumTotals(series);
    const withIncome = series.filter((m) => m.income > 0);
    res.json({
      months: series,
      totals,
      average: {
        income: withIncome.length ? Math.round(totals.income / withIncome.length) : 0,
        expenses: Math.round(totals.expenses / series.length),
        net: Math.round(totals.net / series.length),
      },
      bestMonth: series.reduce((best, m) => (m.net > best.net ? m : best), series[0]),
      worstMonth: series.reduce((worst, m) => (m.net < worst.net ? m : worst), series[0]),
    });
  });

  router.get("/comparison", async (req, res) => {
    const now = new Date();
    const year = v.intParam(req.query.year, { fallback: now.getFullYear(), min: 2000, max: 2100 });
    const start = new Date(year - 1, 0, 1);
    const end = new Date(year + 1, 0, 1);
    const map = await monthlySeries(req.user._id, start, end);
    const keys = Array.from({ length: 12 }, (_, i) => year + "-" + pad(i + 1));
    const previousKeys = Array.from({ length: 12 }, (_, i) => year - 1 + "-" + pad(i + 1));
    const months = fillMonths(keys, map);
    const previousMonths = fillMonths(previousKeys, map);
    const totals = sumTotals(months);
    const previousTotals = sumTotals(previousMonths);
    res.json({
      year,
      previousYear: year - 1,
      months,
      previousMonths,
      totals,
      previousTotals,
      changes: {
        income: percentChange(totals.income, previousTotals.income),
        expenses: percentChange(totals.expenses, previousTotals.expenses),
        net: percentChange(totals.net, previousTotals.net),
      },
    });
  });

  router.get("/insights", async (req, res) => {
    const month = req.query.month ? v.month(req.query.month) : monthKey(new Date());
    const previousMonth = shiftMonth(month, -1);
    const [current, previous, names, budgets] = await Promise.all([
      monthTotals(req.user._id, month),
      monthTotals(req.user._id, previousMonth),
      categoryNames(),
      collections.budgets.find({ userId: req.user._id, month }).toArray(),
    ]);

    const categories = Object.entries(current.expensesByCategory)
      .map(([categoryId, total]) => ({
        categoryId,
        name: names[categoryId] || "Unknown",
        total,
        share: current.expenses ? total / current.expenses : 0,
      }))
      .sort((a, b) => b.total - a.total);
    const topCategory = categories[0] || null;
    const savingsRate = current.income > 0 ? (current.income - current.expenses) / current.income : null;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedExpenses =
      month === monthKey(now) ? Math.round((current.expenses / Math.max(1, now.getDate())) * daysInMonth) : current.expenses;

    const budgetRows = budgets.map((budget) => {
      const spent = current.expensesByCategory[budget.categoryId] || 0;
      const ratio = budget.limit ? spent / budget.limit : 0;
      return {
        categoryId: budget.categoryId,
        categoryName: names[budget.categoryId] || "Unknown",
        limit: budget.limit,
        spent,
        percent: Math.floor(ratio * 100),
        status: ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "near" : "ok",
      };
    });

    const recommendations = [];
    for (const budget of budgetRows.filter((b) => b.status === "exceeded")) {
      recommendations.push({
        severity: "warn",
        title: "Budget exceeded: " + budget.categoryName,
        detail: budget.spent + " spent against a " + budget.limit + " millime limit this month.",
      });
    }
    for (const budget of budgetRows.filter((b) => b.status === "near")) {
      recommendations.push({
        severity: "info",
        title: "Almost at the limit: " + budget.categoryName,
        detail: budget.percent + " % of the budget is used. Slow down to stay under the limit.",
      });
    }
    if (previous.expenses > 0 && current.expenses > previous.expenses * 1.1) {
      recommendations.push({
        severity: "warn",
        title: "Spending is up",
        detail: "Expenses are " + Math.round((current.expenses / previous.expenses - 1) * 100) + " % higher than last month.",
      });
    }
    if (savingsRate !== null && savingsRate < 0.1) {
      recommendations.push({
        severity: "warn",
        title: "Low savings rate",
        detail: "You kept " + Math.round(savingsRate * 100) + " % of this month's income. Aim for at least 10 %.",
      });
    }
    if (topCategory && topCategory.share > 0.35) {
      recommendations.push({
        severity: "info",
        title: "One category dominates",
        detail: topCategory.name + " is " + Math.round(topCategory.share * 100) + " % of this month's spending.",
      });
    }
    if (current.income === 0) {
      recommendations.push({ severity: "info", title: "No income recorded", detail: "Add this month's income to get a real savings rate." });
    }
    if (recommendations.length === 0) {
      recommendations.push({
        severity: "ok",
        title: "Spending looks healthy",
        detail: "No budget alert and no unusual change compared with last month.",
      });
    }

    res.json({
      month,
      previousMonth,
      income: current.income,
      expenses: current.expenses,
      net: current.income - current.expenses,
      savingsRate,
      projectedExpenses,
      topCategory,
      categories,
      budgets: budgetRows,
      recommendations: recommendations.slice(0, 6),
    });
  });

  // Advanced search: free-text description, multi-field filters and sorting, up to 100 rows.
  router.get("/search", async (req, res) => {
    const q = req.query;
    const userId = req.user._id;
    const text = v.text(q.q, { min: 0, max: 80, message: "The search text can have at most 80 characters." });
    const accountId = v.optionalId(q.accountId, { prefix: "acc", code: "ACCOUNT_NOT_FOUND", message: "This account does not exist." });
    const categoryId = v.optionalId(q.categoryId, { prefix: "cat" });
    const type = v.oneOf(q.type || "all", ["all", "expense", "income", "transfer"], "Choose a type of movement.");
    const from = v.optionalDay(q.from);
    const to = v.optionalDay(q.to);
    const minAmount = v.optionalMillimes(q.minAmount);
    const maxAmount = v.optionalMillimes(q.maxAmount);
    const sort = v.oneOf(q.sort || "date_desc", ["date_desc", "date_asc", "amount_desc", "amount_asc"], "Choose a sort order.");
    const page = v.intParam(q.page, { fallback: 1, min: 1, max: 100000 });
    const limit = v.intParam(q.limit, { fallback: 20, min: 1, max: 100 });

    const filter = { userId };
    if (text) filter.description = { $regex: escapeRegex(text), $options: "i" };
    if (accountId) {
      await findOwnedAccount(userId, accountId);
      filter.accountId = accountId;
    }
    if (categoryId) filter.categoryId = categoryId;
    if (type === "expense") Object.assign(filter, { type: "debit", transferId: null });
    if (type === "income") Object.assign(filter, { type: "credit", transferId: null });
    if (type === "transfer") filter.transferId = { $ne: null };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }
    if (minAmount !== null || maxAmount !== null) {
      filter.amount = {};
      if (minAmount !== null) filter.amount.$gte = minAmount;
      if (maxAmount !== null) filter.amount.$lte = maxAmount;
    }

    const sorts = {
      date_desc: { date: -1, seq: -1 },
      date_asc: { date: 1, seq: 1 },
      amount_desc: { amount: -1, date: -1 },
      amount_asc: { amount: 1, date: -1 },
    };
    const total = await collections.transactions.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const [items, names, accounts] = await Promise.all([
      collections.transactions.find(filter).sort(sorts[sort]).skip((safePage - 1) * limit).limit(limit).toArray(),
      categoryNames(),
      collections.accounts.find({ userId }, { projection: { name: 1 } }).toArray(),
    ]);
    const accountNames = Object.fromEntries(accounts.map((a) => [a._id, a.name]));
    res.json({
      items: items.map((t) => ({
        _id: t._id,
        accountId: t.accountId,
        accountName: accountNames[t.accountId] || "Unknown",
        type: t.type,
        amount: t.amount,
        categoryId: t.categoryId,
        categoryName: names[t.categoryId] || "Unknown",
        description: t.description,
        date: t.date,
        transferId: t.transferId,
        balanceAfter: t.balanceAfter,
      })),
      total,
      page: safePage,
      limit,
      totalPages,
    });
  });

  router.get("/reports", async (req, res) => {
    const now = new Date();
    const fallbackFrom = dayKey(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    const from = v.optionalDay(req.query.from) || fallbackFrom;
    const to = v.optionalDay(req.query.to) || dayKey(now);
    if (from > to) throw new ApiError("VALIDATION_ERROR", "The start date is after the end date.");
    const report = await reportData(req.user._id, from, to);
    res.json(report);
  });

  router.get("/reports/download", async (req, res) => {
    const now = new Date();
    const fallbackFrom = dayKey(new Date(now.getFullYear(), now.getMonth() - 2, 1));
    const from = v.optionalDay(req.query.from) || fallbackFrom;
    const to = v.optionalDay(req.query.to) || dayKey(now);
    if (from > to) throw new ApiError("VALIDATION_ERROR", "The start date is after the end date.");
    const report = await reportData(req.user._id, from, to);
    const lines = ["Date,Description,Account,Category,Type,Amount (TND),Balance after (TND)"];
    for (const t of report.items) {
      const signed = (t.type === "credit" ? 1 : -1) * (t.amount / 1000);
      lines.push(
        [
          csvCell(dayKey(new Date(t.date))),
          csvCell(t.description),
          csvCell(t.accountName),
          csvCell(t.categoryName),
          csvCell(t.type === "credit" ? "Credit" : "Debit"),
          csvCell(signed.toFixed(3)),
          csvCell((t.balanceAfter / 1000).toFixed(3)),
        ].join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="tunibudget-report-' + from + "-to-" + to + '.csv"');
    res.send("\uFEFF" + lines.join("\r\n"));
  });

  router.get("/goals", async (req, res) => {
    const goals = await collections.savingsGoals.find({ userId: req.user._id }).sort({ status: 1, createdAt: -1 }).toArray();
    res.json(goals.map(publicGoal));
  });

  router.post("/goals", async (req, res) => {
    const body = v.onlyFields(req.body, ["name", "targetAmount", "targetDate", "note"]);
    const name = v.text(body.name, { min: 2, max: 60, message: "The goal name needs 2 to 60 characters." });
    const targetAmount = v.millimes(body.targetAmount, { message: "The target must be greater than 0." });
    const targetDate = v.optionalDay(body.targetDate) || null;
    const note = v.text(body.note, { min: 0, max: 160, message: "The note can have at most 160 characters." });
    const now = new Date();
    const goal = {
      _id: newId("goal"),
      userId: req.user._id,
      name,
      targetAmount,
      savedAmount: 0,
      targetDate,
      note,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastContributionAt: null,
    };
    await collections.savingsGoals.insertOne(goal);
    res.status(201).json(publicGoal(goal));
  });

  router.patch("/goals/:goalId", async (req, res) => {
    const goalId = v.id(req.params.goalId, { prefix: "goal", code: "GOAL_NOT_FOUND", message: "This goal does not exist." });
    const body = v.onlyFields(req.body, ["name", "targetAmount", "targetDate", "note", "status"]);
    const updates = {};
    if (body.name !== undefined) updates.name = v.text(body.name, { min: 2, max: 60, message: "The goal name needs 2 to 60 characters." });
    if (body.targetAmount !== undefined) updates.targetAmount = v.millimes(body.targetAmount, { message: "The target must be greater than 0." });
    if (body.targetDate !== undefined) updates.targetDate = v.optionalDay(body.targetDate) || null;
    if (body.note !== undefined) updates.note = v.text(body.note, { min: 0, max: 160, message: "The note can have at most 160 characters." });
    if (body.status !== undefined) updates.status = v.oneOf(body.status, ["active", "archived"], "Choose active or archived.");
    if (Object.keys(updates).length === 0) throw new ApiError("VALIDATION_ERROR", "Nothing to change.");
    updates.updatedAt = new Date();
    const goal = await collections.savingsGoals.findOneAndUpdate(
      { _id: goalId, userId: req.user._id },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!goal) throw new ApiError("GOAL_NOT_FOUND", "This goal does not exist.");
    res.json(publicGoal(goal));
  });

  // Progress tracking only: this records money the user has already set aside, it does not move it.
  router.post("/goals/:goalId/contribute", async (req, res) => {
    const goalId = v.id(req.params.goalId, { prefix: "goal", code: "GOAL_NOT_FOUND", message: "This goal does not exist." });
    const body = v.onlyFields(req.body, ["amount"]);
    const amount = v.millimes(body.amount);
    const now = new Date();
    const goal = await collections.savingsGoals.findOneAndUpdate(
      { _id: goalId, userId: req.user._id, status: { $ne: "archived" } },
      { $inc: { savedAmount: amount }, $set: { updatedAt: now, lastContributionAt: now } },
      { returnDocument: "after" }
    );
    if (!goal) throw new ApiError("GOAL_NOT_FOUND", "This goal does not exist.");
    if (goal.savedAmount >= goal.targetAmount && goal.status !== "achieved") {
      await collections.savingsGoals.updateOne({ _id: goalId, userId: req.user._id }, { $set: { status: "achieved", updatedAt: now } });
      goal.status = "achieved";
    }
    res.json(publicGoal(goal));
  });

  router.delete("/goals/:goalId", async (req, res) => {
    const goalId = v.id(req.params.goalId, { prefix: "goal", code: "GOAL_NOT_FOUND", message: "This goal does not exist." });
    const result = await collections.savingsGoals.deleteOne({ _id: goalId, userId: req.user._id });
    if (result.deletedCount === 0) throw new ApiError("GOAL_NOT_FOUND", "This goal does not exist.");
    res.json({ removed: goalId });
  });

  return router;
}
