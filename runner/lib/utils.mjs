import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function shortHash(value) {
  return sha256(value).slice(0, 12);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), "utf8");
}

export function safePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function nowIso() {
  return new Date().toISOString();
}

export function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
