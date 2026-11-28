import { useEffect, useState } from "react";
import { login, register, requestPasswordReset, resetPassword } from "../services/index.js";
import { StarMark, StarPattern } from "../components/StarMark.jsx";
import Icon from "../components/Icon.jsx";
import ThemeToggle from "../components/ThemeToggle.jsx";

const TITLES = {
  login: "Welcome back",
  register: "Open your first account",
  forgot: "Forgot your password?",
  reset: "Choose a new password",
};

const SUBMIT_LABELS = { login: "Log in", register: "Create my account", forgot: "Send the reset link", reset: "Save my new password" };

// Development only: the seeder creates these accounts with a known password.
const DEMO_ACCOUNTS = [
  { label: "Admin demo", email: "admin@demo.com", password: "AdminDemo123!" },
  { label: "Premium demo", email: "premium@demo.com", password: "PremiumDemo123!" },
  { label: "Free user demo", email: "user@demo.com", password: "UserDemo123!" },
];

// The reset link looks like https://app/?reset=<token>. Read once when the page opens.
function tokenFromUrl() {
  return new URLSearchParams(window.location.search).get("reset") || "";
}

export default function AuthPage({ theme, onThemeToggle, onAuthenticated }) {
  const [resetToken] = useState(tokenFromUrl);
  const [mode, setMode] = useState(resetToken ? "reset" : "login");
  const [form, setForm] = useState({ fullName: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Remove the token from the address bar, so it is not kept in the history or shared by mistake.
  useEffect(() => {
    if (resetToken) window.history.replaceState(null, "", window.location.pathname);
  }, [resetToken]);

  const isLogin = mode === "login";
  const showTabs = mode === "login" || mode === "register";
  const showDemoLogin = import.meta.env.DEV && isLogin;

  function update(field, value) {
    setForm({ ...form, [field]: value });
    setError("");
  }

  function switchMode(next) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (mode === "reset" && form.password !== form.confirm) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login" || mode === "register") {
        const result = isLogin ? await login(form.email, form.password) : await register(form);
        onAuthenticated(result.user);
        return;
      }
      if (mode === "forgot") {
        const result = await requestPasswordReset(form.email);
        setNotice(result.message);
      } else {
        const result = await resetPassword(resetToken, form.password);
        setForm({ ...form, password: "", confirm: "" });
        setMode("login");
        setNotice(result.message);
      }
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function tryDemo(email, password) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await login(email, password);
      onAuthenticated(result.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth__hero">
        <StarPattern id="auth-pattern" opacity={0.09} />
        <div className="auth__brand">
          <StarMark size={34} color="#fbf38c" dot="#0b0d0c" />
          <span className="brand__name">TuniBudget</span>
        </div>
        <div className="auth__pitch">
          <h1 className="auth__headline">Every millime in its place.</h1>
          <p>Accounts, transfers and budgets in dinar.</p>
        </div>
      </section>

      <section className="auth__panel">
        <ThemeToggle theme={theme} onToggle={onThemeToggle} />
        <form className="auth__form" onSubmit={submit} noValidate>
          {showTabs && (
            <div className="auth__tabs" role="group" aria-label="Choose an action">
              <button type="button" aria-pressed={isLogin} onClick={() => switchMode("login")}>
                Log in
              </button>
              <button type="button" aria-pressed={mode === "register"} onClick={() => switchMode("register")}>
                Create an account
              </button>
            </div>
          )}

          <div>
            <h2 className="auth__title">{TITLES[mode]}</h2>
          </div>

          {notice && (
            <p className="notice notice--ok" role="status">
              <Icon name="check" />
              {notice}
            </p>
          )}

          {mode === "register" && (
            <label className="field">
              Full name
              <input className="input" autoComplete="name" maxLength={80} value={form.fullName} onChange={(e) => update("fullName", e.target.value)} placeholder="First and last name" />
            </label>
          )}
          {mode !== "reset" && (
            <label className="field">
              Email address
              <input className="input" type="email" autoComplete="email" maxLength={254} value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.tn" />
            </label>
          )}
          {mode !== "forgot" && (
            <label className="field">
              {mode === "reset" ? "New password" : "Password"}
              <input
                className="input"
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                maxLength={128}
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
          )}
          {mode === "reset" && (
            <label className="field">
              Repeat the new password
              <input className="input" type="password" autoComplete="new-password" maxLength={128} value={form.confirm} onChange={(e) => update("confirm", e.target.value)} />
            </label>
          )}

          {error && (
            <p className="form-error" role="alert">
              <Icon name="warning" />
              {error}
            </p>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Please wait…" : SUBMIT_LABELS[mode]}
          </button>

          {showDemoLogin && (
            <>
              <div className="auth__demo-grid">
                {DEMO_ACCOUNTS.map((account) => (
                  <button key={account.email} type="button" className="btn btn--small" onClick={() => tryDemo(account.email, account.password)} disabled={busy}>
                    {account.label}
                  </button>
                ))}
              </div>
              <p className="auth__demo-note">
                Demo accounts are created by <code>npm run seed:demo</code>. Never enabled in production.
              </p>
            </>
          )}
          {isLogin && (
            <>
              <button type="button" className="link-button auth__switch" onClick={() => switchMode("forgot")}>
                Forgot your password?
              </button>
            </>
          )}
          {(mode === "forgot" || mode === "reset") && (
            <button type="button" className="link-button auth__switch" onClick={() => switchMode("login")}>
              Back to log in
            </button>
          )}

        </form>
      </section>
    </div>
  );
}
