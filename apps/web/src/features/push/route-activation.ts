import type { MomentActivation } from "../../notification-activation.js";

interface RouteWindow {
  dispatchEvent(event: Event): boolean;
  history: Pick<History, "pushState">;
}

/**
 * Reuses the mounted router so a warm activation does not recreate the
 * persistent audio element. AppRouter already observes the popstate event.
 */
export function navigateFromNotificationActivation(
  activation: MomentActivation,
  target: RouteWindow = window,
) {
  target.history.pushState({}, "", activation.url);
  const event =
    typeof PopStateEvent === "function"
      ? new PopStateEvent("popstate")
      : new Event("popstate");
  target.dispatchEvent(event);
}
