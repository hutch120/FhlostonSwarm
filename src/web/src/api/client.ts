import { DEMO_RUN_ID, type ScanStatus, type ScanSummary } from "@swarm/shared";
import type { IntakeValues } from "../intake.js";
import type { Role } from "../state/session.js";
import { createHttpAuthApi, type AuthApi } from "./http.js";
import { MOCK_ACCOUNT, MOCK_RUNS, MOCK_SCANS, type AccountInfo, type RunListItem } from "./mock.js";

export type { AccountInfo, RunListItem } from "./mock.js";
export { ApiError, messageFor } from "./http.js";

/**
 * The API surface the screens use. Auth and account are real; runs and saved scans are still mock
 * until Phase 4.
 */
export interface ApiClient extends AuthApi {
  listRuns(): Promise<RunListItem[]>;
  getAccount(): Promise<AccountInfo>;
  /** Saves the target and scan settings, then starts the first run. */
  submitIntake(values: IntakeValues): Promise<{ runId: string }>;
  deleteRun(runId: string): Promise<void>;
  deleteAccount(): Promise<void>;
  listScans(): Promise<ScanSummary[]>;
  /** Starts a new run from a saved scan, with no reconfiguration. */
  runScan(scanId: string): Promise<{ runId: string }>;
  setScanStatus(scanId: string, status: ScanStatus): Promise<void>;
  deleteScan(scanId: string): Promise<void>;
}

const mockRole = (email: string): Role =>
  email.trim().toLowerCase().endsWith("@fhlostonswarm.com") ? "staff" : "customer";

/** No network: fixed data and a fake sign-in (any 6-digit code), for component tests and offline review. */
export const mockApi: ApiClient = {
  requestCode: async () => ({ sent: true }),
  verifyCode: async (email, code) => {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code");
    const address = email.trim().toLowerCase();
    return { user: { email: address, role: mockRole(address) }, csrfToken: "mock-csrf" };
  },
  verifyLink: async () => ({
    user: { email: "buyer@example.com", role: "customer" },
    csrfToken: "mock-csrf",
  }),
  getSession: async () => ({ authenticated: false }),
  logout: async () => undefined,
  staffWhoami: async () => ({ email: "staff@fhlostonswarm.com", role: "staff" }),
  listRuns: async () => MOCK_RUNS,
  getAccount: async () => MOCK_ACCOUNT,
  // Nothing is sent or stored in this phase; the credentials never leave the form.
  submitIntake: async () => ({ runId: DEMO_RUN_ID }),
  deleteRun: async () => undefined,
  deleteAccount: async () => undefined,
  listScans: async () => MOCK_SCANS,
  runScan: async () => ({ runId: DEMO_RUN_ID }),
  setScanStatus: async () => undefined,
  deleteScan: async () => undefined,
};

export const httpApi: ApiClient = { ...mockApi, ...createHttpAuthApi() };

/** The client the screens call. Tests swap in `mockApi` with `setApi`. */
export let api: ApiClient = httpApi;

export function setApi(next: ApiClient): void {
  api = next;
}
