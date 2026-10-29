import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import type { Event as ElectronEvent, MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, loadDotEnv, type AppConfig } from "../core/config.js";
import { MailSentryApp } from "../server/app.js";
import { createLogger } from "../security/logger.js";
import { redactString, safeErrorMessage } from "../security/redact.js";
import {
  assertDesktopConfig,
  deriveWindowState,
  ensureDesktopDirectories,
  isAllowedNavigation,
  parseSmokePath,
  readWindowState,
  resolveDesktopPaths,
  writeWindowState,
  type DesktopPaths,
} from "./runtime.js";

const log = createLogger("desktop");
const APP_ID = "ca.retrac.mailsentry";
const PARTITION = "mailsentry";

let mainWindow: BrowserWindow | null = null;
let sentry: MailSentryApp | null = null;
let desktopConfig: AppConfig | null = null;
let desktopPaths: DesktopPaths | null = null;
let allowQuit = false;
let shutdownPromise: Promise<void> | null = null;
let fatalHandled = false;
let smokeTimer: NodeJS.Timeout | null = null;
const smokeFile = parseSmokePath(process.argv, process.env);

app.setName("MailSentry");
app.setAppUserModelId(APP_ID);

const userDataOverride = process.env["MAILSENTRY_USER_DATA_DIR"];
if (userDataOverride) {
  app.setPath("userData", resolve(userDataOverride));
}

function openExternal(rawUrl: string): void {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return;
    void shell.openExternal(url.toString()).catch((error: unknown) => {
      log.warn("could not open external browser", { error });
    });
  } catch {
    // Ignore malformed or non-web URLs.
  }
}

function guardNavigation(event: ElectronEvent, rawUrl: string): void {
  if (!desktopConfig) {
    event.preventDefault();
    return;
  }
  const origin = new URL(desktopConfig.baseUrl).origin;
  if (isAllowedNavigation(rawUrl, origin)) return;
  event.preventDefault();
  openExternal(rawUrl);
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  if (!app.isPackaged) {
    template.push({
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function writeSmokeResult(result: Record<string, unknown>): void {
  if (!smokeFile) return;
  try {
    mkdirSync(dirname(smokeFile), { recursive: true });
    writeFileSync(
      smokeFile,
      `${JSON.stringify(
        {
          ...result,
          timestamp: new Date().toISOString(),
          pid: process.pid,
          platform: process.platform,
          electron: process.versions.electron,
          node: process.versions.node,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    log.error("could not write smoke result", { error });
  }
}

function failStartup(error: unknown): void {
  if (fatalHandled) return;
  fatalHandled = true;
  const message = redactString(error instanceof Error ? error.message : "Unknown startup error.");
  log.error("desktop startup failed", { error });
  writeSmokeResult({ ok: false, error: message });
  if (smokeFile) {
    app.exit(1);
    return;
  }
  dialog.showErrorBox(
    "MailSentry could not start",
    `${message}\n\nLog: ${desktopPaths?.logFile ?? "unavailable"}\nConfig folder: ${
      desktopPaths?.userDataDir ?? "unavailable"
    }`,
  );
  app.quit();
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  try {
    const result = (await window.webContents.executeJavaScript(
      `(async () => {
        const started = Date.now();
        while (Date.now() - started < 6000) {
          if (document.querySelector("#main h1")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const response = await fetch("/api/status");
        const status = await response.json();
        const heading = document.querySelector("#main h1")?.textContent ?? null;
        if (!heading) throw new Error("The main interface heading did not render.");
        return {
          title: document.title,
          heading,
          navItems: document.querySelectorAll(".main-nav a").length,
          name: status.name,
          version: status.version,
          providers: Array.isArray(status.providers)
            ? status.providers.map((provider) => ({
                provider: provider.provider,
                configured: provider.configured,
              }))
            : [],
        };
      })()`,
      true,
    )) as Record<string, unknown>;
    if (smokeTimer) clearTimeout(smokeTimer);
    writeSmokeResult({ ok: true, ...result });
    app.quit();
  } catch (error) {
    if (smokeTimer) clearTimeout(smokeTimer);
    writeSmokeResult({ ok: false, error: safeErrorMessage(error) });
    app.quit();
  }
}

function createWindow(): void {
  if (!desktopConfig || !desktopPaths) return;
  const state = readWindowState(desktopPaths.windowStateFile);
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "MailSentry",
    backgroundColor: "#f3f6f7",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      failStartup(new Error(`The MailSentry interface failed to load (${code}): ${description}`));
    }
  });

  window.once("ready-to-show", () => {
    if (!smokeFile) window.show();
  });
  let closeConfirmed = false;
  window.on("close", (event) => {
    if (!closeConfirmed && sentry?.hasActiveJobs()) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        title: "Cleanup in progress",
        message: "A cleanup operation is still running.",
        detail:
          "Quitting now interrupts it. Completed changes are not rolled back, and in-flight operations may be uncertain. " +
          "Open Activity in the app to review progress first.",
        buttons: ["Keep MailSentry open", "Quit anyway"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice === 1) {
        closeConfirmed = true;
        window.close();
      }
      return;
    }
    if (desktopPaths && !window.isDestroyed()) {
      writeWindowState(
        desktopPaths.windowStateFile,
        deriveWindowState(window.getNormalBounds(), window.isMaximized()),
      );
    }
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  if (state.maximized) window.maximize();

  if (smokeFile) {
    smokeTimer = setTimeout(() => {
      writeSmokeResult({ ok: false, error: "Timed out waiting for the interface to load." });
      app.quit();
    }, 30_000);
    smokeTimer.unref?.();
    window.webContents.once("did-finish-load", () => {
      void runSmoke(window);
    });
  }

  void window.loadURL(desktopConfig.baseUrl).catch((error: unknown) => {
    failStartup(error);
  });
}

async function start(): Promise<void> {
  desktopPaths = resolveDesktopPaths(app.getPath("userData"));
  ensureDesktopDirectories(desktopPaths);
  process.env["MAILSENTRY_LOG_FILE"] ??= desktopPaths.logFile;

  const appRoot = app.getAppPath();
  const exampleSource = join(appRoot, ".env.example");
  if (existsSync(exampleSource) && !existsSync(desktopPaths.configExampleFile)) {
    try {
      writeFileSync(desktopPaths.configExampleFile, readFileSync(exampleSource), "utf8");
    } catch (error) {
      log.warn("could not write desktop config example", { error });
    }
  }

  loadDotEnv(desktopPaths.userDataDir);
  if (!app.isPackaged) loadDotEnv(appRoot);

  desktopConfig = loadConfig();
  assertDesktopConfig(desktopConfig);

  sentry = new MailSentryApp(desktopConfig, appRoot);
  await sentry.start();
  log.info("desktop server ready", { url: desktopConfig.baseUrl });

  const partitionSession = session.fromPartition(PARTITION);
  partitionSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partitionSession.setPermissionCheckHandler(() => false);
  // The desktop app never needs persistent browser cookies or cached provider
  // pages. Clear them at startup so OAuth sign-in state does not outlive the
  // in-memory server session.
  await partitionSession.clearStorageData();
  await partitionSession.clearCache();

  installMenu();
  createWindow();
}

function focusExistingWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", focusExistingWindow);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.on("activate", () => {
    if (!mainWindow && desktopConfig) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        try {
          await sentry?.stop();
        } catch (error) {
          log.warn("error while stopping local server", { error });
        } finally {
          allowQuit = true;
          app.quit();
        }
      })();
    }
  });
  app.whenReady().then(start).catch(failStartup);
}
