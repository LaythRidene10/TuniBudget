import { useEffect, useState } from "react";
import { getAdminUsers, getAuditLogs, getSecuritySummary, revokeUserSessions, setUserDisabled } from "../services/index.js";
import { formatDayYear } from "../utils/dates.js";
import Icon from "../components/Icon.jsx";
import AdminSubscriptions from "../components/AdminSubscriptions.jsx";
import { EmptyState, ErrorState, Loading } from "../components/StateMessage.jsx";

const LEVELS = [
  { id: "", label: "All" },
  { id: "warn", label: "Blocked" },
  { id: "alert", label: "Alerts" },
];

const LEVEL_BADGES = { info: "badge--ok", warn: "badge--near", alert: "badge--exceeded" };

function when(date) {
  if (!date) return "Never";
  const d = new Date(date);
  return formatDayYear(d) + ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function eventLabel(event) {
  const text = event.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Only shown to admins. The server checks the role again on every call. */
export default function AdminPage({ user, version, onChange, notify }) {
  const [data, setData] = useState(null); // { summary, users }
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [level, setLevel] = useState("");
  const [logs, setLogs] = useState(null);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([getSecuritySummary(), getAdminUsers()])
      .then(([summary, users]) => {
        if (!cancelled) setData({ summary, users });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [version, attempt]);

  useEffect(() => {
    let cancelled = false;
    getAuditLogs({ level })
      .then((result) => {
        if (!cancelled) setLogs(result.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [level, version, attempt]);

  if (error && !data) return <ErrorState message={error} onRetry={() => setAttempt(attempt + 1)} />;
  if (!data) return <Loading label="Loading the admin data" />;

  const { summary, users } = data;
  const blocked = summary.events.filter((e) => !/succeeded|registered|access|committed|requested|completed/.test(e.event));
  const blockedTotal = blocked.reduce((sum, e) => sum + e.count, 0);

  async function run(target, action, successMessage) {
    setBusyId(target._id);
    try {
      await action();
      notify("success", successMessage);
      onChange();
    } catch (err) {
      notify("error", err.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Admin</h1>
        </div>
      </div>

      <div className="columns columns--stretch">
        <section className="panel summary" aria-labelledby="admin-summary-title">
          <h2 className="panel__title" id="admin-summary-title">
            Last 24 hours
          </h2>
          <dl className="summary__list">
            <div className="summary__row">
              <dt>Users</dt>
              <dd className="summary__value num">{users.length}</dd>
            </div>
            <div className="summary__row">
              <dt>Active sessions</dt>
              <dd className="summary__value num">{summary.activeSessions}</dd>
            </div>
            <div className="summary__row">
              <dt>Blocked requests</dt>
              <dd className="summary__value num">{blockedTotal}</dd>
            </div>
            <div className="summary__row summary__row--total">
              <dt>Alerts</dt>
              <dd className="summary__total num">{summary.alerts.length}</dd>
            </div>
          </dl>
        </section>

        <section className="panel grow-wide" aria-labelledby="admin-events-title">
          <h2 className="panel__title" id="admin-events-title">
            Events by type
          </h2>
          {summary.events.length === 0 ? (
            <EmptyState title="Nothing happened in the last 24 hours" />
          ) : (
            <ul className="closed-list">
              {summary.events.map((e) => (
                <li key={e.event} className="closed-list__row">
                  <span>{eventLabel(e.event)}</span>
                  <span className="num">{e.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {summary.alerts.length > 0 && (
        <p className="notice notice--error columns--gap-top" role="alert">
          <Icon name="warning" />
          Latest alert: {summary.alerts[0].details.blockedEventsInLast15Minutes} blocked requests from {summary.alerts[0].ip} ({when(summary.alerts[0].at)}).
        </p>
      )}

      <section className="panel columns--gap-top" aria-labelledby="admin-users-title">
        <h2 className="panel__title" id="admin-users-title">
          Users
        </h2>
        <div className="table-wrap columns--gap-top">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last log-in</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isMe = u._id === user._id;
                return (
                  <tr key={u._id}>
                    <td>
                      {u.fullName}
                      {u.disabled && <span className="badge badge--exceeded admin__inline-badge">Disabled</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      <span className="tag">{u.role === "admin" ? "Admin" : "User"}</span>
                    </td>
                    <td className="nowrap muted">{when(u.lastLoginAt)}</td>
                    <td className="right">
                      {isMe ? (
                        <span className="muted small">You</span>
                      ) : (
                        <div className="row admin__actions">
                          <button
                            type="button"
                            className="btn btn--small"
                            disabled={busyId === u._id}
                            onClick={() => run(u, () => revokeUserSessions(u._id), u.fullName + " was logged out of every device.")}
                          >
                            Log out everywhere
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            disabled={busyId === u._id}
                            onClick={() => run(u, () => setUserDisabled(u._id, !u.disabled), u.fullName + (u.disabled ? " can log in again." : " can no longer log in."))}
                          >
                            {u.disabled ? "Enable" : "Disable"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <AdminSubscriptions version={version} users={users} notify={notify} onChange={onChange} />

      <section className="panel columns--gap-top" aria-labelledby="admin-log-title">
        <div className="panel__head">
          <h2 className="panel__title" id="admin-log-title">
            Security log
          </h2>
          <div className="segmented" role="group" aria-label="Show">
            {LEVELS.map((l) => (
              <button key={l.id} type="button" className="segmented__option" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        {!logs ? (
          <Loading label="Loading the log" />
        ) : logs.length === 0 ? (
          <EmptyState title="No event to show" />
        ) : (
          <div className="table-wrap columns--gap-top">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Level</th>
                  <th>IP</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log._id}>
                    <td className="nowrap muted">{when(log.at)}</td>
                    <td>{eventLabel(log.event)}</td>
                    <td>
                      <span className={"badge " + (LEVEL_BADGES[log.level] || "")}>{log.level}</span>
                    </td>
                    <td className="num">{log.ip || "—"}</td>
                    <td className="muted small">{log.path || "—"}</td>
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
