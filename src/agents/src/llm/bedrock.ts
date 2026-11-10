import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock as BedrockBlock,
  type Message as BedrockMessage,
} from "@aws-sdk/client-bedrock-runtime";
import { runtimeConfig } from "@swarm/shared/server";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse, Message } from "./types.js";

/** Errors worth another attempt: throttling and transient service trouble. */
const RETRYABLE = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "ModelTimeoutException",
  "ModelNotReadyException",
  "InternalServerException",
]);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const toBedrock = (message: Message): BedrockMessage => ({
  role: message.role,
  content: message.content.map((block): BedrockBlock => {
    switch (block.type) {
      case "text":
        return { text: block.text };
      case "toolUse":
        return {
          toolUse: { toolUseId: block.id, name: block.name, input: block.input as never },
        };
      case "toolResult":
        return {
          toolResult: {
            toolUseId: block.id,
            content: [{ text: block.text }],
            status: block.isError ? "error" : "success",
          },
        };
    }
  }),
});

const fromBedrock = (blocks: BedrockBlock[] | undefined): ContentBlock[] =>
  (blocks ?? []).flatMap((block): ContentBlock[] => {
    if (block.text !== undefined) return [{ type: "text", text: block.text }];
    if (block.toolUse?.toolUseId && block.toolUse.name) {
      return [
        {
          type: "toolUse",
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: block.toolUse.input,
        },
      ];
    }
    return [];
  });

export interface BedrockOptions {
  modelId: string;
  region?: string;
  client?: Pick<BedrockRuntimeClient, "send">;
  /** Replaces the retry pause (tests). */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
}

/**
 * The Converse API with an `au.` inference profile. Throttling and transient errors are retried
 * with exponential backoff and jitter; every other error, and the last retry, is thrown. The SDK's
 * own retries are off so the number of attempts is exactly what the config says.
 */
export class BedrockLlm implements LlmClient {
  readonly modelId: string;
  private readonly client: Pick<BedrockRuntimeClient, "send">;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  /** Retries that were needed, for the run log. */
  retries = 0;

  constructor(options: BedrockOptions) {
    this.modelId = options.modelId;
    this.client =
      options.client ?? new BedrockRuntimeClient({ region: options.region, maxAttempts: 1 });
    this.sleep = options.sleep ?? wait;
    this.maxRetries = options.maxRetries ?? runtimeConfig.llm.maxRetries;
    this.retryBaseMs = options.retryBaseMs ?? runtimeConfig.llm.retryBaseMs;
  }

  async converse(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: request.system }],
      messages: request.messages.map(toBedrock),
      inferenceConfig: { maxTokens: request.maxTokens, temperature: 0 },
      ...(request.tools.length > 0
        ? {
            toolConfig: {
              tools: request.tools.map((tool) => ({
                toolSpec: {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: { json: tool.inputSchema as never },
                },
              })),
            },
          }
        : {}),
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.client.send(command, { abortSignal: signal });
        const stop = response.stopReason;
        return {
          message: { role: "assistant", content: fromBedrock(response.output?.message?.content) },
          stopReason:
            stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" ? stop : "other",
          usage: {
            inputTokens: response.usage?.inputTokens ?? 0,
            outputTokens: response.usage?.outputTokens ?? 0,
          },
        };
      } catch (err) {
        const name = (err as Error).name;
        if (!RETRYABLE.has(name) || attempt >= this.maxRetries || signal?.aborted) throw err;
        this.retries += 1;
        const delay = this.retryBaseMs * 2 ** attempt * (0.5 + Math.random() / 2);
        await this.sleep(Math.min(delay, 30_000));
      }
    }
  }
}
