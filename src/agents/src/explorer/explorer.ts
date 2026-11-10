import { appProfileSchema, type AppProfile } from "@swarm/shared";
import type { AgentInput } from "@swarm/shared/server";
import { runtimeConfig } from "@swarm/shared/server";
import { z } from "zod";
import type { Budget } from "../budget.js";
import { LlmBudgetExhausted, type LlmMeter } from "../llm/meter.js";
import { SAFETY_RULES, runLoop, untrusted, type Tool, type ToolOutput } from "../llm/loop.js";
import type { LlmClient } from "../llm/types.js";
import { normaliseHost } from "../policy.js";
import type {
  BlockedRequest,
  BrowserCookie,
  DriverFactory,
  PageDriver,
  PageSnapshot,
} from "./driver.js";

export type PhaseEnd = "done" | "limit" | "unavailable" | "stopped";

export interface PhaseResult {
  end: PhaseEnd;
  /** Customer-safe wording for the gap, when the phase did not finish. */
  reason?: string;
  pages: number;
}

export interface SignInRecord {
  slot: string;
  description: string;
  ok: boolean;
  /** True when the credentials went over plain HTTP. */
  insecureTransport: boolean;
  landedPath: string;
  message: string;
  cookies: BrowserCookie[];
}

export interface ExplorerDeps {
  input: AgentInput;
  llm: LlmClient;
  meter: LlmMeter;
  driverFactory: DriverFactory;
  proxy: { host: string; port: number; loginKey?: string };
  budget: Budget;
  aborted?: () => boolean;
}

const MODEL_TEXT = 1800;
const MODEL_LINKS = 30;
/** Calls kept back for writing the profile, so a long exploration can never end without one. */
const PROFILE_RESERVE = 3;
/** Paths that came back as not found; after this many, `open_path` is refused (no guessing). */
const MAX_MISSES = 2;
const VISITOR = /visitor|anonymous|guest|public|signed.?out|unauthenticated/i;

const profileInput = appProfileSchema.omit({ coverage: true });

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

const ROLE = `You are the explorer. Your job is to understand what the application is, so the report can describe it: its purpose, its main areas or features, the roles it has and what each role can reach, and its main user flows.
Rules for what you record:
- Describe only what you saw on pages you opened. Never guess or invent pages, features, roles or technologies.
- Only follow links that are listed on a page. Use open_path only for a path that appeared on a page you opened (a page that answers "not found" does not exist, and guessing paths is not allowed).
- A role is a kind of user you actually saw or signed in as (or the signed-out visitor). Do not describe roles you did not see.
- Open the pages that matter: usually 6 to 12 in all. Skip repeated or near-identical pages. Stop as soon as you understand the application.`;

/**
 * The explorer (discovery): a model-driven browser session that crawls the application and writes the
 * app profile. The model only picks among link ids and paths of the application under test; the host,
 * every request and the sign-in itself are decided by code, and the password never reaches the model.
 * Public pages are explored first (the surface agent's crawl), then each login (the authn agent's
 * sign-in), always GET-only apart from the sign-in submission.
 */
export class Explorer {
  private readonly seen = new Map<string, PageSnapshot>();
  private readonly notes: string[] = [];
  private readonly logins: SignInRecord[] = [];
  private blockedLog: BlockedRequest[] = [];
  private pageCount = 0;
  private requestsCounted = 0;
  private current: PageSnapshot | null = null;
  private profileRecord: AppProfile | null = null;
  private publicPhase: Promise<PhaseResult> | undefined;
  private signedInPhase: Promise<PhaseResult> | undefined;
  private limitReason: string | undefined;
  private phaseFinished = false;
  private misses = 0;
  private repeats = 0;
  private finishHint = "";
  /** Paths that answered while signed out; a page first reached after signing in needs a login. */
  private publicPaths = new Set<string>();
  private readonly counted = new WeakMap<PageDriver, number>();
  private readonly openedBy = new WeakMap<PageDriver, Set<string>>();

  constructor(private readonly deps: ExplorerDeps) {}

  get profile(): AppProfile | null {
    return this.profileRecord;
  }
  get pages(): PageSnapshot[] {
    // Pages that answered; a path that came back as an error is not part of the application.
    return [...new Map([...this.seen.values()].map((p) => [p.url, p])).values()].filter(
      (p) => p.status < 400,
    );
  }
  get signIns(): readonly SignInRecord[] {
    return this.logins;
  }
  get blocked(): readonly BlockedRequest[] {
    return this.blockedLog;
  }
  /** Requests the browser made (also counted against the run's request budget). */
  get requests(): number {
    return this.requestsCounted;
  }

  private get loginSlots(): string[] {
    return this.deps.input.agents.includes("authn") ? Object.keys(this.deps.input.logins) : [];
  }

  private inScope(url: string): boolean {
    try {
      const host = normaliseHost(new URL(url).hostname);
      return this.deps.input.scope.hosts.some((h) => normaliseHost(h) === host);
    } catch {
      return false;
    }
  }

  crawlPublic(): Promise<PhaseResult> {
    return (this.publicPhase ??= this.phase("public"));
  }

  /** Signs in with each declared login and explores what it can reach. */
  async exploreSignedIn(): Promise<PhaseResult> {
    await this.crawlPublic();
    return (this.signedInPhase ??= this.phase("signed-in"));
  }

  /** Writes the profile from what was gathered, when no phase got to (a limit or a failure). */
  async ensureProfile(): Promise<void> {
    if (this.profileRecord || this.notes.length === 0) return;
    if (this.deps.aborted?.()) return;
    const tools = [this.recordProfileTool()];
    try {
      await runLoop({
        llm: this.deps.llm,
        meter: this.deps.meter,
        system: SAFETY_RULES,
        task: `${ROLE}\n\nExploring has ended. Write the profile now, from these notes of what was seen, using record_profile only.\n\n${untrusted("exploration notes", this.notes.join("\n\n"), 6000)}`,
        tools,
        maxTurns: 2,
        maxTokensPerCall: runtimeConfig.llm.maxOutputTokensPerCall,
        isDone: () => this.profileRecord !== null,
      });
    } catch (err) {
      if (!(err instanceof LlmBudgetExhausted)) this.logFailure("profile", err);
    }
  }

  private logFailure(where: string, err: unknown): void {
    // The first lines only: enough to diagnose a browser or model failure, and nothing from the target.
    const message = (err as Error).message?.split("\n").slice(0, 6).join(" | ").slice(0, 600);
    console.error(
      JSON.stringify({ msg: "explorer_failed", where, name: (err as Error).name, message }),
    );
  }

  private async phase(kind: "public" | "signed-in"): Promise<PhaseResult> {
    const { input, llm, meter, budget } = this.deps;
    const slots = this.loginSlots;
    if (kind === "signed-in" && slots.length === 0) return { end: "done", pages: 0 };

    let driver: PageDriver | undefined;
    const pagesBefore = this.pageCount;
    try {
      driver = await this.deps.driverFactory({
        proxy: this.deps.proxy,
        hosts: input.scope.hosts,
        loginSubmissions: kind === "public" ? 0 : input.scope.loginSubmissions,
        userAgent: input.userAgent,
      });
    } catch (err) {
      this.logFailure("browser", err);
      return {
        end: "unavailable",
        reason: "The explorer could not start its browser, so pages were not explored.",
        pages: 0,
      };
    }

    const finalPhase = kind === "signed-in" || slots.length === 0;
    const cap = meter.limits.maxCalls ?? 60;
    const remaining = Math.max(1, cap - meter.calls);
    // A phase never spends the calls kept back for writing the profile, and never more than the
    // depth's per-phase ceiling (a model that wanders must not use the whole run's calls).
    const ceiling = input.budgets.llm.phaseCalls ?? Number.POSITIVE_INFINITY;
    const maxTurns = Math.min(
      ceiling,
      kind === "public" && slots.length > 0
        ? Math.max(8, Math.floor(cap * 0.3))
        : Math.max(4, remaining - PROFILE_RESERVE),
    );

    const tools: Tool[] = [
      this.openLinkTool(driver),
      this.openPathTool(driver),
      ...(kind === "signed-in" ? [this.signInTool(driver, slots)] : []),
      finalPhase ? this.recordProfileTool() : this.finishPhaseTool(),
    ];
    const phaseDone = () => (finalPhase ? this.profileRecord !== null : this.phaseFinished);
    const logins = slots
      .map((slot) => `- ${slot}: ${input.logins[slot as keyof typeof input.logins]?.description}`)
      .join("\n");
    const base =
      kind === "public"
        ? `${ROLE}\n\nApplication: ${input.target.appUrl}\nExplore the public (signed-out) pages first, starting with the home page.${finalPhase ? " Then call record_profile." : " When you have seen the public side, call finish_exploring with a short summary of it."}${this.scopeNotes()}`
        : `${ROLE}\n\nApplication: ${input.target.appUrl}\nThe public side is already explored:\n${untrusted("public summary", this.notes.join("\n"), 2000)}\nNow sign in with each login below (open the page that has the sign-in form, then call sign_in) and explore what that login can reach, noting how it differs from the public side and between roles. Then call record_profile.\nLogins you may use:\n${logins}${this.scopeNotes()}`;

    const task = `${base}\nYou have at most ${maxTurns} tool calls in this phase, and a good run uses about ${Math.min(maxTurns, 14)}.`;
    this.limitReason = undefined;
    this.phaseFinished = false;
    this.misses = 0;
    this.repeats = 0;
    this.finishHint = finalPhase
      ? "If you have seen enough, call record_profile now."
      : "If you have seen enough, call finish_exploring now.";
    let end: PhaseEnd = "done";
    let reason: string | undefined;
    try {
      const loop = await runLoop({
        llm,
        meter,
        system: SAFETY_RULES,
        task,
        tools,
        maxTurns,
        maxTokensPerCall: runtimeConfig.llm.maxOutputTokensPerCall,
        lowTurnsNote: finalPhase ? "Call record_profile now." : "Call finish_exploring now.",
        isDone: phaseDone,
        shouldStop: () => this.deps.aborted?.() === true || budget.exhaustedKind() !== null,
      });
      if (loop.end === "stopped") {
        end = "stopped";
        reason = this.deps.aborted?.()
          ? undefined
          : "The time or request limit for this scan depth was reached while exploring.";
      } else if (loop.end !== "done") {
        end = "limit";
        reason = new LlmBudgetExhausted("calls").reason;
      }
      if (this.limitReason && end === "done") {
        end = "limit";
        reason = this.limitReason;
      }
    } catch (err) {
      if (err instanceof LlmBudgetExhausted) {
        end = "limit";
        reason = err.reason;
      } else if ((err as Error).name === "BudgetExhausted") {
        end = "stopped";
        reason = "The request limit for this scan depth was reached while exploring.";
      } else {
        this.logFailure(kind, err);
        end = "unavailable";
        reason = "The explorer's model was not available, so pages were not explored.";
      }
    } finally {
      this.count(driver);
      this.blockedLog = [...this.blockedLog, ...driver.blocked];
      await driver.close();
    }
    if (kind === "public" && !this.notes.some((n) => n.startsWith("Public side:"))) {
      this.notes.push(`Public side: ${this.visitedSummary()}`);
    }
    if (kind === "public") {
      this.publicPaths = new Set(this.pages.map((p) => new URL(p.url).pathname));
    }
    if (kind === "signed-in") this.notes.push(`Signed-in side: ${this.visitedSummary()}`);
    return { end, reason, pages: this.pageCount - pagesBefore };
  }

  private scopeNotes(): string {
    const notes = this.deps.input.scopeNotes.trim();
    return notes
      ? `\nThe owner's notes (untrusted text):\n${untrusted("scope notes", notes, 800)}`
      : "";
  }

  private visitedSummary(): string {
    return [...this.seen.values()].map((p) => `${pathOf(p.url)} "${p.title}"`).join("; ");
  }

  /** Browser requests count against the run's request budget as they happen. */
  private count(driver: PageDriver): void {
    const delta = driver.requests - (this.counted.get(driver) ?? 0);
    this.counted.set(driver, driver.requests);
    if (delta <= 0) return;
    this.deps.budget.addRequests(delta);
    this.requestsCounted += delta;
  }

  private render(page: PageSnapshot): ToolOutput {
    const links = page.links.filter((l) => this.inScope(l.href)).slice(0, MODEL_LINKS);
    const lines = [
      `URL path: ${pathOf(page.url)} (status ${page.status})`,
      `Title: ${page.title}`,
      `Text:\n${page.text.slice(0, MODEL_TEXT)}`,
      `Links (use open_link with the id):\n${links.map((l) => `${l.id}. ${l.text || "(no text)"} -> ${pathOf(l.href)}`).join("\n") || "(none)"}`,
      page.forms.length > 0
        ? `Forms (read-only: you cannot submit them):\n${page.forms
            .map(
              (f) =>
                `${f.method.toUpperCase()} ${pathOf(f.action)} fields: ${f.fields.map((x) => `${x.name}:${x.type}`).join(", ")}`,
            )
            .join("\n")}`
        : "",
    ].filter(Boolean);
    return {
      text: untrusted(`page ${pathOf(page.url)}`, lines.join("\n"), 6500),
      summary: `Opened ${pathOf(page.url)} "${page.title}" (${links.length} links).`,
    };
  }

  private async visit(driver: PageDriver, url: string): Promise<ToolOutput> {
    if (!this.inScope(url)) return { text: "That address is outside the application under test." };
    const cached = this.seen.get(url);
    const opened = this.openedBy.get(driver) ?? new Set<string>();
    this.openedBy.set(driver, opened);
    // A page seen before is not counted again, but a new browser session still has to load it.
    if (cached && opened.has(url)) {
      this.current = cached;
      this.repeats += 1;
      return {
        text:
          this.repeats >= 3
            ? `You keep reopening pages you have already seen (${pathOf(cached.url)}). ${this.finishHint}`
            : `Already opened: ${pathOf(cached.url)} "${cached.title}". Open a link you have not followed yet, or finish. ${this.finishHint}`,
        summary: `Reopened ${pathOf(cached.url)}.`,
      };
    }
    const maxPages = this.deps.input.budgets.maxPages;
    if (!cached && maxPages !== null && this.pageCount >= maxPages) {
      this.limitReason = "The page limit for this scan depth was reached while exploring.";
      return {
        text: "The page limit was reached. Do not open more pages; finish the task now.",
      };
    }
    if (!cached) this.pageCount += 1;
    const page = await driver.open(url);
    this.count(driver);
    opened.add(url);
    opened.add(page.url);
    this.seen.set(url, page);
    this.seen.set(page.url, page);
    this.current = page;
    return this.render(page);
  }

  private openLinkTool(driver: PageDriver): Tool<{ id: number }> {
    return {
      name: "open_link",
      description:
        "Open one of the links listed on the page you are looking at, by its id. Read-only navigation.",
      input: z.object({ id: z.number().int().positive() }),
      run: async ({ id }) => {
        const link = this.current?.links.find((l) => l.id === id);
        if (!link) return { text: "There is no link with that id on the current page." };
        return this.visit(driver, link.href);
      },
    };
  }

  private openPathTool(driver: PageDriver): Tool<{ path: string }> {
    return {
      name: "open_path",
      description:
        "Open a path on the application under test (for example /about). Use it for pages the links do not show. The host is fixed; you cannot choose one.",
      input: z.object({ path: z.string().min(1).max(300).startsWith("/") }),
      run: async ({ path }) => {
        if (path.startsWith("//")) return { text: "A path must start with a single slash." };
        const url = new URL(path, new URL(this.deps.input.target.appUrl)).toString();
        // Guessing is what is refused: a page that was already seen can always be reopened.
        if (this.misses >= MAX_MISSES && !this.seen.has(url)) {
          return {
            text: "Guessing paths is not allowed: too many of them did not exist. Follow the listed links, or finish.",
          };
        }
        const shown = await this.visit(driver, url);
        if ((this.current?.status ?? 0) >= 400) this.misses += 1;
        return shown;
      },
    };
  }

  private signInTool(driver: PageDriver, slots: string[]): Tool<{ login: string }> {
    const { input } = this.deps;
    return {
      name: "sign_in",
      description:
        "Sign in with one of the provided logins on the page you are looking at (it must show the sign-in form). The credentials are filled in for you; you never see them.",
      input: z.object({ login: z.enum(slots as [string, ...string[]]) }),
      run: async ({ login }) => {
        const credentials = input.logins[login as keyof typeof input.logins];
        if (!credentials) return { text: "That login is not available." };
        if (this.logins.some((l) => l.slot === login && l.ok)) {
          return { text: "Already signed in with that login." };
        }
        const result = await driver.signIn({
          username: credentials.username,
          password: credentials.password,
        });
        this.count(driver);
        const cookies = result.ok ? await driver.cookies() : [];
        this.logins.push({
          slot: login,
          description: credentials.description,
          ok: result.ok,
          insecureTransport: result.insecureTransport,
          landedPath: pathOf(result.landedUrl),
          message: result.message,
          cookies,
        });
        if (result.snapshot) {
          this.seen.set(result.snapshot.url, result.snapshot);
          // Everything seen so far was seen signed out; a page opened again must load signed in.
          this.openedBy.set(driver, new Set(result.ok ? [result.snapshot.url] : []));
          this.current = result.snapshot;
          this.pageCount += 1;
          const shown = this.render(result.snapshot);
          const lead = result.ok
            ? `Signed in as "${credentials.description}". This is the page you landed on. Explore what is reachable now by following the links below; the sign-in page is behind you.`
            : result.message;
          return { text: `${lead}\n${shown.text}`, summary: shown.summary };
        }
        return { text: result.message };
      },
    };
  }

  private finishPhaseTool(): Tool<{ summary: string }> {
    return {
      name: "finish_exploring",
      description:
        "Call when you have seen enough of this side of the application. Give a short factual summary of what you saw.",
      input: z.object({ summary: z.string().min(1).max(1500) }),
      run: async ({ summary }) => {
        this.notes.push(`Public side: ${summary}`);
        this.phaseFinished = true;
        return "Recorded.";
      },
    };
  }

  private recordProfileTool(): Tool<z.infer<typeof profileInput>> {
    return {
      name: "record_profile",
      description:
        "Record your understanding of the application: its purpose, areas, roles (and what each can reach), main flows and technologies. Describe only what you saw. Call this once, last.",
      input: profileInput,
      run: async (value) => {
        const signedIn = this.logins.some((l) => l.ok);
        const visited = new Map(this.pages.map((p) => [new URL(p.url).pathname, p]));

        // The model writes the prose; the facts are checked against what the browser saw. An area
        // that names a page nobody opened is dropped, and "needs a login" is whether the page was
        // first reached after signing in, not what the model believes.
        const areas = value.areas.flatMap((area) => {
          if (!area.path) return [{ ...area, requiresLogin: signedIn && area.requiresLogin }];
          const pathname = area.path.split("?")[0]!;
          if (!visited.has(pathname)) return [];
          return [{ ...area, requiresLogin: signedIn && !this.publicPaths.has(pathname) }];
        });
        // Only the signed-out visitor and the logins that actually worked are roles that were seen.
        const seenRoles = this.logins.filter((l) => l.ok).length + 1;
        const roles = signedIn
          ? value.roles.slice(0, seenRoles)
          : value.roles.filter((r) => VISITOR.test(r.name)).slice(0, 1);

        this.profileRecord = appProfileSchema.parse({
          ...value,
          areas,
          roles,
          coverage: {
            pagesVisited: visited.size,
            loginsUsed: this.logins.filter((l) => l.ok).length,
            signedIn,
          },
        });
        return "Recorded.";
      },
    };
  }
}
