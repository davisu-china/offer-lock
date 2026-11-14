"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAppRegion = resolveAppRegion;
exports.getAppRegion = getAppRegion;
exports.isOverseasRegion = isOverseasRegion;
const OVERSEAS_REGION_ALIASES = new Set([
  "overseas",
  "oversea",
  "global",
  "intl",
  "international",
]);
function normalizeRegionCandidate(value) {
  return (value || "").trim().toLowerCase();
}
function resolveAppRegion(value) {
  const normalized = normalizeRegionCandidate(value);
  return OVERSEAS_REGION_ALIASES.has(normalized) ? "overseas" : "domestic";
}
function getAppRegion() {
  const envRegion =
    process.env.VITE_APP_REGION || process.env.APP_REGION || process.env.REGION;
  return resolveAppRegion(envRegion);
}
function isOverseasRegion() {
  return getAppRegion() === "overseas";
}
