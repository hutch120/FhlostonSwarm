import { createHash } from "node:crypto";
import type { AiFeature } from "@swarm/shared/server";
import type { StepContext } from "../types.js";
import { excerpt, pathOnTarget, requestAs, type Probe } from "./support.js";

/** Path segments that name a language-model feature. */
const AI_SEGMENT =
  /(?:^|[/_-])(chat|assistant|copilot|ask|ai|llm|bot|gpt|completions?|generate)(?:$|[/_.-])/i;
const AI_PAGE_TEXT = /\bassistant\b|chat ?bot|\bcopilot\b|\bAI\b|language model/i;
const PROMPT_FIELD = /^(q|query|prompt|message|msg|question|text|input|content)$/i;
const SCRIPT_ENDPOINT =
  /["'`](\/api\/(?:chat|assistant|ask|ai|llm|copilot|completions?|generate|bot|gpt)[A-Za-z0-9_\-/]*)(\?([A-Za-z0-9_]+)=)?/g;

export const MAX_FEATURES = 3;

const same = (a: AiFeature, b: AiFeature): boolean =>
  a.method === b.method && a.path === b.path && a.param === b.param;

/**
 * Places the application takes free text for a model, from the forms and links of the pages explored
 * and the endpoints named in its scripts. Only what the pages show: nothing is guessed.
 */
export async function findAiFeatures(ctx: StepContext): Promise<AiFeature[]> {
  const found: AiFeature[] = [];
  const add = (feature: AiFeature) => {
    if (!found.some((f) => same(f, feature))) found.push(feature);
  };
  const slots = ["public", ...ctx.roles().map((r) => r.slot)];
  const pages = slots.flatMap((s) => ctx.explorer?.pagesFor(s) ?? []);

  for (const page of pages) {
    const pagePath = pathOnTarget(ctx, page.url)?.split("?")[0] ?? "";
    const aiPage = AI_SEGMENT.test(pagePath) || AI_PAGE_TEXT.test(page.text.slice(0, 600));
    for (const form of page.forms) {
      const action = pathOnTarget(ctx, form.action)?.split("?")[0];
      if (!action) continue;
      const field = form.fields.find(
        (f) => /^(text|search|textarea|)$/.test(f.type) && f.name && !/pass|email/i.test(f.name),
      );
      const looksAi =
        AI_SEGMENT.test(action) || (aiPage && field && PROMPT_FIELD.test(field.name)) || false;
      if (looksAi && field) {
        add({
          path: action,
          method: form.method.toUpperCase() === "GET" ? "GET" : "POST",
          param: /^[A-Za-z0-9_.-]{1,40}$/.test(field.name) ? field.name : null,
          source: "form",
        });
      }
    }
    for (const link of page.links) {
      const path = pathOnTarget(ctx, link.href)?.split("?")[0];
      if (path && AI_SEGMENT.test(path) && !found.some((f) => f.path === path)) {
        add({ path, method: "GET", param: null, source: "link" });
      }
    }
  }

  const { external, inline } = await ctx.pageScripts();
  const code = [...inline];
  for (const url of external.slice(0, 8)) {
    const body = await ctx.scriptBody(url);
    if (body) code.push(body);
  }
  for (const text of code) {
    for (const m of text.matchAll(SCRIPT_ENDPOINT)) {
      add({ path: m[1]!, method: m[3] ? "GET" : "POST", param: m[3] ?? null, source: "script" });
    }
  }

  // Features with a known field first: those are the ones that can be tested.
  return found
    .filter((f) => /^\/(?!\/)[^\s\\]*$/.test(f.path))
    .sort((a, b) => Number(b.param !== null) - Number(a.param !== null))
    .slice(0, 10);
}

/** The features a safe request can reach: they take their text in the query string. */
export const testable = (features: readonly AiFeature[]): AiFeature[] =>
  features.filter((f) => f.method === "GET" && f.param !== null).slice(0, MAX_FEATURES);

/** An unguessable-looking but deterministic marker for this run, so a repeat test uses the same one. */
export const nonce = (ctx: StepContext, purpose: string): string =>
  createHash("sha1").update(`${ctx.input.runId}:${purpose}`).digest("hex").slice(0, 6);

export interface Answer {
  probe: Probe;
  /** The reply as text: the body with markup removed. */
  reply: string;
}

/**
 * Sends one piece of text to a feature (GET only) and returns what came back, or null if it did not
 * answer. It asks as the visitor first and as a signed-in role if the feature needs one.
 */
export async function ask(
  ctx: StepContext,
  feature: AiFeature,
  text: string,
): Promise<Answer | null> {
  const query = `${feature.path}?${feature.param}=${encodeURIComponent(text)}`;
  for (const who of [null, ...ctx.roles()]) {
    const probe = await requestAs(ctx, who, query);
    if (probe?.access === "allowed") return { probe, reply: excerpt(probe.body, 4000) };
  }
  return null;
}

/** Removes every copy of what was sent from what came back, so an echo is never mistaken for an answer. */
export function withoutEcho(reply: string, sent: string): string {
  return reply.split(sent).join(" ").split(encodeURIComponent(sent)).join(" ");
}
