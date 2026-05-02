import { isUrlApproved } from "../shared/match-pattern.js";

export class PermissionTracker {
  constructor() {
    this.approvedOrigins = [];
  }

  async refresh() {
    const permissions = await browser.permissions.getAll();
    this.approvedOrigins = Array.isArray(permissions.origins)
      ? permissions.origins.filter((origin) => typeof origin === "string")
      : [];
    return this.approvedOrigins.slice();
  }

  getOrigins() {
    return this.approvedOrigins.slice();
  }

  isApproved(rawUrl) {
    return isUrlApproved(this.approvedOrigins, rawUrl);
  }

  watch(callback) {
    const listener = async () => {
      await this.refresh();
      callback(this.getOrigins());
    };
    browser.permissions.onAdded.addListener(listener);
    browser.permissions.onRemoved.addListener(listener);
  }
}
