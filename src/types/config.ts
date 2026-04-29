/**
 * Configuration schema for memo-agent.
 * Loaded from ~/.memo-agent/config.yaml (or profile-specific path).
 * All string values support ${ENV_VAR} substitution.
 */

export interface ModelConfig {
  provider: "openai" | "custom";
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
  /** Maximum tokens the model may generate per response. Controls cost on metered APIs. */
  maxTokens: number;
}

export type AuxiliaryModelConfig = ModelConfig;

export interface MemoryConfig {
  /** When true the engine automatically extracts and saves facts to NOTES.md after each turn */
  autoUpdate: boolean;
  /** Maximum tokens to inject from NOTES.md into system prompt */
  maxInjectTokens: number;
}

export interface ContextConfig {
  /** Token usage ratio at which a warning is shown (0–1) */
  warnThreshold: number;
  /** Token usage ratio at which automatic compression is triggered (0–1) */
  compressThreshold: number;
  /** Number of tokens to preserve in the TAIL zone (recent context) */
  tailTokens: number;
}

export interface SandboxConfig {
  /** When true, child processes only inherit allowedEnvVars instead of the full env */
  enabled: boolean;
  /** Env var names to pass through when sandbox is enabled */
  allowedEnvVars: string[];
}

export interface PermissionsConfig {
  mode: "ask" | "auto";
  /** Tool name patterns that are always allowed without prompting */
  allow: string[];
  /** Tool name patterns that are always denied */
  deny: string[];
  /** Tool names that are completely disabled and hidden from the model */
  disabledTools: string[];
  /** Environment isolation for RunCommand */
  sandbox: SandboxConfig;
}

export interface SearchConfig {
  provider: "brave";
  apiKey: string;
  /** Maximum results returned per search (1–10) */
  maxResults: number;
}

export interface McpServerConfig {
  type: "stdio" | "http" | "sse";
  /** Used when type === "stdio" */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Used when type === "http" or "sse" */
  url?: string;
  headers?: Record<string, string>;
}

export interface MemoAgentConfig {
  model: ModelConfig;
  auxiliary?: AuxiliaryModelConfig;
  memory: MemoryConfig;
  context: ContextConfig;
  permissions: PermissionsConfig;
  mcpServers: Record<string, McpServerConfig>;
  /** Optional Brave Search integration */
  search?: SearchConfig;
}

export const DEFAULT_CONFIG: MemoAgentConfig = {
  model: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    name: "gpt-4o",
    timeoutMs: 60_000,
    maxTokens: 8_192,
  },
  memory: {
    autoUpdate: true,
    maxInjectTokens: 4_000,
  },
  context: {
    warnThreshold: 0.70,
    compressThreshold: 0.85,
    tailTokens: 20_000,
  },
  permissions: {
    mode: "ask",
    allow: ["ReadFile", "ListFiles", "SearchCode", "ReadNotes", "ListTasks", "GetTask",
            "SearchHistory", "ListSessions"],
    deny: [],
    disabledTools: [],
    sandbox: {
      enabled: false,
      allowedEnvVars: ["PATH", "HOME", "LANG", "TERM", "USER", "SHELL", "TZ"],
    },
  },
  mcpServers: {},
};
