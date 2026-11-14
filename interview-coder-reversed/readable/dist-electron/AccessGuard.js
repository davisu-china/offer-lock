"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardProviderAccess = guardProviderAccess;
exports.guardFeatureAccess = guardFeatureAccess;
const AuthHelperOverseas_1 = require("./AuthHelperOverseas");
const AppRegion_1 = require("./AppRegion");
const DomesticLicenseService_1 = require("./DomesticLicenseService");
function guardDomestic() {
  // Main-process verified state, not renderer-provided fields or editable license.json.
  const access = DomesticLicenseService_1.domesticLicenseService.access();
  return access
    ? { ok: true, region: "domestic" }
    : { ok: false, reason: "verification_required", region: "domestic" };
}
/** Feature gating belongs at model boundaries, never at recording/settings boundaries. */
function guardProviderAccess(provider) {
  const grant = guardFeatureAccess();
  if (!grant.ok || grant.region === "overseas") return grant;
  if (
    ![
      "openai",
      "gemini",
      "anthropic",
      "qwen",
      "openrouter",
      "custom",
      "custom2",
    ].includes(provider)
  ) {
    return { ...grant, ok: false, reason: "unsupported_provider" };
  }
  if (
    (provider === "custom" || provider === "custom2") &&
    !DomesticLicenseService_1.domesticLicenseService.access()?.canCustom
  ) {
    return { ...grant, ok: false, reason: "custom_requires_full_card" };
  }
  return grant;
}
function guardOverseas() {
  try {
    const st = AuthHelperOverseas_1.authHelper.load(
      AuthHelperOverseas_1.authHelper.getOrCreateDeviceId(),
    );
    if (!st || !st.token) {
      return { ok: false, reason: "not_logged_in", region: "overseas" };
    }
    if (!st.subscription) {
      return { ok: false, reason: "no_subscription", region: "overseas" };
    }
    if (st.subscription.status !== "active") {
      return {
        ok: false,
        reason: st.subscription.status || "inactive",
        region: "overseas",
      };
    }
    if (st.subscription.expires_at) {
      const exp = new Date(st.subscription.expires_at).getTime();
      if (Date.now() >= exp) {
        return { ok: false, reason: "expired", region: "overseas" };
      }
    }
    if (
      typeof st.subscription.remaining_days === "number" &&
      st.subscription.remaining_days <= 0
    ) {
      return { ok: false, reason: "expired", region: "overseas" };
    }
    return { ok: true, region: "overseas" };
  } catch (error) {
    console.error("guardOverseas error:", error);
    return { ok: false, reason: "unknown", region: "overseas" };
  }
}
function guardFeatureAccess() {
  const region = (0, AppRegion_1.getAppRegion)();
  return region === "overseas" ? guardOverseas() : guardDomestic();
}
