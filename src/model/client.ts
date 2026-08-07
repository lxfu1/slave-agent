/**
 * OpenAI client factory.
 * Returns a plain OpenAI instance configured for the given endpoint.
 * Intentionally a pure factory — no singleton, no global state.
 * Callers are responsible for lifecycle management.
 */

import OpenAI from "openai";
import type { ModelConfig } from "../types/config.js";

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/** Creates an OpenAI-compatible client from a ModelConfig */
export function createClientFromConfig(config: ModelConfig): OpenAI {
  return createClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
}

/** Creates an OpenAI-compatible client from explicit options */
export function createClient(opts: ClientOptions): OpenAI {
  return new OpenAI({
    baseURL: opts.baseUrl,
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: 2,
  });
}
