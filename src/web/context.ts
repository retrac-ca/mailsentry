import type { AppStatus } from "../shared/types.js";

export interface AppContext {
  status: AppStatus;
  refreshStatus: () => Promise<void>;
  rerender: () => void;
  navigate: (route: string) => void;
  setBanner: (message: string | null, kind?: "info" | "danger") => void;
}

export type ViewCleanup = void | (() => void);
export type View = (root: HTMLElement, context: AppContext) => ViewCleanup;
