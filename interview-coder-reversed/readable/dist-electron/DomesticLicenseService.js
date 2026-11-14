"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.domesticLicenseService = void 0;
const node_events_1 = require("node:events");
const LicenseHelper_1 = require("./LicenseHelper");
const AppRegion_1 = require("./AppRegion");
const ClientServiceHttp_1 = require("./ClientServiceHttp");
class DomesticLicenseService extends node_events_1.EventEmitter {
  constructor() {
    super(...arguments);
    this.verified = null;
    this.generation = 0;
    this.request = null;
    this.activating = false;
  }
  /** No offline grant is restored. Each process must verify online before granting access. */
  unavailable(error, activation) {
    // A failed attempt to switch cards must not revoke the previous card.
    // A failed periodic/startup check pauses access until online verification succeeds.
    if (!activation && this.verified) {
      this.verified = null;
      this.emit("changed", null);
    }
    return { ok: false, error };
  }
  access() {
    return this.verified && this.verified.expiresAt > Date.now()
      ? { ...this.verified }
      : null;
  }
  async refresh(activateCode) {
    if ((0, AppRegion_1.getAppRegion)() !== "domestic")
      return { ok: false, error: "domestic_only" };
    if (activateCode === undefined && this.activating)
      return { ok: false, error: "activation_pending" };
    const device = LicenseHelper_1.licenseHelper.getOrCreateDeviceId();
    const previous = LicenseHelper_1.licenseHelper.load(device);
    const code = (
      activateCode === undefined ? previous?.code : activateCode
    )?.trim();
    if (!code || code.length > 64)
      return this.unavailable("invalid_card", activateCode !== undefined);
    const generation = ++this.generation;
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    this.activating = activateCode !== undefined;
    try {
      const path =
        activateCode === undefined
          ? "/api/card/validate?" +
            new URLSearchParams({ code, device_id: device }).toString()
          : "/api/card/activate";
      const response = await (0, ClientServiceHttp_1.serviceRequest)(
        path,
        activateCode === undefined ? undefined : { code, device_id: device },
        controller.signal,
      );
      if (generation !== this.generation)
        return { ok: false, error: "superseded" };
      const data = response.data?.data;
      if (response.status >= 300 && response.status < 400)
        return this.unavailable(
          "redirect_rejected",
          activateCode !== undefined,
        );
      if (response.status >= 500 || !response.data)
        return this.unavailable(
          "service_unavailable",
          activateCode !== undefined,
        );
      if (response.data.code !== 200 || !data) {
        // Failed activation keeps the previous card. Explicit validation denial revokes the current one.
        if (
          activateCode === undefined &&
          [400, 403, 404].includes(response.data.code)
        ) {
          this.revoke(previous, device, "unused");
        }
        return this.unavailable("license_rejected", activateCode !== undefined);
      }
      if (
        data.status !== "active" ||
        data.valid === false ||
        typeof data.remaining_seconds !== "number" ||
        !Number.isFinite(data.remaining_seconds) ||
        !(data.remaining_seconds > 0)
      ) {
        if (activateCode === undefined || code === previous?.code) {
          this.revoke(previous, device, data.status || "unused", data);
        }
        return { ok: false, status: data.status || "unused" };
      }
      // Verified HTTPS response binds the full submitted card. Never accept renderer can_custom.
      // T/M fallback permits existing servers to roll out before the additive entitlement response.
      const expected = code.startsWith("S")
        ? "basic"
        : /^[TM]/.test(code)
          ? "full"
          : "unsupported";
      const tier = data.entitlement_version === 1 ? data.tier : expected;
      if (
        tier !== expected ||
        tier === "unsupported" ||
        (data.entitlement_version === 1 &&
          data.can_custom !== (tier === "full"))
      ) {
        if (activateCode === undefined) this.revoke(previous, device, "unused");
        return { ok: false, error: "unsupported_card" };
      }
      const changedCard = this.verified?.code !== code;
      this.verified = {
        code,
        tier,
        canCustom: tier === "full",
        expiresAt:
          Date.now() +
          Math.min(Number(data.remaining_seconds), 100 * 365 * 86400) * 1000,
      };
      const state = {
        code,
        device_id: device,
        status: "active",
        expires_at: data.expires_at,
        remaining_seconds: data.remaining_seconds,
        last_validated_at: new Date().toISOString(),
        trial_started_at: previous?.trial_started_at,
      };
      LicenseHelper_1.licenseHelper.save(state);
      // Only activated/changed cards notify backup; ordinary heartbeats must not upload repeatedly.
      if (changedCard) this.emit("changed", this.access());
      return {
        ok: true,
        status: "active",
        state: { ...state, tier, can_custom: tier === "full" },
      };
    } catch {
      // No fallback to a saved/local permission after a failed online license check.
      return this.unavailable("network_error", activateCode !== undefined);
    } finally {
      if (generation === this.generation) {
        this.request = null;
        this.activating = false;
      }
    }
  }
  revoke(previous, device, status, data) {
    this.verified = null;
    if (previous)
      LicenseHelper_1.licenseHelper.save({
        ...previous,
        device_id: device,
        status,
        expires_at:
          typeof data?.expires_at === "string" ? data.expires_at : undefined,
        remaining_seconds:
          status === "expired"
            ? 0
            : typeof data?.remaining_seconds === "number" &&
                Number.isFinite(data.remaining_seconds) &&
                data.remaining_seconds >= 0
              ? data.remaining_seconds
              : undefined,
        last_validated_at: new Date().toISOString(),
      });
    this.emit("changed", null);
  }
}
exports.domesticLicenseService = new DomesticLicenseService();
