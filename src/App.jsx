import { useEffect, useState } from "react";
import { getCurrentUser, logout, setUnauthenticatedHandler } from "./services/index.js";
import NavBar from "./components/NavBar.jsx";
import Toast from "./components/Toast.jsx";
import { Loading } from "./components/StateMessage.jsx";
import AuthPage from "./pages/AuthPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import AccountsPage from "./pages/AccountsPage.jsx";
import TransferPage from "./pages/TransferPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import BudgetsPage from "./pages/BudgetsPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import PremiumPage from "./pages/PremiumPage.jsx";

const PAGE_TITLES = {
  dashboard: "Dashboard",
  accounts: "Accounts",
  transfer: "Transfer",
  history: "History",
  budgets: "Budgets",
  premium: "Premium",
  admin: "Admin",
};

// All shared state lives here and goes down through props (no Context, no router):
//   user    the logged-in user (null shows the login page)
//   page    which page is displayed
//   version a counter that pages watch: when it changes they reload their data
//   toast   the short message shown in the corner
//   checking true while the app asks the server whether the session cookie is still valid
export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    document.title = user ? PAGE_TITLES[page] + " - TuniBudget" : "TuniBudget";
  }, [user, page]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // On load: restore the session (the cookie is HttpOnly, so only the server can read it).
  // Later, when any call answers "session ended", go back to the login page.
  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
    getCurrentUser()
      .then((current) => setUser(current))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  function refresh() {
    setVersion((v) => v + 1);
  }

  function notify(type, message) {
    setToast({ id: Date.now(), type, message });
  }

  function handleAuthenticated(authenticatedUser) {
    setUser(authenticatedUser);
    setPage("dashboard");
    refresh();
  }

  // A subscription change alters the role shown in the navigation; reload the user from the API.
  function handleUserChange(nextUser) {
    if (nextUser) setUser(nextUser);
    refresh();
  }

  async function handleLogout() {
    await logout().catch(() => {});
    setToast(null);
    setUser(null);
  }

  if (checking) return <Loading label="Opening TuniBudget" />;
  if (!user) return <AuthPage theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")} onAuthenticated={handleAuthenticated} />;

  const shared = { user, version, onChange: refresh, notify, goTo: setPage, onUserChange: handleUserChange };

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <NavBar user={user} page={page} theme={theme} onThemeToggle={() => setTheme(theme === "light" ? "dark" : "light")} onNavigate={setPage} onLogout={handleLogout} />
      <main className="main" id="content">
        {page === "dashboard" && <DashboardPage {...shared} />}
        {page === "accounts" && <AccountsPage {...shared} />}
        {page === "transfer" && <TransferPage {...shared} />}
        {page === "history" && <HistoryPage {...shared} />}
        {page === "budgets" && <BudgetsPage {...shared} />}
        {page === "premium" && <PremiumPage {...shared} />}
        {page === "admin" && user.role === "admin" && <AdminPage {...shared} />}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
