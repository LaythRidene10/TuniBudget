import { useEffect, useState } from "react";
import {
  getAccounts,
  getBalanceHistory,
  getBudgets,
  getCategories,
  getMonthSummary,
  getSpendingByCategory,
  getTransactions,
} from "../services/index.js";
import { currentMonthKey, formatDay, formatDayYear, monthLabel, monthName } from "../utils/dates.js";
import { formatMillimes, formatTnd } from "../utils/money.js";
import { StarPattern } from "../components/StarMark.jsx";
import { Amount, BigMoney } from "../components/Money.jsx";
import BalanceChart from "../components/BalanceChart.jsx";
import CategoryBars from "../components/CategoryBars.jsx";
import BudgetStatus from "../components/BudgetStatus.jsx";
import Meter from "../components/Meter.jsx";
import { EmptyState, ErrorState, Loading } from "../components/StateMessage.jsx";
import Icon from "../components/Icon.jsx";

const RANGES = [30, 90];

export default function DashboardPage({ user, version, goTo }) {
  const month = currentMonthKey();
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([
      getAccounts(),
      getMonthSummary(month),
      getSpendingByCategory(month),
      getBudgets(month),
      getBalanceHistory({ days }),
      getTransactions({ page: 1, limit: 12 }),
      getCategories(),
    ])
      .then(([accounts, summary, spending, budgets, history, recent, categories]) => {
        if (!cancelled) setData({ accounts, summary, spending, budgets, history, recent, categories });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [version, days, month, attempt]);

  if (error && !data) return <ErrorState message={error} onRetry={() => setAttempt(attempt + 1)} />;
  if (!data) return <Loading label="Loading your dashboard" />;

  const { accounts, summary, spending, budgets, history, recent, categories } = data;
  const activeAccounts = accounts.filter((a) => a.status === "active");
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  const accountName = (id) => (accounts.find((a) => a._id === id) || {}).name || "";
  const categoryLabel = (id) => (categories.find((c) => c._id === id) || {}).name || "";

  // A transfer is two ledger entries; the dashboard lists it once (the debit side).
  const latest = recent.items.filter((t) => !(t.transferId && t.type === "credit")).slice(0, 6);


  const spentPercent = summary.spentShare === null ? null : Math.round(summary.spentShare * 100);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Hello, {user.fullName.split(" ")[0]}</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => goTo("history")}>
            Add an operation
          </button>
          <button type="button" className="btn btn--primary" onClick={() => goTo("transfer")}>
            Make a transfer
          </button>
        </div>
      </div>

      {user.role === "premium" && (
        <p className="notice notice--ok" role="status" style={{ marginBottom: 20 }}>
          <Icon name="check" />
          <span>
            Premium is active{user.subscription ? " until " + formatDayYear(user.subscription.expiresAt) : ""}.
            <button type="button" className="link-button" style={{ marginLeft: 8 }} onClick={() => goTo("premium")}>
              Manage subscription
            </button>
          </span>
        </p>
      )}
      {user.role === "user" && (
        <p className="notice notice--info" role="status" style={{ marginBottom: 20 }}>
          <Icon name="info" />
          <span>
            You are on the free plan.
            <button type="button" className="link-button" style={{ marginLeft: 8 }} onClick={() => goTo("premium")}>
              Upgrade to Premium
            </button>{" "}
            for advanced analytics, reports and savings goals.
          </span>
        </p>
      )}

      <div className="columns columns--stretch">
        <section className="hero" aria-label="Total balance">
          <StarPattern id="hero-pattern" />
          <div className="hero__top">
            <p className="hero__label">Total balance across {activeAccounts.length} {activeAccounts.length === 1 ? "account" : "accounts"}</p>
            <BigMoney millimes={total} size={64} />
            <p className="hero__delta">
              {formatTnd(summary.net, { signed: true })} since {monthName(month)} 1
            </p>
          </div>

          <div className="hero__bottom">
            <div className="hero__chart-head">
              <p className="hero__label">Balance over the last {days} days</p>
              <div className="segmented segmented--on-dark" role="group" aria-label="Time range">
                {RANGES.map((range) => (
                  <button key={range} type="button" className="segmented__option" aria-pressed={days === range} onClick={() => setDays(range)}>
                    {range} days
                  </button>
                ))}
              </div>
            </div>
            <BalanceChart points={history.points} />
            <ul className="hero__chips">
              {activeAccounts.map((account) => (
                <li key={account._id} className="chip">
                  <p className="chip__name">{account.name}</p>
                  <p className="num chip__value">{formatMillimes(account.balance)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel summary" aria-labelledby="summary-title">
          <h2 className="panel__title" id="summary-title">
            {monthLabel(month)} at a glance
          </h2>
          <dl className="summary__list">
            <div className="summary__row">
              <dt>Income</dt>
              <dd className="num pos summary__value">{formatMillimes(summary.income, { signed: true })}</dd>
            </div>
            <div className="summary__row">
              <dt>Expenses</dt>
              <dd className="num neg summary__value">{formatMillimes(-summary.expenses)}</dd>
            </div>
            <div className="summary__row summary__row--total">
              <dt>Left this month</dt>
              <dd className={"num summary__total " + (summary.net >= 0 ? "pos" : "neg")}>{formatMillimes(summary.net, { signed: true })}</dd>
            </div>
          </dl>
          <div className="summary__foot">
            {spentPercent === null ? (
              <p className="muted small">No income recorded this month yet.</p>
            ) : (
              <>
                <Meter percent={spentPercent} label={spentPercent + " % of this month's income already spent"} />
                <p className="muted small" style={{ marginTop: 10 }}>
                  {spentPercent} % of this month's income is already spent.
                </p>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="columns columns--stretch columns--gap-top">
        <section className="panel grow" aria-labelledby="spending-title">
          <h2 className="panel__title" id="spending-title">
            Where the money goes
          </h2>
          <div style={{ marginTop: 22 }}>
            {spending.length === 0 ? <EmptyState title="No spending yet this month">Expenses you add will show up here.</EmptyState> : <CategoryBars items={spending} />}
          </div>
        </section>

        <section className="panel grow" aria-labelledby="budgets-title">
          <div className="panel__head">
            <h2 className="panel__title" id="budgets-title">
              {monthName(month)} budgets
            </h2>
            <button type="button" className="link-button" onClick={() => goTo("budgets")}>
              See all budgets
            </button>
          </div>
          {budgets.items.length === 0 ? (
            <EmptyState title="No budgets yet">Set a monthly limit for a category to get alerts.</EmptyState>
          ) : (
            <ul className="budget-list">
              {budgets.items.slice(0, 4).map((budget) => (
                <li key={budget._id}>
                  <div className="budget-list__head">
                    <span className="budget-list__name">{budget.categoryName}</span>
                    <BudgetStatus status={budget.status} percent={budget.percent} />
                  </div>
                  <Meter percent={budget.percent} status={budget.status} label={budget.categoryName + ", " + budget.percent + " % of the budget used"} />
                  <p className="muted small num">
                    {formatMillimes(budget.spent)} of {formatMillimes(budget.limit)} TND
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="latest-title" style={{ marginTop: 20 }}>
        <div className="panel__head" style={{ marginBottom: 16 }}>
          <h2 className="panel__title" id="latest-title">
            Latest movements
          </h2>
          <button type="button" className="link-button" onClick={() => goTo("history")}>
            Full history
          </button>
        </div>
        {latest.length === 0 ? (
          <EmptyState title="No movements yet">Add an expense or an income to start your history.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Account</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="right">
                    Amount (TND)
                  </th>
                </tr>
              </thead>
              <tbody>
                {latest.map((t) => (
                  <tr key={t._id}>
                    <td className="num nowrap">{formatDay(t.date)}</td>
                    <td>{t.description}</td>
                    <td>{accountName(t.accountId)}</td>
                    <td>
                      <span className="tag">{categoryLabel(t.categoryId)}</span>
                    </td>
                    <td className="right">
                      <Amount millimes={t.amount} type={t.type} neutral={Boolean(t.transferId)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
