import type {
  CostAnalysis,
  StaffAccount,
  StaffAuditRecord,
  StaffControls,
  StaffHealth,
  StaffLearning,
  StaffPriceTable,
  StaffPricing,
  StaffRunDetailResponse,
  StaffRunsResponse,
  TierId,
} from "@swarm/shared";

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface StaffRunFilters {
  from?: string;
  to?: string;
  tier?: TierId;
  trigger?: "manual" | "scheduled";
  entitlement?: "staff" | "comp" | "purchase" | "credit";
  status?: "queued" | "running" | "complete" | "stopped" | "failed";
  /** Runs of test accounts are left out unless asked for. */
  test?: "include" | "only";
}

export interface StaffCostParams {
  from?: string;
  to?: string;
  test?: "include" | "only";
  /** Cost every run under this saved price version instead of as recorded. */
  pricing?: string;
}

/** What staff may change in Controls; whatever is present replaces that part. */
export interface StaffControlsPatch {
  concurrency?: Partial<Record<TierId, number>>;
  caps?: Partial<
    Record<
      TierId,
      Partial<{
        pageCap: number | null;
        llmStepCap: number | null;
        stepCap: number;
        requestCap: number;
        requestsPerSecond: number;
        tokenCap: { input: number; output: number } | null;
        spendCapUsd: number;
      }>
    >
  >;
  dailySpendAlarmUsd?: number | null;
  scheduledScans?: { maxActivePerAccount: number; minSpacingHours: number };
  blockedHosts?: string[];
  blockedEmailDomains?: string[];
}

/** Everything the staff screens need from the backend (served only to sessions the server checks as staff). */
export interface StaffApi {
  runs(filters: StaffRunFilters): Promise<StaffRunsResponse>;
  run(runId: string): Promise<StaffRunDetailResponse>;
  stopRun(runId: string): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  resendRunEmail(runId: string): Promise<void>;

  costs(params: StaffCostParams): Promise<CostAnalysis>;
  /** The costs again, under a price table that has not been saved. */
  previewCosts(
    table: StaffPriceTable,
    params: Pick<StaffCostParams, "from" | "to" | "test">,
  ): Promise<CostAnalysis>;
  pricing(): Promise<StaffPricing>;
  savePricing(table: StaffPriceTable, note: string): Promise<StaffPricing>;

  account(email: string): Promise<StaffAccount>;
  grantCredit(
    accountHash: string,
    grant: { tier: TierId; count: number; reason: string },
  ): Promise<void>;
  setScanStatus(accountHash: string, scanId: string, status: "active" | "paused"): Promise<void>;
  deleteAccount(accountHash: string, reason: string): Promise<void>;

  controls(): Promise<StaffControls>;
  saveControls(patch: StaffControlsPatch): Promise<StaffControls>;
  setKillSwitch(on: boolean, reason: string): Promise<{ controls: StaffControls; stopped: number }>;
  audit(): Promise<StaffAuditRecord[]>;

  health(): Promise<StaffHealth>;

  learning(): Promise<StaffLearning>;
  rollbackLearning(version: number): Promise<StaffLearning>;
  setLearningEnabled(enabled: boolean): Promise<StaffLearning>;
  setLearningEntry(
    entry: { kind: "item" | "agent"; id: string } & { pinned?: boolean; disabled?: boolean },
  ): Promise<StaffLearning>;
}

const query = (params: object): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length === 0
    ? ""
    : `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
};

export function createStaffApi(call: Call): StaffApi {
  const id = encodeURIComponent;
  return {
    runs: (filters) => call("GET", `/api/staff/runs${query(filters)}`),
    run: (runId) => call("GET", `/api/staff/runs/${id(runId)}`),
    stopRun: async (runId) => {
      await call("POST", `/api/staff/runs/${id(runId)}/stop`);
    },
    deleteRun: async (runId) => {
      await call("DELETE", `/api/staff/runs/${id(runId)}`);
    },
    resendRunEmail: async (runId) => {
      await call("POST", `/api/staff/runs/${id(runId)}/resend-email`);
    },

    costs: (params) => call("GET", `/api/staff/costs${query(params)}`),
    previewCosts: (table, params) => call("POST", "/api/staff/costs/preview", { table, ...params }),
    pricing: () => call("GET", "/api/staff/pricing"),
    savePricing: (table, note) => call("POST", "/api/staff/pricing", { table, note }),

    account: (email) => call("GET", `/api/staff/accounts${query({ email })}`),
    grantCredit: async (hash, grant) => {
      await call("POST", `/api/staff/accounts/${id(hash)}/credits`, grant);
    },
    setScanStatus: async (hash, scanId, status) => {
      await call("PATCH", `/api/staff/accounts/${id(hash)}/scans/${id(scanId)}/status`, { status });
    },
    deleteAccount: async (hash, reason) => {
      await call("DELETE", `/api/staff/accounts/${id(hash)}`, { reason });
    },

    controls: () => call("GET", "/api/staff/controls"),
    saveControls: (patch) => call("PUT", "/api/staff/controls", patch),
    setKillSwitch: (on, reason) => call("POST", "/api/staff/controls/kill-switch", { on, reason }),
    audit: () => call("GET", "/api/staff/audit"),

    health: () => call("GET", "/api/staff/health"),

    learning: () => call("GET", "/api/staff/learning"),
    rollbackLearning: (version) => call("POST", "/api/staff/learning/pointer", { version }),
    setLearningEnabled: (enabled) => call("POST", "/api/staff/learning/pointer", { enabled }),
    setLearningEntry: (entry) => call("POST", "/api/staff/learning/entry", entry),
  };
}
