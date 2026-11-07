import { DEMO_RUN_ID } from "@swarm/shared";
import type { IntakeValues } from "../intake.js";
import { MOCK_ACCOUNT, MOCK_RUNS, type AccountInfo, type RunListItem } from "./mock.js";

export type { AccountInfo, RunListItem } from "./mock.js";

/** The API surface the screens use. Every method is a stub until the backend exists. */
export interface ApiClient {
  requestCode(email: string): Promise<{ sent: true }>;
  verifyCode(email: string, code: string): Promise<{ email: string }>;
  listRuns(): Promise<RunListItem[]>;
  getAccount(): Promise<AccountInfo>;
  submitIntake(values: IntakeValues): Promise<{ runId: string }>;
  deleteRun(runId: string): Promise<void>;
  deleteAccount(): Promise<void>;
}

/** No network: returns fixed data so every screen can be built and reviewed offline. */
export const mockApi: ApiClient = {
  requestCode: async () => ({ sent: true }),
  verifyCode: async (email, code) => {
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code");
    return { email };
  },
  listRuns: async () => MOCK_RUNS,
  getAccount: async () => MOCK_ACCOUNT,
  // Nothing is sent or stored in this phase; the credentials never leave the form.
  submitIntake: async () => ({ runId: DEMO_RUN_ID }),
  deleteRun: async () => undefined,
  deleteAccount: async () => undefined,
};

export const api: ApiClient = mockApi;
