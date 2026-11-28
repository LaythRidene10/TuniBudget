// The only place that talks to the server.
//   - The session lives in an HttpOnly cookie set by the server: this code never sees or stores a token.
//   - Every request carries the X-Requested-With header the server requires (CSRF protection).
//   - Money movements carry a random Idempotency-Key, so a retried request never moves money twice.
import { ServiceError } from "./errors.js";

export const API_URL = "/api";

let onUnauthenticated = () => {};
/** App registers a callback here: it shows the login page when the session has ended. */
export function setUnauthenticatedHandler(handler) {
  onUnauthenticated = handler;
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? "?" + text : "";
}

export async function request(method, path, { body, query, idempotent = false } = {}) {
  const headers = { Accept: "application/json", "X-Requested-With": "TuniBudget" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotent) headers["Idempotency-Key"] = crypto.randomUUID();

  let response;
  try {
    response = await fetch(API_URL + path + queryString(query), {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServiceError("NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  // No JSON at all: the API server is not running (Vite answers instead of it).
  if (data === null) {
    throw new ServiceError(
      "SERVER_UNAVAILABLE",
      "The TuniBudget server is not responding. Start it with npm run project (it needs a .env file: see the README)."
    );
  }
  if (!response.ok) {
    const { code = "SERVER_ERROR", message = "Something went wrong. Please try again.", ...extra } = (data && data.error) || {};
    if (code === "UNAUTHENTICATED") onUnauthenticated();
    throw new ServiceError(code, message, extra);
  }
  return data;
}

/** Downloads a file (a premium CSV report) with the same session cookie and CSRF header. */
export async function downloadRequest(path, query) {
  let response;
  try {
    response = await fetch(API_URL + path + queryString(query), {
      headers: { "X-Requested-With": "TuniBudget" },
      credentials: "same-origin",
    });
  } catch {
    throw new ServiceError("NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const { code = "SERVER_ERROR", message = "The download failed. Please try again.", ...extra } = (data && data.error) || {};
    if (code === "UNAUTHENTICATED") onUnauthenticated();
    throw new ServiceError(code, message, extra);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), filename: match ? match[1] : "tunibudget-report.csv" };
}
