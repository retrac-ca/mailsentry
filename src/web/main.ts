import { loadStatus, ApiError } from "./api.js";
import type { AppStatus } from "../shared/types.js";
import { h, clear, append } from "./dom.js";
import type { AppContext, View } from "./context.js";
import { renderOverview } from "./views/overview.js";
import { renderHealth } from "./views/health.js";
import { renderCleanup } from "./views/cleanup.js";
import { renderActivity } from "./views/activity.js";
import { renderSettings } from "./views/settings.js";
import { renderRoadmap } from "./views/roadmap.js";

const ROUTES: Record<string, { view: View; title: string }> = {
  overview: { view: renderOverview, title: "Overview" },
  health: { view: renderHealth, title: "Email Health" },
  cleanup: { view: renderCleanup, title: "Mailbox Cleanup" },
  activity: { view: renderActivity, title: "Activity / Results" },
  settings: { view: renderSettings, title: "Settings" },
  roadmap: { view: renderRoadmap, title: "Roadmap" },
};

const main = document.getElementById("main") as HTMLElement;
const connectionSummary = document.getElementById("connection-summary") as HTMLElement;
const banner = document.getElementById("global-banner") as HTMLElement;
const versionNode = document.getElementById("app-version") as HTMLElement;

let status: AppStatus | null = null;
let cleanupCurrent: (() => void) | undefined;

function currentRoute(): string {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const name = raw.split(/[/?]/)[0] ?? "";
  return name && ROUTES[name] ? name : "overview";
}

function updateConnectionSummary(): void {
  if (!status) {
    connectionSummary.textContent = "Connecting to local server…";
    return;
  }
  const connected = status.providers.filter((provider) => provider.connected);
  if (connected.length === 0) {
    connectionSummary.textContent = "No mailbox connected";
    return;
  }
  connectionSummary.textContent = connected
    .map(
      (provider) =>
        `${provider.displayName} (${provider.mode === "cleanup" ? "cleanup access" : "read-only"})`,
    )
    .join(" · ");
}

function setBanner(message: string | null, kind: "info" | "danger" = "info"): void {
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = `global-banner ${kind === "danger" ? "danger" : ""}`;
  banner.textContent = message;
}

function markNavigation(route: string): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".main-nav a[data-route]")) {
    if (link.dataset["route"] === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function renderCurrentRoute(): void {
  if (!status) return;
  const route = currentRoute();
  if (cleanupCurrent) {
    try {
      cleanupCurrent();
    } catch {
      // A view cleanup must not break navigation.
    }
    cleanupCurrent = undefined;
  }
  const definition = ROUTES[route] ?? ROUTES["overview"];
  if (!definition) return;
  document.title = `${definition.title} · MailSentry`;
  markNavigation(route);
  clear(main);
  const context: AppContext = {
    status,
    refreshStatus: async () => {
      const next = await loadStatus();
      status = next;
      updateConnectionSummary();
      versionNode.textContent = `v${next.version}`;
    },
    rerender: () => renderCurrentRoute(),
    navigate: (target: string) => {
      window.location.hash = `#/${target}`;
      if (currentRoute() === target) renderCurrentRoute();
    },
    setBanner,
  };
  try {
    const result = definition.view(main, context);
    cleanupCurrent = typeof result === "function" ? result : undefined;
  } catch (error) {
    clear(main);
    append(main, [
      h("h1", { text: "Something went wrong" }),
      h("p", { text: error instanceof Error ? error.message : "The view could not be rendered." }),
      h("button", {
        class: "btn",
        type: "button",
        text: "Reload",
        on: { click: () => window.location.reload() },
      }),
    ]);
  }
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "auto" });
}

function bootstrapQueryBanner(): void {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  if (connected === "gmail" || connected === "microsoft") {
    setBanner(
      `${connected === "gmail" ? "Gmail" : "Microsoft"} connected. Credentials are held in memory only; disconnect or restart MailSentry to clear them.`,
      "info",
    );
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
  }
}

async function boot(): Promise<void> {
  try {
    status = await loadStatus();
    updateConnectionSummary();
    versionNode.textContent = `v${status.version}`;
    bootstrapQueryBanner();
    renderCurrentRoute();
    window.addEventListener("hashchange", () => {
      if (banner.classList.contains("danger")) setBanner(null);
      renderCurrentRoute();
    });
  } catch (error) {
    clear(main);
    const message =
      error instanceof ApiError ? error.message : "MailSentry's local server could not be reached.";
    append(main, [
      h("div", { class: "empty" }, [
        h("h1", { text: "MailSentry could not start" }),
        h("p", { text: message }),
        h("p", {
          class: "small muted",
          text: "Start the local server with `npm start` (after `npm run build`) and reload this page.",
        }),
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Retry",
          on: { click: () => window.location.reload() },
        }),
      ]),
    ]);
  }
}

void boot();
