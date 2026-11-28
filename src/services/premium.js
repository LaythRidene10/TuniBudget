import { downloadRequest, request } from "./api.js";

export function getPremiumAnalytics(months = 12) {
  return request("GET", "/premium/analytics", { query: { months } });
}

export function getYearComparison(year) {
  return request("GET", "/premium/comparison", { query: { year } });
}

export function getInsights(month = "") {
  return request("GET", "/premium/insights", { query: { month } });
}

export function searchTransactions(filters = {}) {
  return request("GET", "/premium/search", { query: filters });
}

export function getReport({ from = "", to = "" } = {}) {
  return request("GET", "/premium/reports", { query: { from, to } });
}

export function downloadReport({ from = "", to = "" } = {}) {
  return downloadRequest("/premium/reports/download", { from, to });
}

export function getGoals() {
  return request("GET", "/premium/goals");
}

export function createGoal(goal) {
  return request("POST", "/premium/goals", { body: goal });
}

export function updateGoal(goalId, changes) {
  return request("PATCH", "/premium/goals/" + encodeURIComponent(goalId), { body: changes });
}

export function contributeToGoal(goalId, amount) {
  return request("POST", "/premium/goals/" + encodeURIComponent(goalId) + "/contribute", { body: { amount } });
}

export function removeGoal(goalId) {
  return request("DELETE", "/premium/goals/" + encodeURIComponent(goalId));
}
