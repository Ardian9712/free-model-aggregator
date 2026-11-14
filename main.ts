// free-model-aggregator-01 entry — Node 22, standard library only.
// `node main.ts --list` prints the catalog document; otherwise the server
// registers with the env, serves the client's requests, and exits 0 when done.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// --------------------------------------------------------------------- types

interface ProviderDir {
  id: string;
  name: string;
  wire: string;
  auth: string;
  key_env: string;
  key: string;
  path: string;
}

interface ProvidersDoc {
  schema: string;
  providers: ProviderDir[];
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface RatingsDoc {
  schema: string;
  ratings: RatingRow[];
}

interface Requirements {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface ManifestRequest {
  id: string;
  api: string;
  stream: boolean;
  weight: number;
  requires: Requirements;
}

interface WorkloadDoc {
  schema: string;
  manifest: ManifestRequest[];
}

interface ModelInfo {
  id: string;
  free: boolean;
  context_length: number;
  tools: boolean;
  vision: boolean;
  json: boolean;
  rating_milli: number;
}

interface ProviderRuntime {
  dir: ProviderDir;
  baseUrl: string;
  dial: { wire: string; auth: string; key: string };
  models: ModelInfo[];
  exhausted: boolean;
  outage: boolean;
  callsMade: number;
  refusals: number;
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: string;
  models: CatalogModel[];
}

interface CatalogDoc {
  schema: string;
  providers: CatalogProvider[];
}

interface InstanceDoc {
  providers: { id: string; name: string; wire: string; auth: string; key_env: string; key: string; base_url: string }[];
  workload: WorkloadDoc;
}

// ----------------------------------------------------------------- constants

const CATALOG_SCHEMA = "free-model-aggregator-01/catalog/v1";
const FIXED_CREATED = 1767225600;
const FIXED_CREATED_AT = "2026-01-01T00:00:00Z";
const ANTHROPIC_VERSION = "2023-06-01";
const LISTEN_HOST = "0.0.0.0";
const PREFERRED_PORTS = [8931, 8932, 8933, 8940];
const WORK_POLL_MS = 150;
const ENV_TIMEOUT_MS = 15000;
const PROVIDER_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DISCOVERY_ATTEMPTS = 3;
const WALL_GUARD_MS = 170000;

// -------------------------------------------------------------------- utils

function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next as Promise<T>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number, body?: string): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { headers, signal: controller.signal };
    if (body !== undefined) init.method = "POST";
    if (body !== undefined) init.body = body;
    const response = await fetch(url, init);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(auth: string, key: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth === "bearer") headers["authorization"] = `Bearer ${key}`;
  else if (auth === "x-api-key") headers["x-api-key"] = key;
  else if (auth === "x-goog-api-key") headers["x-goog-api-key"] = key;
  return headers;
}

function providerHeaders(provider: ProviderRuntime, extra?: Record<string, string>): Record<string, string> {
  const headers = authHeaders(provider.dial.auth, provider.dial.key);
  if (provider.dial.wire === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;
  if (extra !== undefined) {
    for (const key of Object.keys(extra)) headers[key] = extra[key];
  }
  return headers;
}

// ----------------------------------------------------------- prompt parsing

interface PromptBrief {
  directory: ProvidersDoc | null;
  ratings: RatingsDoc | null;
  workload: WorkloadDoc | null;
}

function parsePromptLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parsePromptFile(source: string): PromptBrief {
  const brief: PromptBrief = { directory: null, ratings: null, workload: null };
  for (const line of source.split("\n")) {
    const value = parsePromptLine(line);
    if (value === null || typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.schema === "free-model-aggregator-01/providers/v1") brief.directory = record as unknown as ProvidersDoc;
    else if (record.schema === "free-model-aggregator-01/ratings/v1") brief.ratings = record as unknown as RatingsDoc;
    else if (record.schema === "free-model-aggregator-01/workload/v1") brief.workload = record as unknown as WorkloadDoc;
  }
  return brief;
}

function readPromptBrief(): PromptBrief {
  const file = process.env.MAKEFUN_PROMPT_FILE ?? "";
  if (file === "") return { directory: null, ratings: null, workload: null };
  try {
    return parsePromptFile(readFileSync(file, "utf8"));
  } catch {
    return { directory: null, ratings: null, workload: null };
  }
}

// ------------------------------------------------------------ env instance

function envUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? "";
  return raw.replace(/\/+$/, "");
}

async function fetchInstance(): Promise<InstanceDoc | null> {
  const base = envUrl();
  if (base === "") return null;
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const reply = await fetchJson(`${base}/instance`, {}, ENV_TIMEOUT_MS);
      const body = reply.body as Record<string, unknown> | null;
      if (reply.status === 200 && body !== null && Array.isArray(body.providers)) {
        return {
          providers: body.providers as InstanceDoc["providers"],
          workload: (body.workload ?? { schema: "", manifest: [] }) as WorkloadDoc,
        };
      }
    } catch {
      // retry below
    }
    await sleep(200 * attempt);
  }
  return null;
}

// -------------------------------------------------------- model discovery

interface RawModel {
  id: string;
  free: boolean;
  context_length: number;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

function boolOf(value: unknown): boolean {
  return value === true;
}

function contextOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseOpenAiModels(body: unknown): RawModel[] {
  const record = body as { data?: unknown } | null;
  if (record === null || !Array.isArray(record.data)) return [];
  const models: RawModel[] = [];
  for (const item of record.data) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    models.push({
      id: entry.id,
      free: entry.free !== false,
      context_length: contextOf(entry.context_length, 0),
      tools: boolOf(entry.tools),
      vision: boolOf(entry.vision),
      json: boolOf(entry.json),
    });
  }
  return models;
}

function parseAnthropicModels(body: unknown): RawModel[] {
  const record = body as { data?: unknown } | null;
  if (record === null || !Array.isArray(record.data)) return [];
  const models: RawModel[] = [];
  for (const item of record.data) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    models.push({
      id: entry.id,
      free: entry.free !== false,
      context_length: contextOf(entry.context_length, 0),
      tools: boolOf(entry.tools),
      vision: boolOf(entry.vision),
      json: boolOf(entry.json),
    });
  }
  return models;
}

function parseGeminiModels(body: unknown): RawModel[] {
  const record = body as { models?: unknown } | null;
  if (record === null || !Array.isArray(record.models)) return [];
  const models: RawModel[] = [];
  for (const item of record.models) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : "";
    const id = name.startsWith("models/") ? name.slice("models/".length) : name;
    if (id === "") continue;
    models.push({
      id,
      free: entry.free !== false,
      context_length: contextOf(entry.context_length, contextOf(entry.inputTokenLimit, 0)),
      tools: boolOf(entry.tools),
      vision: boolOf(entry.vision),
      json: boolOf(entry.json),
    });
  }
  return models;
}

function modelsUrl(provider: ProviderRuntime): string {
  if (provider.dial.wire === "gemini") return `${provider.baseUrl}/v1beta/models`;
  return `${provider.baseUrl}/v1/models`;
}

async function discoverModels(provider: ProviderRuntime): Promise<RawModel[]> {
  const url = modelsUrl(provider);
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const reply = await fetchJson(url, providerHeaders(provider), ENV_TIMEOUT_MS);
      if (reply.status === 200) {
        if (provider.dial.wire === "gemini") return parseGeminiModels(reply.body);
        if (provider.dial.wire === "anthropic") return parseAnthropicModels(reply.body);
        return parseOpenAiModels(reply.body);
      }
    } catch {
      // retry below
    }
    await sleep(150 * attempt);
  }
  return [];
}

function modelsFromRatings(providerId: string, ratings: RatingsDoc | null): RawModel[] {
  if (ratings === null) return [];
  const models: RawModel[] = [];
  for (const row of ratings.ratings) {
    if (row.provider !== providerId) continue;
    models.push({
      id: row.model,
      free: row.free,
      context_length: row.context_length ?? 0,
      tools: row.tools,
      vision: row.vision,
      json: row.json,
    });
  }
  return models;
}

// ----------------------------------------------------------------- catalog

function ratingOf(ratings: RatingsDoc | null, providerId: string, modelId: string): number {
  if (ratings === null) return 0;
  for (const row of ratings.ratings) {
    if (row.provider === providerId && row.model === modelId) return row.rating_milli;
  }
  return 0;
}

function buildRuntimeProviders(
  directory: ProviderDir[],
  instanceProviders: InstanceDoc["providers"] | null,
): ProviderRuntime[] {
  const live = new Map<string, InstanceDoc["providers"][number]>();
  if (instanceProviders !== null) {
    for (const entry of instanceProviders) live.set(entry.id, entry);
  }
  return directory.map((dir) => {
    const found = live.get(dir.id);
    const entry = found !== undefined ? found : dir;
    return {
      dir,
      baseUrl: found !== undefined ? found.base_url : dir.path,
      dial: { wire: entry.wire, auth: entry.auth, key: entry.key },
      models: [],
      exhausted: false,
      outage: false,
      callsMade: 0,
      refusals: 0,
    };
  });
}

async function discoverAllModels(providers: ProviderRuntime[], ratings: RatingsDoc | null, gate: <T>(fn: () => Promise<T>) => Promise<T>): Promise<void> {
  const online = envUrl() !== "";
  for (const provider of providers) {
    let models: RawModel[] = online ? await gate(() => discoverModels(provider)) : [];
    if (models.length === 0) models = modelsFromRatings(provider.dir.id, ratings);
    provider.models = models.map((m) => ({
      id: m.id,
      free: m.free,
      context_length: m.context_length,
      tools: m.tools,
      vision: m.vision,
      json: m.json,
      rating_milli: ratingOf(ratings, provider.dir.id, m.id),
    }));
  }
}

function buildCatalog(providers: ProviderRuntime[]): CatalogDoc {
  return {
    schema: CATALOG_SCHEMA,
    providers: providers.map((provider) => ({
      id: provider.dir.id,
      base_url: provider.dir.path,
      key_env: provider.dir.key_env,
      wire: provider.dir.wire,
      models: provider.models.map((m) => ({ id: m.id, free: m.free, context_length: m.context_length })),
    })),
  };
}

// -------------------------------------------------------------- GET /models

function catalogModelRows(catalog: CatalogDoc): { id: string; free: boolean; context_length: number; tools: boolean; vision: boolean; json: boolean; owned_by: string }[] {
  const rows: { id: string; free: boolean; context_length: number; tools: boolean; vision: boolean; json: boolean; owned_by: string }[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      rows.push({ id: model.id, free: model.free, context_length: model.context_length, tools: false, vision: false, json: false, owned_by: provider.id });
    }
  }
  return rows;
}

// ------------------------------------------------------- completions engine

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function safeJsonParse(text: unknown): unknown {
  if (typeof text !== "string" || text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

type StopKind = "stop" | "length" | "tool_calls" | "content_filter";

interface NormalizedAnswer {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
  usage: { prompt: number; completion: number };
  stop: StopKind;
}

class RefusalError extends Error {
  kind: "budget" | "transient" | "concurrent";
  status: number;
  code: string;
  constructor(kind: "budget" | "transient" | "concurrent", status: number, code: string, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function stopKindOf(reason: unknown): StopKind {
  const r = typeof reason === "string" ? reason : "";
  if (r === "length" || r === "max_tokens" || r === "MAX_TOKENS") return "length";
  if (r === "tool_calls" || r === "function_call" || r === "tool_use") return "tool_calls";
  if (r === "content_filter" || r === "refusal" || r === "SAFETY") return "content_filter";
  return "stop";
}

function classifyRefusal(wire: string, status: number, body: unknown): RefusalError {
  let code = "";
  let message = "";
  if (isRecord(body) && isRecord(body.error)) {
    const err = body.error;
    if (typeof err.message === "string") message = err.message;
    if (wire === "anthropic") code = typeof err.type === "string" ? err.type : "";
    else if (wire === "gemini") code = typeof err.status === "string" ? err.status : "";
    else code = typeof err.code === "string" ? err.code : "";
  }
  if (status === 429 && (code === "concurrent_requests" || message.includes("concurrent") || message.includes("at a time"))) {
    return new RefusalError("concurrent", status, code || "concurrent_requests", message || "concurrent request refused");
  }
  if (message.includes("budget is spent") || message.includes("is out")) {
    return new RefusalError("budget", status, code || "budget_exhausted", message || "provider budget is spent");
  }
  return new RefusalError("transient", status, code || "transient", message || `provider refused with HTTP ${status}`);
}

function normalizeOpenAiAnswer(body: unknown): NormalizedAnswer {
  const root = isRecord(body) ? body : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls: { id: string; name: string; args: string }[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!isRecord(tc) || !isRecord(tc.function)) continue;
      toolCalls.push({
        id: typeof tc.id === "string" ? tc.id : "",
        name: String(tc.function.name ?? ""),
        args: typeof tc.function.arguments === "string" ? tc.function.arguments : "{}",
      });
    }
  }
  const usage = isRecord(root.usage) ? root.usage : {};
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    usage: { prompt: numberOr(usage.prompt_tokens, 0), completion: numberOr(usage.completion_tokens, 0) },
    stop: stopKindOf(choice.finish_reason),
  };
}

function normalizeAnthropicAnswer(body: unknown): NormalizedAnswer {
  const root = isRecord(body) ? body : {};
  const content = Array.isArray(root.content) ? root.content : [];
  let text = "";
  const toolCalls: { id: string; name: string; args: string }[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        args: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = isRecord(root.usage) ? root.usage : {};
  return {
    text,
    toolCalls,
    usage: { prompt: numberOr(usage.input_tokens, 0), completion: numberOr(usage.output_tokens, 0) },
    stop: stopKindOf(root.stop_reason),
  };
}

function normalizeGeminiAnswer(body: unknown): NormalizedAnswer {
  const root = isRecord(body) ? body : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const cand = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(cand.content) ? cand.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = "";
  const toolCalls: { id: string; name: string; args: string }[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") text += part.text;
    else if (isRecord(part.functionCall)) {
      toolCalls.push({
        id: "",
        name: typeof part.functionCall.name === "string" ? part.functionCall.name : "",
        args: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  const usage = isRecord(root.usageMetadata) ? root.usageMetadata : {};
  return {
    text,
    toolCalls,
    usage: { prompt: numberOr(usage.promptTokenCount, 0), completion: numberOr(usage.candidatesTokenCount, 0) },
    stop: stopKindOf(cand.finishReason),
  };
}

async function callOpenAi(provider: ProviderRuntime, model: string, body: Record<string, unknown>): Promise<NormalizedAnswer> {
  const headers = providerHeaders(provider, { "content-type": "application/json" });
  let reply: JsonResponse;
  try {
    reply = await fetchJson(`${provider.baseUrl}/v1/chat/completions`, headers, PROVIDER_TIMEOUT_MS, JSON.stringify({ ...body, model }));
  } catch {
    throw new RefusalError("transient", 0, "network_error", "provider unreachable");
  }
  if (reply.status < 200 || reply.status > 299) throw classifyRefusal("openai", reply.status, reply.body);
  return normalizeOpenAiAnswer(reply.body);
}

async function callAnthropic(provider: ProviderRuntime, model: string, body: Record<string, unknown>, anthropicVersion: string): Promise<NormalizedAnswer> {
  const headers = providerHeaders(provider, { "content-type": "application/json", "anthropic-version": anthropicVersion });
  let reply: JsonResponse;
  try {
    reply = await fetchJson(`${provider.baseUrl}/v1/messages`, headers, PROVIDER_TIMEOUT_MS, JSON.stringify({ ...body, model }));
  } catch {
    throw new RefusalError("transient", 0, "network_error", "provider unreachable");
  }
  if (reply.status < 200 || reply.status > 299) throw classifyRefusal("anthropic", reply.status, reply.body);
  return normalizeAnthropicAnswer(reply.body);
}

async function callGemini(provider: ProviderRuntime, model: string, body: Record<string, unknown>): Promise<NormalizedAnswer> {
  const headers = providerHeaders(provider, { "content-type": "application/json" });
  const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let reply: JsonResponse;
  try {
    reply = await fetchJson(url, headers, PROVIDER_TIMEOUT_MS, JSON.stringify(body));
  } catch {
    throw new RefusalError("transient", 0, "network_error", "provider unreachable");
  }
  if (reply.status < 200 || reply.status > 299) throw classifyRefusal("gemini", reply.status, reply.body);
  return normalizeGeminiAnswer(reply.body);
}

function callProvider(provider: ProviderRuntime, model: string, body: Record<string, unknown>, anthropicVersion: string): Promise<NormalizedAnswer> {
  if (provider.dial.wire === "anthropic") return callAnthropic(provider, model, body, anthropicVersion);
  if (provider.dial.wire === "gemini") return callGemini(provider, model, body);
  return callOpenAi(provider, model, body);
}

function openAiTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function openAiImageToAnthropic(url: string): Record<string, unknown> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match !== null) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  return { type: "image", source: { type: "url", url } };
}

function openAiImageToGemini(url: string): Record<string, unknown> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match !== null) return { inlineData: { mimeType: match[1], data: match[2] } };
  return { fileData: { fileUri: url } };
}

function openAiToAnthropicBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model };
  const messages: Record<string, unknown>[] = [];
  const systemParts: string[] = [];
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg)) continue;
    const role = msg.role;
    if (role === "system") {
      systemParts.push(openAiTextOf(msg.content));
      continue;
    }
    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : "", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? null) }],
      });
      continue;
    }
    const targetRole = role === "assistant" ? "assistant" : "user";
    const blocks: Record<string, unknown>[] = [];
    if (typeof msg.content === "string") {
      if (msg.content !== "") blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
        else if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") blocks.push(openAiImageToAnthropic(part.image_url.url));
      }
    }
    if (targetRole === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isRecord(tc) || !isRecord(tc.function)) continue;
        blocks.push({ type: "tool_use", id: typeof tc.id === "string" ? tc.id : "", name: String(tc.function.name ?? ""), input: safeJsonParse(tc.function.arguments) });
      }
    }
    messages.push({ role: targetRole, content: blocks });
  }
  if (systemParts.length > 0) out.system = systemParts.join("\n");
  out.messages = messages;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => {
      const fn = isRecord(t) && isRecord(t.function) ? t.function : {};
      const tool: Record<string, unknown> = { name: String(fn.name ?? "") };
      if (typeof fn.description === "string") tool.description = fn.description;
      tool.input_schema = isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
      return tool;
    });
  }
  if (body.tool_choice === "auto") out.tool_choice = { type: "auto" };
  else if (body.tool_choice === "required") out.tool_choice = { type: "any" };
  else if (isRecord(body.tool_choice) && isRecord(body.tool_choice.function) && typeof body.tool_choice.function.name === "string") out.tool_choice = { type: "tool", name: body.tool_choice.function.name };
  const maxTokens = numberOr(body.max_tokens, numberOr(body.max_completion_tokens, 0));
  if (maxTokens > 0) out.max_tokens = maxTokens;
  if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  else if (typeof body.stop === "string" && body.stop !== "") out.stop_sequences = [body.stop];
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  return out;
}

function openAiToGeminiBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  void model;
  const out: Record<string, unknown> = {};
  const contents: Record<string, unknown>[] = [];
  const systemParts: string[] = [];
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg)) continue;
    const role = msg.role;
    if (role === "system") {
      systemParts.push(openAiTextOf(msg.content));
      continue;
    }
    if (role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: "", response: { result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? null) } } }] });
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    if (typeof msg.content === "string") {
      if (msg.content !== "") parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") parts.push({ text: part.text });
        else if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") parts.push(openAiImageToGemini(part.image_url.url));
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isRecord(tc) || !isRecord(tc.function)) continue;
        parts.push({ functionCall: { name: String(tc.function.name ?? ""), args: safeJsonParse(tc.function.arguments) } });
      }
    }
    contents.push({ role: role === "assistant" ? "model" : "user", parts });
  }
  if (systemParts.length > 0) out.systemInstruction = { parts: [{ text: systemParts.join("\n") }] };
  out.contents = contents;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => {
      const fn = isRecord(t) && isRecord(t.function) ? t.function : {};
      const decl: Record<string, unknown> = { name: String(fn.name ?? "") };
      if (typeof fn.description === "string") decl.description = fn.description;
      if (isRecord(fn.parameters)) decl.parameters = fn.parameters;
      return { functionDeclarations: [decl] };
    });
  }
  if (body.tool_choice === "auto") out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  else if (body.tool_choice === "required") out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
  else if (body.tool_choice === "none") out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  else if (isRecord(body.tool_choice) && isRecord(body.tool_choice.function) && typeof body.tool_choice.function.name === "string") out.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [body.tool_choice.function.name] } };
  const config: Record<string, unknown> = {};
  const maxTokens = numberOr(body.max_tokens, numberOr(body.max_completion_tokens, 0));
  if (maxTokens > 0) config.maxOutputTokens = maxTokens;
  if (Array.isArray(body.stop)) config.stopSequences = body.stop;
  else if (typeof body.stop === "string" && body.stop !== "") config.stopSequences = [body.stop];
  if (typeof body.temperature === "number") config.temperature = body.temperature;
  if (typeof body.top_p === "number") config.topP = body.top_p;
  if (isRecord(body.response_format) && typeof body.response_format.type === "string" && body.response_format.type.startsWith("json")) config.responseMimeType = "application/json";
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

function translateOpenAiTo(wire: string, body: Record<string, unknown>, model: string): Record<string, unknown> {
  if (wire === "anthropic") return openAiToAnthropicBody(body, model);
  if (wire === "gemini") return openAiToGeminiBody(body, model);
  return { ...body, model, stream: false };
}

function answerToOpenAi(answer: NormalizedAnswer, model: string): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: answer.text };
  if (answer.toolCalls.length > 0) {
    message.tool_calls = answer.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }));
  }
  return {
    id: "chatcmpl-entry",
    object: "chat.completion",
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message, finish_reason: answer.stop, logprobs: null }],
    usage: { prompt_tokens: answer.usage.prompt, completion_tokens: answer.usage.completion, total_tokens: answer.usage.prompt + answer.usage.completion },
  };
}

interface OpenAiRequirements {
  tools: boolean;
  vision: boolean;
  json: boolean;
  minContext: number;
}

function inferOpenAiRequirements(body: Record<string, unknown>, manifestEntry: ManifestRequest | null): OpenAiRequirements {
  let tools = Array.isArray(body.tools) && body.tools.length > 0;
  let vision = false;
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (isRecord(part) && (part.type === "image_url" || part.type === "image")) vision = true;
    }
  }
  let json = isRecord(body.response_format) && typeof body.response_format.type === "string" && body.response_format.type.startsWith("json");
  let minContext = 0;
  const requires = manifestEntry !== null ? manifestEntry.requires : {};
  if (requires.tools === true) tools = true;
  if (requires.vision === true) vision = true;
  if (requires.json === true) json = true;
  if (typeof requires.min_context === "number") minContext = requires.min_context;
  return { tools, vision, json, minContext };
}

interface Candidate {
  provider: ProviderRuntime;
  model: ModelInfo;
}

function selectModel(app: App, reqs: OpenAiRequirements, jsonOnWire: boolean): Candidate[] {
  const candidates: Candidate[] = [];
  for (const provider of app.providers) {
    if (provider.exhausted || provider.outage) continue;
    if (jsonOnWire && provider.dial.wire !== "openai" && provider.dial.wire !== "gemini") continue;
    let best: ModelInfo | null = null;
    for (const model of provider.models) {
      if (!model.free) continue;
      if (reqs.tools && !model.tools) continue;
      if (reqs.vision && !model.vision) continue;
      if (reqs.json && !model.json) continue;
      if (reqs.minContext > 0 && model.context_length < reqs.minContext) continue;
      if (best === null || model.rating_milli > best.rating_milli) best = model;
    }
    if (best === null) continue;
    candidates.push({ provider, model: best });
  }
  candidates.sort((a, b) => b.model.rating_milli - a.model.rating_milli || a.provider.callsMade - b.provider.callsMade || (a.provider.dir.id < b.provider.dir.id ? -1 : a.provider.dir.id > b.provider.dir.id ? 1 : 0));
  return candidates;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

interface ServedAnswer {
  answer: NormalizedAnswer;
  model: string;
}

async function serveThroughProviders(app: App, candidates: Candidate[], translate: (wire: string, model: string) => Record<string, unknown>, anthropicVersion: string): Promise<ServedAnswer | null> {
  return await app.mutex(async (): Promise<ServedAnswer | null> => {
    for (const cand of candidates) {
      const payload = translate(cand.provider.dial.wire, cand.model.id);
      cand.provider.callsMade += 1;
      try {
        const answer = await callProvider(cand.provider, cand.model.id, payload, anthropicVersion);
        return { answer, model: cand.model.id };
      } catch (err) {
        if (err instanceof RefusalError) {
          cand.provider.refusals += 1;
          if (err.kind === "budget") {
            cand.provider.exhausted = true;
            cand.provider.outage = true;
          }
          continue;
        }
        throw err;
      }
    }
    return null;
  });
}

function writeJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function emitOpenAiStream(res: ServerResponse, answer: NormalizedAnswer, model: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  const chunk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: "chatcmpl-entry",
    object: "chat.completion.chunk",
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  let out = frame(chunk({ role: "assistant", content: "" }, null));
  if (answer.toolCalls.length > 0) {
    for (let i = 0; i < answer.toolCalls.length; i++) {
      const tc = answer.toolCalls[i];
      out += frame(chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] }, null));
    }
  } else {
    out += frame(chunk({ content: answer.text }, null));
  }
  const finishChunk = chunk({}, answer.stop);
  finishChunk.usage = { prompt_tokens: answer.usage.prompt, completion_tokens: answer.usage.completion, total_tokens: answer.usage.prompt + answer.usage.completion };
  out += frame(finishChunk);
  out += "data: [DONE]\n\n";
  res.end(out);
}

function emitAnthropicStream(res: ServerResponse, answer: NormalizedAnswer, model: string): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const event = (name: string, payload: unknown): string => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  let out = event("message_start", { type: "message_start", message: { id: "msg_entry", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: answer.usage.prompt, output_tokens: 0 } } });
  let index = 0;
  if (answer.text !== "") {
    out += event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    out += event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: answer.text } });
    out += event("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  for (const tc of answer.toolCalls) {
    out += event("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tc.id, name: tc.name } });
    out += event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tc.args } });
    out += event("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  const stopReason = answer.stop === "length" ? "max_tokens" : answer.stop === "tool_calls" ? "tool_use" : answer.stop === "content_filter" ? "refusal" : "end_turn";
  out += event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: answer.usage.completion } });
  out += event("message_stop", { type: "message_stop" });
  res.end(out);
}

async function handleOpenAiCompletion(req: IncomingMessage, res: ServerResponse, app: App, manifestEntry: ManifestRequest | null): Promise<void> {
  const raw = await readBody(req, MAX_BODY_BYTES);
  let body: unknown = null;
  if (raw !== null) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = null;
    }
  }
  if (!isRecord(body)) {
    writeJson(res, 400, JSON.stringify({ error: { message: "the request body is not one JSON object", type: "invalid_request_error", param: null, code: "invalid_request" } }));
    return;
  }
  const reqs = inferOpenAiRequirements(body, manifestEntry);
  const jsonOnWire = isRecord(body.response_format) && typeof body.response_format.type === "string" && body.response_format.type.startsWith("json");
  const candidates = selectModel(app, reqs, jsonOnWire);
  const anthropicVersion = typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : ANTHROPIC_VERSION;
  const served = await serveThroughProviders(app, candidates, (wire, model) => translateOpenAiTo(wire, body, model), anthropicVersion);
  app.servedCount += 1;
  if (served === null) {
    writeJson(res, 502, JSON.stringify({ error: { message: "all providers refused", type: "all_providers_refused", param: null, code: "all_providers_refused" } }));
    return;
  }
  if (body.stream === true) {
    emitOpenAiStream(res, served.answer, served.model);
    return;
  }
  writeJson(res, 200, JSON.stringify(answerToOpenAi(served.answer, served.model)));
}

// ------------------------------------------------- completions (anthropic)

function anthropicSystemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function anthropicImageToOpenAi(source: Record<string, unknown>): Record<string, unknown> | null {
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

function anthropicImageToGemini(source: Record<string, unknown>): Record<string, unknown> | null {
  if (source.type === "base64" && typeof source.data === "string") {
    return { inlineData: { mimeType: typeof source.media_type === "string" ? source.media_type : "image/png", data: source.data } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { fileData: { fileUri: source.url } };
  }
  return null;
}

function anthropicToOpenAiBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model };
  const messages: Record<string, unknown>[] = [];
  const system = anthropicSystemText(body.system);
  if (system !== "") messages.push({ role: "system", content: system });
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg)) continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      messages.push({ role, content: msg.content });
      continue;
    }
    const textParts: string[] = [];
    const imageBlocks: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: Record<string, unknown>[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
        else if (block.type === "image" && isRecord(block.source)) {
          const image = anthropicImageToOpenAi(block.source);
          if (image !== null) imageBlocks.push(image);
        } else if (block.type === "tool_use") {
          toolCalls.push({ id: typeof block.id === "string" ? block.id : "", type: "function", function: { name: typeof block.name === "string" ? block.name : "", arguments: JSON.stringify(block.input ?? {}) } });
        } else if (block.type === "tool_result") {
          toolResults.push({ role: "tool", tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "", content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null) });
        }
      }
    }
    if (role === "assistant") {
      const message: Record<string, unknown> = { role: "assistant", content: textParts.join("") };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      messages.push(message);
    } else {
      const content: Record<string, unknown>[] = [];
      for (const text of textParts) content.push({ type: "text", text });
      for (const image of imageBlocks) content.push(image);
      if (content.length > 0) messages.push({ role: "user", content });
      else if (toolResults.length === 0) messages.push({ role: "user", content: "" });
      for (const result of toolResults) messages.push(result);
    }
  }
  out.messages = messages;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => {
      const tool = isRecord(t) ? t : {};
      const fn: Record<string, unknown> = { name: String(tool.name ?? "") };
      if (typeof tool.description === "string") fn.description = tool.description;
      fn.parameters = isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} };
      return { type: "function", function: fn };
    });
  }
  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === "auto") out.tool_choice = "auto";
    else if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool" && typeof choice.name === "string") out.tool_choice = { type: "function", function: { name: choice.name } };
  }
  const maxTokens = numberOr(body.max_tokens, 0);
  if (maxTokens > 0) out.max_tokens = maxTokens;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  else if (typeof body.stop_sequences === "string" && body.stop_sequences !== "") out.stop = [body.stop_sequences];
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  return out;
}

function anthropicToGeminiBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  void model;
  const out: Record<string, unknown> = {};
  const system = anthropicSystemText(body.system);
  if (system !== "") out.systemInstruction = { parts: [{ text: system }] };
  const contents: Record<string, unknown>[] = [];
  const toolNames = new Map<string, string>();
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg)) continue;
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [];
    if (typeof msg.content === "string") {
      if (msg.content !== "") parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") parts.push({ text: block.text });
        else if (block.type === "image" && isRecord(block.source)) {
          const image = anthropicImageToGemini(block.source);
          if (image !== null) parts.push(image);
        } else if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "";
          if (typeof block.id === "string" && block.id !== "") toolNames.set(block.id, name);
          parts.push({ functionCall: { name, args: isRecord(block.input) ? block.input : {} } });
        } else if (block.type === "tool_result") {
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          parts.push({ functionResponse: { name: toolNames.get(id) ?? "", response: { result: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null) } } });
        }
      }
    }
    contents.push({ role, parts });
  }
  out.contents = contents;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => {
      const tool = isRecord(t) ? t : {};
      const decl: Record<string, unknown> = { name: String(tool.name ?? "") };
      if (typeof tool.description === "string") decl.description = tool.description;
      if (isRecord(tool.input_schema)) decl.parameters = tool.input_schema;
      return { functionDeclarations: [decl] };
    });
  }
  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === "auto") out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    else if (choice.type === "any") out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (choice.type === "none") out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (choice.type === "tool" && typeof choice.name === "string") out.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
  }
  const config: Record<string, unknown> = {};
  const maxTokens = numberOr(body.max_tokens, 0);
  if (maxTokens > 0) config.maxOutputTokens = maxTokens;
  if (Array.isArray(body.stop_sequences)) config.stopSequences = body.stop_sequences;
  else if (typeof body.stop_sequences === "string" && body.stop_sequences !== "") config.stopSequences = [body.stop_sequences];
  if (typeof body.temperature === "number") config.temperature = body.temperature;
  if (typeof body.top_p === "number") config.topP = body.top_p;
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

function translateAnthropicTo(wire: string, body: Record<string, unknown>, model: string): Record<string, unknown> {
  if (wire === "openai") return anthropicToOpenAiBody(body, model);
  if (wire === "gemini") return anthropicToGeminiBody(body, model);
  return { ...body, model, stream: false };
}

function answerToAnthropic(answer: NormalizedAnswer, model: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (answer.text !== "") content.push({ type: "text", text: answer.text });
  for (const tc of answer.toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeJsonParse(tc.args) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const stopReason = answer.stop === "length" ? "max_tokens" : answer.stop === "tool_calls" ? "tool_use" : answer.stop === "content_filter" ? "refusal" : "end_turn";
  return {
    id: "msg_entry",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: answer.usage.prompt, output_tokens: answer.usage.completion },
  };
}

function inferAnthropicRequirements(body: Record<string, unknown>, manifestEntry: ManifestRequest | null): OpenAiRequirements {
  let tools = Array.isArray(body.tools) && body.tools.length > 0;
  let vision = false;
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isRecord(block) && block.type === "image") vision = true;
    }
  }
  let json = false;
  let minContext = 0;
  const requires = manifestEntry !== null ? manifestEntry.requires : {};
  if (requires.tools === true) tools = true;
  if (requires.vision === true) vision = true;
  if (requires.json === true) json = true;
  if (typeof requires.min_context === "number") minContext = requires.min_context;
  return { tools, vision, json, minContext };
}

async function handleAnthropicMessage(req: IncomingMessage, res: ServerResponse, app: App, manifestEntry: ManifestRequest | null): Promise<void> {
  const raw = await readBody(req, MAX_BODY_BYTES);
  let body: unknown = null;
  if (raw !== null) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = null;
    }
  }
  if (!isRecord(body)) {
    writeJson(res, 400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the request body is not one JSON object" } }));
    return;
  }
  const reqs = inferAnthropicRequirements(body, manifestEntry);
  const candidates = selectModel(app, reqs, reqs.json);
  // stream=true is answered from the accumulated provider answer; SSE frames are synthesized below.
  const anthropicVersion = typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : ANTHROPIC_VERSION;
  const served = await serveThroughProviders(app, candidates, (wire, model) => translateAnthropicTo(wire, body, model), anthropicVersion);
  app.servedCount += 1;
  if (served === null) {
    writeJson(res, 502, JSON.stringify({ type: "error", error: { type: "all_providers_refused", message: "all providers refused" } }));
    return;
  }
  if (body.stream === true) {
    emitAnthropicStream(res, served.answer, served.model);
    return;
  }
  writeJson(res, 200, JSON.stringify(answerToAnthropic(served.answer, served.model)));
}

// ------------------------------------------------------------------ server

interface App {
  providers: ProviderRuntime[];
  catalog: CatalogDoc;
  catalogJson: string;
  manifest: ManifestRequest[];
  mutex: <T>(fn: () => Promise<T>) => Promise<T>;
  servedCount: number;
}

function manifestEntryFor(app: App): ManifestRequest | null {
  const at = app.servedCount;
  return at < app.manifest.length ? app.manifest[at] : null;
}

function handleModels(req: IncomingMessage, app: App): { status: number; body: string } {
  const wantAnthropic = req.headers["x-api-key"] !== undefined;
  const rows = catalogModelRows(app.catalog);
  const capabilities = new Map<string, ModelInfo>();
  for (const provider of app.providers) {
    for (const model of provider.models) capabilities.set(`${provider.dir.id}\n${model.id}`, model);
  }
  if (wantAnthropic) {
    const data = rows.map((row) => {
      const caps = capabilities.get(`${row.owned_by}\n${row.id}`);
      return {
        type: "model",
        id: row.id,
        display_name: row.id,
        created_at: FIXED_CREATED_AT,
        free: row.free,
        context_length: row.context_length,
        tools: caps !== undefined ? caps.tools : false,
        vision: caps !== undefined ? caps.vision : false,
        json: caps !== undefined ? caps.json : false,
      };
    });
    return { status: 200, body: JSON.stringify({ data, has_more: false }) };
  }
  const data = rows.map((row) => {
    const caps = capabilities.get(`${row.owned_by}\n${row.id}`);
    return {
      id: row.id,
      object: "model",
      created: FIXED_CREATED,
      owned_by: row.owned_by,
      free: row.free,
      context_length: row.context_length,
      tools: caps !== undefined ? caps.tools : false,
      vision: caps !== undefined ? caps.vision : false,
      json: caps !== undefined ? caps.json : false,
    };
  });
  return { status: 200, body: JSON.stringify({ object: "list", data }) };
}

function notFound(method: string, path: string): string {
  return JSON.stringify({ error: { message: `no route ${method} ${path}`, type: "invalid_request_error", param: null, code: "not_found" } });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, app: App): Promise<void> {
  const url = new URL(req.url ?? "/", "http://entry");
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path === "/v1/models" && method === "GET") {
    const reply = handleModels(req, app);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
    return;
  }
  if (path === "/v1/chat/completions" && method === "POST") {
    await handleOpenAiCompletion(req, res, app, manifestEntryFor(app));
    return;
  }
  if (path === "/v1/messages" && method === "POST") {
    await handleAnthropicMessage(req, res, app, manifestEntryFor(app));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(notFound(method, path));
}

async function listen(app: App): Promise<number> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, app).catch(() => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "internal error", type: "api_error", param: null, code: "internal" } }));
      } catch {
        // response already gone
      }
    });
  });
  for (const port of PREFERRED_PORTS) {
    const bound = await tryListen(server, port);
    if (bound) return port;
  }
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LISTEN_HOST, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function tryListen(server: ReturnType<typeof createServer>, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      resolve(false);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LISTEN_HOST);
  });
}

// ------------------------------------------------------- register and work

async function register(app: App, port: number): Promise<number> {
  const base = envUrl();
  const body = `{"protocol_version":1,"port":${port},"catalog":${app.catalogJson}}`;
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const reply = await fetchJson(`${base}/register`, { "content-type": "application/json" }, ENV_TIMEOUT_MS, body);
      const record = reply.body as Record<string, unknown> | null;
      if (reply.status === 200 && record !== null && record.ok === true) {
        const requests = typeof record.requests === "number" ? record.requests : app.manifest.length;
        return requests;
      }
    } catch {
      // retry below
    }
    await sleep(200 * attempt);
  }
  throw new Error("register failed");
}

async function pollWorkUntilDone(app: App): Promise<void> {
  const base = envUrl();
  for (;;) {
    let done = false;
    await app.mutex(async () => {
      try {
        const reply = await fetchJson(`${base}/work`, {}, ENV_TIMEOUT_MS);
        const record = reply.body as Record<string, unknown> | null;
        if (reply.status === 200 && record !== null) {
          if (record.done === true) done = true;
        }
      } catch {
        // keep polling
      }
    });
    if (done) return;
    await sleep(WORK_POLL_MS);
  }
}

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listMode = args.includes("--list");
  const brief = readPromptBrief();
  const gate = createMutex();

  if (brief.directory === null && envUrl() === "") {
    process.stdout.write(`{"providers":[]}\n`);
    process.exit(0);
  }

  const directory: ProviderDir[] = brief.directory !== null ? brief.directory.providers : [];
  const instance = await fetchInstance();
  const providers = buildRuntimeProviders(directory, instance !== null ? instance.providers : null);

  await discoverAllModels(providers, brief.ratings, gate);

  const catalog = buildCatalog(providers);
  const catalogJson = JSON.stringify(catalog);

  if (listMode) {
    process.stdout.write(`${catalogJson}\n`);
    process.exit(0);
  }

  const manifest: ManifestRequest[] = instance !== null ? instance.workload.manifest : brief.workload !== null ? brief.workload.manifest : [];
  const app: App = { providers, catalog, catalogJson, manifest, mutex: gate, servedCount: 0 };

  const port = await listen(app);
  await register(app, port);

  const wall = setTimeout(() => process.exit(0), WALL_GUARD_MS);
  wall.unref();

  await pollWorkUntilDone(app);
  process.exit(0);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

void main().catch((err: Error) => {
  process.stderr.write(`free-model-aggregator entry: ${err.message}\n`);
  process.exit(1);
});
