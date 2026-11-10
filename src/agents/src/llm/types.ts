/** A provider-neutral shape for a tool-calling conversation (the Bedrock Converse API maps onto it). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; input: unknown }
  | { type: "toolResult"; id: string; text: string; isError: boolean };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON Schema object describing the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface LlmUsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  message: Message;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: LlmUsageTokens;
}

/** The only way an agent reaches a model. The model id comes from config, never from the agent. */
export interface LlmClient {
  readonly modelId: string;
  converse(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
