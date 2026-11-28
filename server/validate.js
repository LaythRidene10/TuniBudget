// Server-side validation. Every value that comes from the browser goes through one of these
// functions before it reaches the database: the type is forced, the length is capped, and
// MongoDB operators can never sneak in because only plain strings, integers and booleans come out.
import { ApiError, validationError } from "./errors.js";

export const MAX_MILLIMES = 1_000_000_000_000; // 1 billion TND, far above any real balance
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const HTML_CHARS = /[<>]/;
const ID_PATTERN = /^[a-z]{3,4}_[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123",
  "azerty123", "iloveyou1", "admin123", "welcome1", "letmein1", "11111111", "00000000", "abc12345",
]);

/** Free text typed by a user (names, descriptions). No control characters and no < > (defence against stored XSS). */
export function text(value, { min = 0, max, message }) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw validationError(message);
  const trimmed = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (trimmed.length < min || trimmed.length > max) throw validationError(message);
  if (CONTROL_CHARS.test(trimmed)) throw validationError("Remove the special characters from this text.");
  if (HTML_CHARS.test(trimmed)) throw validationError("The characters < and > are not allowed.");
  return trimmed;
}

export function email(value) {
  if (typeof value !== "string") throw validationError("Enter a valid email address.");
  const mail = value.trim().toLowerCase();
  if (mail.length > 254 || !EMAIL_PATTERN.test(mail)) throw validationError("Enter a valid email address.");
  return mail;
}

/** Password policy: 8 to 128 characters, at least one letter and one digit, not a common password, not the email. */
export function newPassword(value, { email: mail = "" } = {}) {
  if (typeof value !== "string" || value.length < 8) throw validationError("The password needs at least 8 characters.");
  if (value.length > 128) throw validationError("The password can have at most 128 characters.");
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw validationError("Use at least one letter and one digit in the password.");
  const lower = value.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) throw validationError("This password is too common. Choose another one.");
  if (mail && lower === mail.toLowerCase()) throw validationError("The password cannot be your email address.");
  return value;
}

/** A password typed at login: only checked for type and size (the policy applies when it is created). */
export function loginPassword(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ApiError("INVALID_CREDENTIALS", "Incorrect email or password.");
  }
  return value;
}

/** Document ids look like "acc_6650f2…" or "cat_food". */
export function id(value, { prefix, code = "VALIDATION_ERROR", message = "This item does not exist." } = {}) {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || (prefix && !value.startsWith(prefix + "_"))) {
    throw new ApiError(code, message);
  }
  return value;
}

export function optionalId(value, options) {
  if (value === undefined || value === null || value === "") return "";
  return id(value, options);
}

/** Money: a whole number of millimes. Accepts a number, or a digit string from a query string. */
export function millimes(value, { min = 1, message = "Enter an amount greater than 0." } = {}) {
  const number = typeof value === "string" && /^\d{1,13}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > MAX_MILLIMES) {
    throw new ApiError("INVALID_AMOUNT", message);
  }
  return number;
}

export function optionalMillimes(value) {
  if (value === undefined || value === null || value === "") return null;
  return millimes(value, { min: 0, message: "The amount filter is not valid." });
}

export function oneOf(value, allowed, message) {
  if (!allowed.includes(value)) throw validationError(message);
  return value;
}

/** A whole number from a JSON body (plan days, sort order…). */
export function integer(value, { min, max, message }) {
  const number = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw validationError(message);
  return number;
}

/** A short list of plan benefits. */
export function featureList(value, message = "Add 1 to 10 benefits, each 2 to 120 characters.") {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw validationError(message);
  return value.map((item) => text(item, { min: 2, max: 120, message }));
}

export function bool(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw validationError("Expected true or false.");
  return value;
}

export function month(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw validationError("Choose a month.");
  return value;
}

/** "YYYY-MM-DD", or "" for no date. */
export function optionalDay(value) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError("Enter a valid date.");
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw validationError("Enter a valid date.");
  return value;
}

/** Whole number from a query string, clamped between min and max. */
export function intParam(value, { fallback, min, max }) {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) throw validationError("A number in the request is not valid.");
  return Math.min(Math.max(Number(value), min), max);
}

/** Opaque token from a link (password reset). */
export function token(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new ApiError("RESET_LINK_INVALID", "This reset link is invalid or has expired. Ask for a new one.");
  }
  return value;
}

/** Rejects any field the endpoint does not expect (mass assignment protection). */
export function onlyFields(body, allowed) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw validationError("The request body must be a JSON object.");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw validationError("Unexpected field: " + extra[0].slice(0, 40) + ".");
  return body;
}
