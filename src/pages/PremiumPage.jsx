import { useEffect, useState } from "react";
import {
  cancelSubscription,
  checkout,
  contributeToGoal,
  createGoal,
  downloadReport,
  getAccounts,
  getCategories,
  getCurrentUser,
  getGoals,
  getInsights,
  getMySubscription,
  getPremiumAnalytics,
  getReport,
  getSubscriptionPlans,
  getYearComparison,
  removeGoal,
  renewSubscription,
  searchTransactions,
  updateGoal,
} from "../services/index.js";
import { currentMonthKey, formatDay, formatDayYear, monthLabel, monthName } from "../utils/dates.js";
import { formatMillimes, formatTnd, parseTndToMillimes } from "../utils/money.js";
import CategoryBars from "../components/CategoryBars.jsx";
import DatePicker from "../components/DatePicker.jsx";
import Icon from "../components/Icon.jsx";
import Meter from "../components/Meter.jsx";
import Pagination from "../components/Pagination.jsx";
import { EmptyState, ErrorState, Loading } from "../components/StateMessage.jsx";

const PAGE_SIZE = 20;
const NO_SEARCH = { q: "", type: "all", sort: "date_desc", from: "", to: "", min: "", max: "", categoryId: "", accountId: "" };
const EMPTY_GOAL = { name: "", target: "", targetDate: "", note: "" };

function statusLabel(subscription) {
  if (!subscription) return "Free";
  if (subscription.status === "active") return "Active";
  if (subscription.status === "cancelled") return "Cancelled";
  if (subscription.status === "suspended") return "Suspended";
  return "Expired";
}

function reportStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10);
}

export default function PremiumPage({ user, version, onChange, notify, onUserChange }) {
  const [subscription, setSubscription] = useState(null);
  const [plans, setPlans] = useState([]);
  const [paymentMode, setPaymentMode] = useState("test");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");

  const [premium, setPremium] = useState(null); // analytics, comparison, insights, goals, accounts, categories
  const [premiumError, setPremiumError] = useState("");

  const [reportFrom, setReportFrom] = useState(reportStart);
  const [reportTo, setReportTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState("");
  const [reportBusy, setReportBusy] = useState(false);

  const [goalForm, setGoalForm] = useState(EMPTY_GOAL);
  const [goalError, setGoalError] = useState("");
  const [goalBusy, setGoalBusy] = useState("");
  const [contributions, setContributions] = useState({});

  const [search, setSearch] = useState(NO_SEARCH);
  const [searchPage, setSearchPage] = useState(1);
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([getMySubscription(), getSubscriptionPlans()])
      .then(([mine, planList]) => {
        if (cancelled) return;
        setSubscription(mine);
        setPlans(planList.plans);
        setPaymentMode(planList.paymentMode);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [version, attempt]);

  const isPremium = Boolean(subscription && subscription.isPremium);

  useEffect(() => {
    if (!isPremium) {
      setPremium(null);
      return;
    }
    let cancelled = false;
    setPremiumError("");
    Promise.all([
      getPremiumAnalytics(12),
      getYearComparison(new Date().getFullYear()),
      getInsights(),
      getGoals(),
      getAccounts(),
      getCategories(),
    ])
      .then(([analytics, comparison, insights, goals, accounts, categories]) => {
        if (!cancelled) setPremium({ analytics, comparison, insights, goals, accounts, categories });
      })
      .catch((err) => {
        if (!cancelled) setPremiumError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [isPremium, version, attempt]);

  const minAmount = search.min.trim() === "" ? null : parseTndToMillimes(search.min);
  const maxAmount = search.max.trim() === "" ? null : parseTndToMillimes(search.max);
  const searchQuery = {
    q: search.q,
    type: search.type,
    sort: search.sort,
    from: search.from,
    to: search.to,
    minAmount,
    maxAmount,
    categoryId: search.categoryId,
    accountId: search.accountId,
    page: searchPage,
    limit: PAGE_SIZE,
  };
  const searchKey = JSON.stringify(searchQuery);

  useEffect(() => {
    if (!isPremium) return;
    let cancelled = false;
    setSearchError("");
    searchTransactions(searchQuery)
      .then((result) => {
        if (cancelled) return;
        setSearchResult(result);
        if (result.page !== searchPage) setSearchPage(result.page);
      })
      .catch((err) => {
        if (!cancelled) setSearchError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [isPremium, searchKey, version]);

  async function afterSubscriptionChange(message) {
    const current = await getCurrentUser();
    onUserChange(current);
    notify("success", message);
  }

  async function runSubscription(kind, planId) {
    setBusy(kind);
    try {
      if (kind === "checkout") await checkout(planId);
      if (kind === "renew") await renewSubscription(planId);
      if (kind === "cancel") await cancelSubscription();
      await afterSubscriptionChange(
        kind === "checkout" ? "Premium is active. Welcome!" : kind === "renew" ? "Your subscription is renewed." : "Subscription cancelled. Access remains until the end date."
      );
    } catch (err) {
      notify("error", err.message);
    } finally {
      setBusy("");
    }
  }

  async function loadReport() {
    setReportBusy(true);
    setReportError("");
    try {
      setReport(await getReport({ from: reportFrom, to: reportTo }));
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportBusy(false);
    }
  }

  async function saveReport() {
    setReportBusy(true);
    setReportError("");
    try {
      const file = await downloadReport({ from: reportFrom, to: reportTo });
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify("success", "Report downloaded.");
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportBusy(false);
    }
  }

  async function submitGoal(event) {
    event.preventDefault();
    setGoalError("");
    const targetAmount = parseTndToMillimes(goalForm.target);
    if (!goalForm.name.trim()) return setGoalError("Give the goal a name.");
    if (targetAmount === null || targetAmount <= 0) return setGoalError("Enter a target greater than 0.");
    setGoalBusy("create");
    try {
      await createGoal({ name: goalForm.name, targetAmount, targetDate: goalForm.targetDate, note: goalForm.note });
      setGoalForm(EMPTY_GOAL);
      notify("success", "Savings goal created.");
      onChange();
    } catch (err) {
      setGoalError(err.message);
    } finally {
      setGoalBusy("");
    }
  }

  async function contribute(goal) {
    const amount = parseTndToMillimes(contributions[goal._id] || "");
    if (amount === null || amount <= 0) return notify("error", "Enter a contribution greater than 0.");
    setGoalBusy(goal._id);
    try {
      await contributeToGoal(goal._id, amount);
      setContributions({ ...contributions, [goal._id]: "" });
      notify("success", "Progress updated.");
      onChange();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setGoalBusy("");
    }
  }

  async function archiveGoal(goal) {
    setGoalBusy(goal._id);
    try {
      await updateGoal(goal._id, { status: goal.status === "archived" ? "active" : "archived" });
      notify("success", goal.status === "archived" ? "Goal restored." : "Goal archived.");
      onChange();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setGoalBusy("");
    }
  }

  async function deleteGoal(goal) {
    setGoalBusy(goal._id);
    try {
      await removeGoal(goal._id);
      notify("success", "Goal removed.");
      onChange();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setGoalBusy("");
    }
  }

  function setSearchField(field, value) {
    setSearch({ ...search, [field]: value });
    setSearchPage(1);
  }

  if (error && !subscription) return <ErrorState message={error} onRetry={() => setAttempt(attempt + 1)} />;
  if (!subscription) return <Loading label="Loading your subscription" />;

  const current = subscription.subscription;
  const expiry = current ? formatDayYear(current.expiresAt) : "";
  const analytics = premium && premium.analytics;
  const comparison = premium && premium.comparison;
  const insights = premium && premium.insights;
  const goals = premium ? premium.goals : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Premium <span className="premium-star" aria-hidden="true">✦</span>
          </h1>
          <p className="page-subtitle">
            {isPremium ? "Your advanced financial workspace." : "Unlock deeper analytics, reports, goals and insights."}
          </p>
        </div>
        <span className={"badge badge--premium " + (isPremium ? "badge--ok" : "badge--muted")}>{isPremium ? "Premium active" : "Free account"}</span>
      </div>

      {paymentMode === "test" && (
        <p className="notice notice--info" role="status">
          <Icon name="info" />
          Test payment mode: no real money is charged. Every payment is stored with a test marker.
        </p>
      )}

      <div className="columns columns--gap-top">
        <section className="panel premium-status" aria-labelledby="subscription-title">
          <h2 className="panel__title" id="subscription-title">
            Your subscription
          </h2>
          {isPremium ? (
            <>
              <div className="premium-status__row">
                <span className={"badge " + (current.status === "cancelled" ? "badge--near" : "badge--ok")}>{statusLabel(current)}</span>
                <span className="tag">{current.planName}</span>
              </div>
              <dl className="summary__list">
                <div className="summary__row">
                  <dt>Started</dt>
                  <dd className="num">{formatDayYear(current.startedAt)}</dd>
                </div>
                <div className="summary__row">
                  <dt>Access until</dt>
                  <dd className="num">{expiry}</dd>
                </div>
                <div className="summary__row">
                  <dt>Renewal</dt>
                  <dd>{current.autoRenew ? "Automatic" : "Off"}</dd>
                </div>
                <div className="summary__row summary__row--total">
                  <dt>Price</dt>
                  <dd className="num summary__total">{formatTnd(current.price)}</dd>
                </div>
              </dl>
              {current.status === "cancelled" && (
                <p className="notice notice--near" role="status">
                  <Icon name="clock" />
                  Cancelled: premium stays available until {expiry}.
                </p>
              )}
              <div className="row premium-status__actions">
                <button type="button" className="btn btn--primary" disabled={busy !== ""} onClick={() => runSubscription("renew", current.planId)}>
                  {busy === "renew" ? "Renewing…" : "Renew for " + formatTnd(current.price)}
                </button>
                {current.status === "active" && (
                  <button type="button" className="btn" disabled={busy !== ""} onClick={() => runSubscription("cancel")}>
                    {busy === "cancel" ? "Cancelling…" : "Cancel renewal"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                You are on the free plan. Upgrade to unlock the premium dashboard, reports and savings goals. Your
                financial data stays exactly as it is.
              </p>
              <div className="premium-lock-list">
                {[
                  "Advanced analytics and comparisons",
                  "Detailed reports and CSV download",
                  "Multiple savings goals with progress",
                  "Advanced transaction search",
                  "Personal spending recommendations",
                ].map((feature) => (
                  <p key={feature} className="premium-lock">
                    <Icon name="lock" /> {feature}
                  </p>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel" aria-labelledby="plans-title">
          <h2 className="panel__title" id="plans-title">
            {isPremium ? "Plans" : "Choose your plan"}
          </h2>
          <p className="panel__subtitle">Monthly and yearly plans, priced in Tunisian dinar.</p>
          <div className="plan-grid">
            {plans.map((plan) => (
              <article key={plan._id} className={"plan-card" + (plan.badge ? " plan-card--featured" : "")}>
                <div className="plan-card__head">
                  <h3 className="plan-card__name">{plan.name}</h3>
                  {plan.badge && <span className="badge badge--premium">{plan.badge}</span>}
                </div>
                <p className="plan-card__price">{formatTnd(plan.price)}</p>
                <p className="muted small">every {plan.interval === "year" ? "year" : "month"} · {plan.days} days</p>
                <ul className="plan-card__features">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Icon name="check" /> {feature}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  disabled={busy !== "" || isPremium}
                  onClick={() => runSubscription("checkout", plan._id)}
                >
                  {isPremium ? "Already premium" : busy === "checkout" ? "Confirming test payment…" : "Upgrade · " + formatTnd(plan.price)}
                </button>
              </article>
            ))}
          </div>
        </section>
      </div>

      {isPremium && premiumError && <p className="notice notice--error columns--gap-top" role="alert"><Icon name="warning" />{premiumError}</p>}
      {isPremium && !premium && !premiumError && <Loading label="Loading premium analytics" />}

      {isPremium && premium && (
        <>
          <div className="columns columns--gap-top">
            <section className="panel grow-wide" aria-labelledby="analytics-title">
              <div className="panel__head">
                <h2 className="panel__title" id="analytics-title">
                  Advanced analytics
                </h2>
                <span className="tag">Last 12 months</span>
              </div>
              <div className="stat-grid">
                <div className="stat">
                  <p className="stat__label">Income</p>
                  <p className="stat__value num pos">{formatMillimes(analytics.totals.income)}</p>
                </div>
                <div className="stat">
                  <p className="stat__label">Expenses</p>
                  <p className="stat__value num neg">{formatMillimes(analytics.totals.expenses)}</p>
                </div>
                <div className="stat">
                  <p className="stat__label">Net saved</p>
                  <p className={"stat__value num " + (analytics.totals.net >= 0 ? "pos" : "neg")}>{formatMillimes(analytics.totals.net, { signed: true })}</p>
                </div>
                <div className="stat">
                  <p className="stat__label">Savings rate</p>
                  <p className="stat__value num">{analytics.totals.savingsRate === null ? "—" : Math.round(analytics.totals.savingsRate * 100) + " %"}</p>
                </div>
              </div>
              <div className="columns columns--gap-top">
                <div>
                  <h3 className="panel__subtitle">Expenses per month</h3>
                  <div style={{ marginTop: 16 }}>
                    <CategoryBars
                      items={analytics.months.map((month) => ({
                        categoryId: month.month,
                        name: monthName(month.month),
                        total: month.expenses,
                      }))}
                    />
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="right">Income</th>
                        <th className="right">Expenses</th>
                        <th className="right">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.months.slice(-6).reverse().map((month) => (
                        <tr key={month.month}>
                          <td className="nowrap">{monthLabel(month.month)}</td>
                          <td className="right num pos">{formatMillimes(month.income)}</td>
                          <td className="right num neg">{formatMillimes(month.expenses)}</td>
                          <td className={"right num " + (month.net >= 0 ? "pos" : "neg")}>{formatMillimes(month.net, { signed: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="panel" aria-labelledby="comparison-title">
              <h2 className="panel__title" id="comparison-title">
                Year comparison
              </h2>
              <p className="panel__subtitle">
                {comparison.year} compared with {comparison.previousYear}
              </p>
              <dl className="summary__list">
                <div className="summary__row">
                  <dt>Income {comparison.year}</dt>
                  <dd className="num pos">{formatMillimes(comparison.totals.income)}</dd>
                </div>
                <div className="summary__row">
                  <dt>Income {comparison.previousYear}</dt>
                  <dd className="num muted">{formatMillimes(comparison.previousTotals.income)}</dd>
                </div>
                <div className="summary__row">
                  <dt>Expenses {comparison.year}</dt>
                  <dd className="num neg">{formatMillimes(comparison.totals.expenses)}</dd>
                </div>
                <div className="summary__row">
                  <dt>Expenses {comparison.previousYear}</dt>
                  <dd className="num muted">{formatMillimes(comparison.previousTotals.expenses)}</dd>
                </div>
                <div className="summary__row summary__row--total">
                  <dt>Expense change</dt>
                  <dd className="num summary__total">
                    {comparison.changes.expenses === null ? "—" : (comparison.changes.expenses >= 0 ? "+" : "") + Math.round(comparison.changes.expenses * 100) + " %"}
                  </dd>
                </div>
              </dl>
              <h3 className="panel__subtitle" style={{ marginTop: 18 }}>This year by month</h3>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.months.map((month) => (
                      <tr key={month.month}>
                        <td className="nowrap">{monthName(month.month)}</td>
                        <td className={"right num " + (month.net >= 0 ? "pos" : "neg")}>{formatMillimes(month.net, { signed: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="panel columns--gap-top" aria-labelledby="insights-title">
            <div className="panel__head">
              <h2 className="panel__title" id="insights-title">
                Financial insights
              </h2>
              <span className="tag">{monthLabel(insights.month)}</span>
            </div>
            <div className="insight-grid">
              {insights.recommendations.map((item, index) => (
                <article key={index} className={"insight insight--" + item.severity}>
                  <p className="insight__title">
                    <Icon name={item.severity === "ok" ? "check" : item.severity === "warn" ? "warning" : "info"} /> {item.title}
                  </p>
                  <p className="muted small">{item.detail}</p>
                </article>
              ))}
            </div>
            <p className="muted small" style={{ marginTop: 14 }}>
              Projected expenses for this month: <strong className="num">{formatTnd(insights.projectedExpenses)}</strong>. Savings rate:{" "}
              <strong>{insights.savingsRate === null ? "not available" : Math.round(insights.savingsRate * 100) + " %"}</strong>.
            </p>
          </section>

          <div className="columns columns--gap-top">
            <section className="panel grow-wide" aria-labelledby="goals-title">
              <div className="panel__head">
                <h2 className="panel__title" id="goals-title">
                  Savings goals
                </h2>
                <span className="tag">{goals.filter((goal) => goal.status !== "archived").length} active</span>
              </div>
              {goals.length === 0 ? (
                <EmptyState title="No savings goal yet">Create your first goal below and track its progress.</EmptyState>
              ) : (
                <ul className="goal-list">
                  {goals.map((goal) => (
                    <li key={goal._id} className={"goal" + (goal.status === "archived" ? " goal--archived" : "")}>
                      <div className="goal__head">
                        <div>
                          <p className="goal__name">{goal.name}</p>
                          <p className="muted small">
                            {formatMillimes(goal.savedAmount)} of {formatMillimes(goal.targetAmount)} TND
                            {goal.targetDate ? " · by " + formatDayYear(goal.targetDate) : ""}
                          </p>
                        </div>
                        <span className={"badge " + (goal.status === "achieved" ? "badge--ok" : goal.status === "archived" ? "badge--muted" : "badge--near")}>
                          {goal.status === "achieved" ? "Achieved" : goal.status === "archived" ? "Archived" : goal.percent + " %"}
                        </span>
                      </div>
                      <Meter percent={goal.percent} status={goal.status === "achieved" ? "ok" : goal.percent >= 80 ? "near" : "ok"} label={goal.name + ", " + goal.percent + " % saved"} />
                      {goal.note && <p className="muted small">{goal.note}</p>}
                      <div className="goal__actions">
                        <span className="input-money goal__contribution">
                          <input
                            className="input num"
                            inputMode="decimal"
                            placeholder="Add amount"
                            value={contributions[goal._id] || ""}
                            onChange={(e) => setContributions({ ...contributions, [goal._id]: e.target.value })}
                            aria-label={"Contribution to " + goal.name}
                          />
                          <span className="input-money__unit">TND</span>
                        </span>
                        <button type="button" className="btn btn--small" disabled={goalBusy === goal._id} onClick={() => contribute(goal)}>
                          Add progress
                        </button>
                        <button type="button" className="btn btn--small" disabled={goalBusy === goal._id} onClick={() => archiveGoal(goal)}>
                          {goal.status === "archived" ? "Restore" : "Archive"}
                        </button>
                        <button type="button" className="btn btn--small" disabled={goalBusy === goal._id} onClick={() => deleteGoal(goal)}>
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form className="goal-form" onSubmit={submitGoal} noValidate>
                <h3 className="panel__subtitle">New savings goal</h3>
                <div className="filters">
                  <label className="field">
                    Name
                    <input className="input" maxLength={60} value={goalForm.name} onChange={(e) => setGoalForm({ ...goalForm, name: e.target.value })} placeholder="Holiday fund" />
                  </label>
                  <label className="field">
                    Target
                    <span className="input-money">
                      <input className="input num" inputMode="decimal" value={goalForm.target} onChange={(e) => setGoalForm({ ...goalForm, target: e.target.value })} placeholder="2,000.000" />
                      <span className="input-money__unit">TND</span>
                    </span>
                  </label>
                  <div className="field">
                    <span id="goal-date-label">Target date</span>
                    <DatePicker id="goal-date" labelledBy="goal-date-label" value={goalForm.targetDate} onChange={(v) => setGoalForm({ ...goalForm, targetDate: v })} />
                  </div>
                  <label className="field">
                    Note
                    <input className="input" maxLength={160} value={goalForm.note} onChange={(e) => setGoalForm({ ...goalForm, note: e.target.value })} placeholder="Optional" />
                  </label>
                </div>
                {goalError && <p className="form-error" role="alert"><Icon name="warning" />{goalError}</p>}
                <button type="submit" className="btn btn--primary" disabled={goalBusy === "create"}>
                  {goalBusy === "create" ? "Creating…" : "Create goal"}
                </button>
              </form>
            </section>

            <section className="panel" aria-labelledby="report-title">
              <h2 className="panel__title" id="report-title">
                Downloadable report
              </h2>
              <p className="panel__subtitle">A detailed CSV of every movement in the chosen period.</p>
              <div className="filters" style={{ marginTop: 16 }}>
                <div className="field">
                  <span id="report-from-label">From</span>
                  <DatePicker id="report-from" labelledBy="report-from-label" value={reportFrom} onChange={setReportFrom} />
                </div>
                <div className="field">
                  <span id="report-to-label">To</span>
                  <DatePicker id="report-to" labelledBy="report-to-label" value={reportTo} onChange={setReportTo} />
                </div>
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn" disabled={reportBusy} onClick={loadReport}>
                  {reportBusy ? "Working…" : "Preview report"}
                </button>
                <button type="button" className="btn btn--primary" disabled={reportBusy} onClick={saveReport}>
                  Download CSV
                </button>
              </div>
              {reportError && <p className="form-error" role="alert"><Icon name="warning" />{reportError}</p>}
              {report && (
                <div className="report-preview">
                  <dl className="summary__list">
                    <div className="summary__row"><dt>Movements</dt><dd className="num">{report.summary.count}</dd></div>
                    <div className="summary__row"><dt>Income</dt><dd className="num pos">{formatMillimes(report.summary.income)}</dd></div>
                    <div className="summary__row"><dt>Expenses</dt><dd className="num neg">{formatMillimes(report.summary.expenses)}</dd></div>
                    <div className="summary__row summary__row--total"><dt>Net</dt><dd className={"num summary__total " + (report.summary.net >= 0 ? "pos" : "neg")}>{formatMillimes(report.summary.net, { signed: true })}</dd></div>
                  </dl>
                  <h3 className="panel__subtitle" style={{ marginTop: 14 }}>Top categories</h3>
                  <ul className="closed-list">
                    {report.byCategory.slice(0, 5).map((row) => (
                      <li key={row.categoryId} className="closed-list__row">
                        <span>{row.categoryName}</span>
                        <span className="num">{formatMillimes(row.total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </div>

          <section className="panel columns--gap-top" aria-labelledby="search-title">
            <div className="panel__head">
              <h2 className="panel__title" id="search-title">
                Advanced transaction search
              </h2>
              <button type="button" className="link-button" onClick={() => { setSearch(NO_SEARCH); setSearchPage(1); }}>
                Clear
              </button>
            </div>
            <div className="filters">
              <label className="field">
                Search text
                <input className="input" maxLength={80} value={search.q} onChange={(e) => setSearchField("q", e.target.value)} placeholder="Description contains…" />
              </label>
              <label className="field">
                Type
                <select className="input" value={search.type} onChange={(e) => setSearchField("type", e.target.value)}>
                  <option value="all">All movements</option>
                  <option value="expense">Expenses</option>
                  <option value="income">Income</option>
                  <option value="transfer">Transfers</option>
                </select>
              </label>
              <label className="field">
                Category
                <select className="input" value={search.categoryId} onChange={(e) => setSearchField("categoryId", e.target.value)}>
                  <option value="">All categories</option>
                  {premium.categories.map((category) => (
                    <option key={category._id} value={category._id}>{category.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Account
                <select className="input" value={search.accountId} onChange={(e) => setSearchField("accountId", e.target.value)}>
                  <option value="">All accounts</option>
                  {premium.accounts.map((account) => (
                    <option key={account._id} value={account._id}>{account.name}</option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span id="search-from-label">From</span>
                <DatePicker id="search-from" labelledBy="search-from-label" value={search.from} onChange={(v) => setSearchField("from", v)} />
              </div>
              <div className="field">
                <span id="search-to-label">To</span>
                <DatePicker id="search-to" labelledBy="search-to-label" value={search.to} onChange={(v) => setSearchField("to", v)} />
              </div>
              <label className="field">
                Minimum
                <span className="input-money">
                  <input className="input num" inputMode="decimal" value={search.min} onChange={(e) => setSearchField("min", e.target.value)} placeholder="0.000" />
                  <span className="input-money__unit">TND</span>
                </span>
              </label>
              <label className="field">
                Maximum
                <span className="input-money">
                  <input className="input num" inputMode="decimal" value={search.max} onChange={(e) => setSearchField("max", e.target.value)} placeholder="No limit" />
                  <span className="input-money__unit">TND</span>
                </span>
              </label>
              <label className="field">
                Sort
                <select className="input" value={search.sort} onChange={(e) => setSearchField("sort", e.target.value)}>
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                  <option value="amount_desc">Largest amount</option>
                  <option value="amount_asc">Smallest amount</option>
                </select>
              </label>
            </div>

            {searchError && <p className="form-error" role="alert"><Icon name="warning" />{searchError}</p>}
            {!searchResult ? (
              <Loading label="Searching movements" />
            ) : searchResult.total === 0 ? (
              <EmptyState title="No movement matches this search">Try a shorter text or remove a filter.</EmptyState>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Description</th>
                        <th>Account</th>
                        <th>Category</th>
                        <th className="right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchResult.items.map((t) => (
                        <tr key={t._id}>
                          <td className="num nowrap">{formatDay(t.date)}</td>
                          <td>{t.description}</td>
                          <td>{t.accountName}</td>
                          <td><span className="tag">{t.categoryName}</span></td>
                          <td className={"right num " + (t.transferId ? "" : t.type === "credit" ? "pos" : "neg")}>
                            {formatMillimes(t.type === "credit" ? t.amount : -t.amount, { signed: !t.transferId })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={searchResult.page} totalPages={searchResult.totalPages} total={searchResult.total} limit={searchResult.limit} onChange={setSearchPage} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
