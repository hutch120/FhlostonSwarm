import { DEMO_RUN_ID } from "@swarm/shared";
import type { Role } from "../state/session.js";
import { createHttpApi, type ApiClient } from "./http.js";
import { MOCK_ACCOUNT, MOCK_RUNS, MOCK_SCANS, MOCK_TARGETS, type AccountInfo } from "./mock.js";

export type { AccountInfo } from "./mock.js";
export { ApiError, fieldForError, messageFor } from "./http.js";
export type { ApiClient } from "./http.js";

const mockRole = (email: string): Role =>
  email.trim().toLowerCase().endsWith("@fhlostonswarm.com") ? "staff" : "customer";

/**
 * No network: fixed starting data and a fake sign-in (any 6-digit code), for component tests and
 * offline review. Deletes and status changes stick, so screens that refetch show them. Each call
 * returns a fresh copy.
 */
export function createMockApi(): ApiClient {
  let runs = [...MOCK_RUNS];
  let scans = [...MOCK_SCANS];
  let targets = [...MOCK_TARGETS];
  const account: AccountInfo = { ...MOCK_ACCOUNT, credits: { ...MOCK_ACCOUNT.credits } };

  return {
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
    getAccount: async () => account,

    listRuns: async () => runs,
    getRun: async (runId) => {
      const run = runs.find((r) => r.summary.runId === runId);
      if (!run) throw new Error("not found");
      return run;
    },
    deleteRun: async (runId) => {
      runs = runs.filter((r) => r.summary.runId !== runId);
    },

    listTargets: async () => targets,
    deleteTarget: async (targetId) => {
      const target = targets.find((t) => t.id === targetId);
      const deletedScans = (target?.scans ?? []).map((s) => s.id);
      targets = targets.filter((t) => t.id !== targetId);
      scans = scans.filter((s) => !deletedScans.includes(s.id));
      return { deletedScans };
    },

    listScans: async () => scans,
    // Nothing is stored for a new scan; the credentials never leave the form.
    saveScan: async (_values, { scanId, start }) => ({
      scanId: scanId ?? "scan_mock0001",
      ...(start ? { runId: DEMO_RUN_ID } : {}),
    }),
    runScan: async () => ({ runId: DEMO_RUN_ID }),
    setScanStatus: async (scanId, status) => {
      scans = scans.map((s) => (s.id === scanId ? { ...s, status } : s));
    },
    deleteScan: async (scanId) => {
      scans = scans.filter((s) => s.id !== scanId);
    },
    resendNotifyConfirmation: async () => undefined,
    confirmNotify: async () => undefined,

    requestAccountDeletion: async () => undefined,
    deleteAccount: async () => undefined,
  };
}

export const httpApi: ApiClient = createHttpApi();

/** The client the screens call. Tests swap in `createMockApi()` with `setApi`. */
export let api: ApiClient = httpApi;

export function setApi(next: ApiClient): void {
  api = next;
}
