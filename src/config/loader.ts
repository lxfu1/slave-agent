/**
 * Configuration loader.
 * Resolves the profile directory, reads config.yaml, substitutes ${ENV_VAR}
 * placeholders, and merges with defaults.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { DEFAULT_CONFIG, type SlaveAgentConfig } from "../types/config.js";
import { makeError, type SlaveAgentError } from "../types/errors.js";

const AGENT_HOME_DIR = ".memo-agent";
const CONFIG_FILE = "config.yaml";

/** Returns the root directory for the given profile (or the default profile) */
export function resolveProfileDir(profileName?: string): string {
  const home = os.homedir();
  const base = path.join(home, AGENT_HOME_DIR);
  if (!profileName || profileName === "default") {
    return base;
  }
  return path.join(base, "profiles", profileName);
}

/** Ensures all required subdirectories exist under a profile directory */
export async function ensureProfileDirs(profileDir: string): Promise<void> {
  await fs.mkdir(path.join(profileDir, "memory"), { recursive: true });
  await fs.mkdir(path.join(profileDir, "recipes"), { recursive: true });
}

/**
 * Loads and parses config.yaml from the given profile directory.
 * Falls back to DEFAULT_CONFIG when the file is absent.
 * Throws SlaveAgentError on parse errors or missing required fields.
 */
export async function loadConfig(profileDir: string): Promise<SlaveAgentConfig> {
  const configPath = path.join(profileDir, CONFIG_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    // No config file — start from defaults and rely on env vars.
    // Still validate so missing required env vars surface a clear error.
    const envConfig = buildConfigFromEnv(DEFAULT_CONFIG);
    validateConfig(envConfig, "environment variables");
    return envConfig;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw makeError("CONFIG_PARSE_ERROR", `Failed to parse ${configPath}: ${String(err)}`, err);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw makeError("CONFIG_PARSE_ERROR", `Config file is not a YAML object: ${configPath}`);
  }

  // YAML conventionally uses snake_case; the TypeScript config uses camelCase.
  // Convert all object keys recursively so both styles work in config.yaml.
  const normalized = convertKeysToCamelCase(parsed) as Partial<SlaveAgentConfig>;
  const merged = deepMerge(DEFAULT_CONFIG, normalized);
  const substituted = substituteEnvVars(merged) as SlaveAgentConfig;

  validateConfig(substituted, configPath);
  return substituted;
}

/** Builds a config purely from environment variables (no YAML file) */
function buildConfigFromEnv(base: SlaveAgentConfig): SlaveAgentConfig {
  const config = structuredClone(base);

  if (process.env["MODEL_BASE_URL"]) config.model.baseUrl = process.env["MODEL_BASE_URL"];
  if (process.env["MODEL_API_KEY"]) config.model.apiKey = process.env["MODEL_API_KEY"];
  if (process.env["MODEL_NAME"]) config.model.name = process.env["MODEL_NAME"];
  if (process.env["MODEL_MAX_TOKENS"]) {
    const parsed = parseInt(process.env["MODEL_MAX_TOKENS"], 10);
    if (!isNaN(parsed) && parsed > 0) config.model.maxTokens = parsed;
  }

  if (process.env["AUX_BASE_URL"] && process.env["AUX_API_KEY"] && process.env["AUX_MODEL_NAME"]) {
    const rawProvider = process.env["AUX_PROVIDER"] ?? "openai";
    const provider: "openai" | "custom" =
      rawProvider === "custom" ? "custom" : "openai";
    config.auxiliary = {
      provider,
      baseUrl: process.env["AUX_BASE_URL"],
      apiKey: process.env["AUX_API_KEY"],
      name: process.env["AUX_MODEL_NAME"],
      timeoutMs: 60_000,
      maxTokens: 8_192,
    };
  }

  return config;
}

function validateConfig(config: SlaveAgentConfig, source: string): void {
  const errors: string[] = [];

  if (!config.model.baseUrl) errors.push("model.baseUrl is required");
  if (!config.model.apiKey) errors.push("model.apiKey is required (or set MODEL_API_KEY env var)");
  if (!config.model.name) errors.push("model.name is required");

  if (errors.length > 0) {
    throw makeError(
      "CONFIG_MISSING",
      `Configuration errors in ${source}:\n  - ${errors.join("\n  - ")}`
    );
  }
}

/**
 * Recursively converts all object keys from snake_case to camelCase.
 * Array elements and non-string values are passed through unchanged.
 * User-defined keys (e.g. MCP server names, env var names) that are not
 * snake_case are left intact because the regex only matches _[a-z].
 *
 * @internal Exported for unit testing.
 */
export function convertKeysToCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertKeysToCamelCase);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const camelKey = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[camelKey] = convertKeysToCamelCase(v);
    }
    return result;
  }
  return value;
}

/** Recursively replaces ${VAR_NAME} placeholders with process.env values */
function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      return process.env[name] ?? "";
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

/** Deep-merges source into target; source values override target values */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = structuredClone(target);
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as object, srcVal as object) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

/** Saves the current config to config.yaml in the profile directory */
export async function saveConfig(
  profileDir: string,
  config: SlaveAgentConfig
): Promise<void> {
  const configPath = path.join(profileDir, CONFIG_FILE);
  await fs.writeFile(configPath, yaml.dump(config), "utf-8");
}

/** Thrown when validation fails — re-exported for convenience */
export type { SlaveAgentError };
