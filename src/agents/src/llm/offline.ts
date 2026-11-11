import type { AppProfile } from "@swarm/shared";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse } from "./types.js";

const toolUse = (n: number, name: string, input: unknown): ContentBlock => ({
  type: "toolUse",
  id: `offline-${n}`,
  name,
  input,
});

/**
 * A scripted stand-in for the model: it follows links in order, signs in when a login is offered,
 * and writes a profile from the page titles. It makes no network call and costs nothing, so the
 * local dev server and the tests can run the whole pipeline (explorer, report, cost) without Bedrock.
 * Never used in a task.
 */
export function createOfflineLlm(
  options: { maxPages?: number; modelId?: string } = {},
): LlmClient & {
  readonly requests: LlmRequest[];
} {
  const maxPages = options.maxPages ?? 8;
  const visited: { path: string; title: string; afterSignIn: boolean }[] = [];
  const requests: LlmRequest[] = [];
  let signedIn = false;
  const signedSlots = new Set<string>();
  let counter = 0;
  let phaseStart = 0;

  const lastResult = (request: LlmRequest): string => {
    const last = request.messages.at(-1);
    return last?.content.map((b) => (b.type === "toolResult" ? b.text : "")).join("\n") ?? "";
  };

  const profile = (): Omit<AppProfile, "coverage"> => ({
    purpose: `A web application titled "${visited[0]?.title ?? "unknown"}", described from ${visited.length} pages.`,
    areas: visited.map((p) => ({
      name: p.title.replace(/ - .*$/, "") || p.path,
      description: `The page at ${p.path}.`,
      path: p.path,
      requiresLogin: p.afterSignIn,
    })),
    roles: [],
    flows: [],
    technologies: [],
  });

  const decide = (request: LlmRequest): ContentBlock[] => {
    const names = request.tools.map((t) => t.name);
    counter += 1;
    const first = request.messages.length === 1;
    if (first) {
      phaseStart = visited.length;
      return [toolUse(counter, "open_path", { path: "/" })];
    }

    const text = lastResult(request);
    if (/Signed in as /.test(text)) signedIn = true;
    const path = /URL path: (\S+)/.exec(text)?.[1];
    const title = /Title: (.*)/.exec(text)?.[1] ?? "";
    if (path && !visited.some((v) => v.path === path)) {
      visited.push({ path, title, afterSignIn: signedIn });
    }

    const prompt =
      request.messages[0]?.content[0]?.type === "text" ? request.messages[0].content[0].text : "";
    const slots = [...prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1]!);
    const nextSlot = slots.find((s) => !signedSlots.has(s));
    const signingIn = names.includes("sign_in") && nextSlot !== undefined;
    if (signingIn && !signedIn && /type=password|password:password/.test(text)) {
      signedSlots.add(nextSlot);
      return [toolUse(counter, "sign_in", { login: nextSlot })];
    }

    const links = [...text.matchAll(/^(\d+)\. .* -> (\S+)$/gm)].map((m) => ({
      id: Number(m[1]),
      path: m[2]!,
    }));
    const next = links.find(
      (l) => !visited.some((v) => v.path === l.path) && !/^\/(archive|logout)/.test(l.path),
    );
    if (next && visited.length - phaseStart < maxPages) {
      return [toolUse(counter, "open_link", { id: next.id })];
    }

    // Another login is still to be used: the sign-in tool starts from a signed-out browser itself.
    if (signingIn && signedIn) {
      signedSlots.add(nextSlot);
      return [toolUse(counter, "sign_in", { login: nextSlot })];
    }

    if (names.includes("record_profile")) return [toolUse(counter, "record_profile", profile())];
    return [toolUse(counter, "finish_exploring", { summary: `Saw ${visited.length} pages.` })];
  };

  return {
    modelId: options.modelId ?? "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    requests,
    async converse(request): Promise<LlmResponse> {
      requests.push(request);
      const content = decide(request);
      return {
        message: { role: "assistant", content },
        stopReason: "tool_use",
        usage: { inputTokens: 1500, outputTokens: 60 },
      };
    },
  };
}
