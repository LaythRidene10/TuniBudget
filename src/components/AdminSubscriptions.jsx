import { useEffect, useState } from "react";
import {
  activateAdminSubscription,
  deactivateAdminSubscription,
  getAdminPlans,
  getAdminSubscriptionStats,
  getAdminSubscriptions,
  grantSubscription,
  suspendAdminSubscription,
  updateAdminPlan,
} from "../services/index.js";
import { formatDayYear } from "../utils/dates.js";
import { formatMillimes, formatTnd, parseTndToMillimes } from "../utils/money.js";
import Icon from "./Icon.jsx";
import { EmptyState, ErrorState, Loading } from "./StateMessage.jsx";

function statusClass(status) {
  if (status === "active") return "badge--ok";
  if (status === "cancelled") return "badge--near";
  if (status === "suspended") return "badge--exceeded";
  return "badge--muted";
}

/** Subscription statistics, plan pricing and the subscription actions of the admin panel. */
export default function AdminSubscriptions({ version, users, notify, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [grant, setGrant] = useState({ userId: "", planId: "" });
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([getAdminSubscriptionStats(), getAdminSubscriptions(), getAdminPlans()])
      .then(([stats, subscriptions, plans]) => {
        if (cancelled) return;
        setData({ stats, subscriptions, plans });
        setDrafts(
          Object.fromEntries(
            plans.map((plan) => [plan._id, { name: plan.name, price: (plan.price / 1000).toFixed(3), days: String(plan.days) }])
          )
        );
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [version, attempt]);

  if (error && !data) return <ErrorState message={error} onRetry={() => setAttempt(attempt + 1)} />;
  if (!data) return <Loading label="Loading subscriptions" />;

  const { stats, subscriptions, plans } = data;
  const activePlans = plans.filter((plan) => plan.active !== false);
  const grantUserId = grant.userId || (users[0] ? users[0]._id : "");
  const grantPlanId = grant.planId || (activePlans[0] ? activePlans[0]._id : "");

  async function run(key, action, message) {
    setBusy(key);
    try {
      await action();
      notify("success", message);
      onChange();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setBusy("");
    }
  }

  function savePlan(plan) {
    const draft = drafts[plan._id];
    const price = parseTndToMillimes(draft.price);
    const days = Number(draft.days);
    if (price === null || price <= 0) return notify("error", "Enter a valid price greater than 0.");
    if (!Number.isInteger(days) || days < 1 || days > 4000) return notify("error", "The duration must be 1 to 4000 days.");
    run("plan_" + plan._id, () => updateAdminPlan(plan._id, { name: draft.name, price, days }), "Plan updated.");
  }

  return (
    <>
      <section className="panel columns--gap-top" aria-labelledby="sub-stats-title">
        <div className="panel__head">
          <h2 className="panel__title" id="sub-stats-title">
            Subscription statistics
          </h2>
          <span className="tag">All values in millimes</span>
        </div>
        <div className="stat-grid">
          <div className="stat"><p className="stat__label">Users</p><p className="stat__value num">{stats.users.total}</p></div>
          <div className="stat"><p className="stat__label">Premium</p><p className="stat__value num pos">{stats.users.premium}</p></div>
          <div className="stat"><p className="stat__label">Free</p><p className="stat__value num">{stats.users.free}</p></div>
          <div className="stat"><p className="stat__label">Active subscriptions</p><p className="stat__value num">{stats.subscriptions.active}</p></div>
          <div className="stat"><p className="stat__label">Expiring in 7 days</p><p className="stat__value num">{stats.subscriptions.expiringSoon}</p></div>
          <div className="stat"><p className="stat__label">Revenue</p><p className="stat__value num pos">{formatTnd(stats.revenue.total)}</p></div>
          <div className="stat"><p className="stat__label">Last 30 days</p><p className="stat__value num pos">{formatTnd(stats.revenue.last30Days)}</p></div>
          <div className="stat"><p className="stat__label">Payments</p><p className="stat__value num">{stats.revenue.payments}</p></div>
        </div>
      </section>

      <section className="panel columns--gap-top" aria-labelledby="sub-list-title">
        <div className="panel__head">
          <h2 className="panel__title" id="sub-list-title">
            User subscriptions
          </h2>
          <span className="tag">{subscriptions.total} in total</span>
        </div>
        {subscriptions.items.length === 0 ? (
          <EmptyState title="No subscription yet">Grant a plan below or let a user upgrade from the Premium page.</EmptyState>
        ) : (
          <div className="table-wrap columns--gap-top">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.items.map((subscription) => (
                  <tr key={subscription._id}>
                    <td>
                      <p>{subscription.user.fullName}</p>
                      <p className="muted small">{subscription.user.email}</p>
                    </td>
                    <td>{subscription.planName}</td>
                    <td><span className={"badge " + statusClass(subscription.status)}>{subscription.status}</span></td>
                    <td className="nowrap muted">{formatDayYear(subscription.expiresAt)}</td>
                    <td className="right">
                      <div className="row admin__actions">
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={busy !== ""}
                          onClick={() => run(subscription._id, () => activateAdminSubscription(subscription._id), "Subscription activated.")}
                        >
                          Activate
                        </button>
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={busy !== "" || subscription.status === "suspended"}
                          onClick={() => run(subscription._id, () => suspendAdminSubscription(subscription._id), "Subscription suspended.")}
                        >
                          Suspend
                        </button>
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={busy !== "" || subscription.status === "expired"}
                          onClick={() => run(subscription._id, () => deactivateAdminSubscription(subscription._id), "Premium access revoked.")}
                        >
                          Deactivate
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form
          className="filters columns--gap-top"
          onSubmit={(event) => {
            event.preventDefault();
            run("grant", () => grantSubscription(grantUserId, grantPlanId), "Subscription granted.");
          }}
        >
          <label className="field">
            Give a plan to
            <select className="input" value={grantUserId} onChange={(e) => setGrant({ ...grant, userId: e.target.value })}>
              {users.filter((u) => u.role !== "admin").map((u) => (
                <option key={u._id} value={u._id}>{u.fullName} ({u.email})</option>
              ))}
            </select>
          </label>
          <label className="field">
            Plan
            <select className="input" value={grantPlanId} onChange={(e) => setGrant({ ...grant, planId: e.target.value })}>
              {activePlans.map((plan) => (
                <option key={plan._id} value={plan._id}>{plan.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy !== "" || !grantUserId || !grantPlanId}>
            Grant subscription
          </button>
        </form>
      </section>

      <section className="panel columns--gap-top" aria-labelledby="plans-admin-title">
        <div className="panel__head">
          <h2 className="panel__title" id="plans-admin-title">
            Plans and pricing
          </h2>
          <span className="tag">{plans.length} plans</span>
        </div>
        <div className="plan-grid columns--gap-top">
          {plans.map((plan) => {
            const draft = drafts[plan._id] || { name: plan.name, price: (plan.price / 1000).toFixed(3), days: String(plan.days) };
            return (
              <article key={plan._id} className={"plan-card" + (plan.active === false ? " plan-card--off" : "")}>
                <div className="plan-card__head">
                  <h3 className="plan-card__name">{plan.code}</h3>
                  <span className={"badge " + (plan.active === false ? "badge--muted" : "badge--ok")}>{plan.active === false ? "Off" : "On"}</span>
                </div>
                <label className="field">
                  Name
                  <input className="input" value={draft.name} onChange={(e) => setDrafts({ ...drafts, [plan._id]: { ...draft, name: e.target.value } })} />
                </label>
                <div className="filters">
                  <label className="field">
                    Price
                    <span className="input-money">
                      <input className="input num" inputMode="decimal" value={draft.price} onChange={(e) => setDrafts({ ...drafts, [plan._id]: { ...draft, price: e.target.value } })} />
                      <span className="input-money__unit">TND</span>
                    </span>
                  </label>
                  <label className="field">
                    Days
                    <input className="input num" inputMode="numeric" value={draft.days} onChange={(e) => setDrafts({ ...drafts, [plan._id]: { ...draft, days: e.target.value } })} />
                  </label>
                </div>
                <p className="muted small">{plan.interval === "year" ? "Yearly" : "Monthly"} · {formatMillimes(plan.price)} TND</p>
                <div className="row">
                  <button type="button" className="btn btn--small" disabled={busy !== ""} onClick={() => savePlan(plan)}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy !== ""}
                    onClick={() => run("toggle_" + plan._id, () => updateAdminPlan(plan._id, { active: plan.active === false }), plan.active === false ? "Plan activated." : "Plan deactivated.")}
                  >
                    {plan.active === false ? "Activate" : "Deactivate"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {stats.recentPayments.length > 0 && (
        <section className="panel columns--gap-top" aria-labelledby="payments-title">
          <h2 className="panel__title" id="payments-title">
            Recent payments
          </h2>
          <div className="table-wrap columns--gap-top">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>When</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentPayments.map((payment) => (
                  <tr key={payment._id}>
                    <td>{payment.user.fullName}</td>
                    <td>{payment.planName}</td>
                    <td className="num pos">{formatTnd(payment.amount)}</td>
                    <td className="nowrap muted">{formatDayYear(payment.paidAt)}</td>
                    <td>{payment.testMode ? <span className="badge badge--near"><Icon name="info" /> Test</span> : "Live"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
