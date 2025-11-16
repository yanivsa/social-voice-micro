const DEFAULT_APP_VERSION = "v0.1.4";
const DEFAULT_CACHE_INTERVAL_MS = 15_000;
const DEFAULT_FALLBACK_CACHE_MS = 120_000;
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel

type FeedMode = "timeline" | "search";
type ProviderName = "x" | "sociavault";

interface EnvBindings {
  DB: D1Database;
  X_BEARER_TOKEN?: string;
  SOCIAVAULT_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
  SOCIAVAULT_DEFAULT_HANDLE?: string;
  APP_VERSION?: string;
  CACHE_INTERVAL_MS?: string;
  FALLBACK_CACHE_MS?: string;
  DEFAULT_FEED_QUERY?: string;
  DEFAULT_TTS_ENGINE?: string;
}

interface UnifiedPost {
  id: string;
  author: string;
  handle: string;
  avatarUrl?: string;
  text: string;
  createdAt: string;
  permalink?: string;
}

interface FeedMeta {
  fetchedAt: string;
  provider: ProviderName | "cache";
  fromCache: boolean;
  stale: boolean;
  mode: FeedMode;
  query: string;
  limit: number;
  version: string;
}

interface FeedResponse {
  source: ProviderName;
  posts: UnifiedPost[];
  meta: FeedMeta;
}

interface FetchContext {
  env: EnvBindings;
  mode: FeedMode;
  query: string;
  limit: number;
}

interface ProviderResult {
  provider: ProviderName;
  posts: UnifiedPost[];
  cooldownUntil?: string;
}

class ProviderFetchError extends Error {
  constructor(
    public provider: ProviderName,
    message: string,
    public status?: number,
    public isRateLimit?: boolean
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: EnvBindings, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return withCors(
        request,
        new Response(
        "Social Voice Micro Browser Worker\nUse /api/feed or open the Pages-hosted index.html.",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
        )
      );
    }

    if (url.pathname === "/api/feed") {
      return withCors(request, await handleFeedRequest(request, env));
    }

    if (url.pathname === "/api/settings") {
      if (request.method === "GET") {
        return withCors(request, await handleSettingsGet(env));
      }
      if (request.method === "POST") {
        return withCors(request, await handleSettingsPost(request, env));
      }
      return withCors(request, methodNotAllowed(["GET", "POST"]));
    }

    if (url.pathname === "/api/tts/elevenlabs") {
      if (request.method !== "POST") {
        return withCors(request, methodNotAllowed(["POST"]));
      }
      return withCors(request, await handleElevenLabsTTS(request, env, ctx));
    }

    if (url.pathname === "/api/meta") {
      return withCors(
        request,
        jsonResponse({
        version: getAppVersion(env),
        now: new Date().toISOString(),
        })
      );
    }

    return withCors(request, new Response("Not found", { status: 404 }));
  },
};

async function handleFeedRequest(request: Request, env: EnvBindings) {
  const url = new URL(request.url);
  const rawMode = url.searchParams.get("mode");
  const mode: FeedMode =
    rawMode === "search" || rawMode === "timeline" ? rawMode : await getDefaultMode(env);
  const limit = clampLimit(Number(url.searchParams.get("limit")) || DEFAULT_FEED_LIMIT);
  let query = (url.searchParams.get("q") || "").trim();

  if (mode === "timeline" && !query) {
    query = (await getDefaultQuery(env)) || "";
  }

  if (!query) {
    return jsonResponse(
      {
        error: {
          message:
            mode === "timeline"
              ? "Timeline query is not configured. Update default_query in settings."
              : "Missing search query (?q).",
        },
      },
      { status: 400 }
    );
  }

  const cacheKey = `${mode}:${query.toLowerCase()}`;
  const config = getRuntimeConfig(env);
  const cached = await getCachedFeed(env, cacheKey);
  const now = Date.now();

  if (cached && now - cached.fetchedAt.getTime() < config.cacheIntervalMs) {
    const parsed = cached.payload as FeedResponse;
    parsed.meta = {
      ...(parsed.meta || createMeta("cache", mode, query, limit, env)),
      provider: parsed.meta?.provider ?? parsed.source,
      fromCache: true,
      stale: false,
    };
    return jsonResponse(parsed);
  }

  const providerOrder = await getProviderOrder(env);
  const errors: ProviderFetchError[] = [];
  let providerResult: ProviderResult | null = null;

  for (const provider of providerOrder) {
    try {
      providerResult =
        provider === "x"
          ? await fetchFromX({ env, mode, query, limit })
          : await fetchFromSociaVault({ env, mode, query, limit });
      break;
    } catch (error) {
      if (error instanceof ProviderFetchError) {
        errors.push(error);
        if (error.provider === "x" && error.isRateLimit) {
          await setXBlockedUntil(env, error.status);
        }
        continue;
      }
      errors.push(
        new ProviderFetchError(
          provider,
          error instanceof Error ? error.message : "Unknown provider error"
        )
      );
    }
  }

  if (!providerResult) {
    if (cached && now - cached.fetchedAt.getTime() < config.fallbackCacheMs) {
      const parsed = cached.payload as FeedResponse;
      parsed.meta = {
        ...(parsed.meta || createMeta("cache", mode, query, limit, env)),
        provider: parsed.meta?.provider ?? parsed.source,
        fromCache: true,
        stale: true,
      };
      return jsonResponse(parsed, {
        status: 200,
        headers: { "x-social-voice-warning": "stale-cache" },
      });
    }

    const detail = errors.map((e) => `${e.provider}:${e.message}`).join(" | ") || "No providers available";
    return jsonResponse(
      {
        error: {
          message: "Unable to fetch feed from any provider",
          detail,
        },
      },
      { status: 503 }
    );
  }

  const feedResponse: FeedResponse = {
    source: providerResult.provider,
    posts: providerResult.posts,
    meta: createMeta(providerResult.provider, mode, query, limit, env),
  };

  if (providerResult.provider === "x" && providerResult.cooldownUntil) {
    await setXBlockedUntil(env, undefined, providerResult.cooldownUntil);
  }

  await persistFeedCache(env, cacheKey, providerResult.provider, feedResponse);
  await logUsage(env, providerResult.provider, mode);

  return jsonResponse(feedResponse);
}

function handleOptions(request: Request) {
  const origin = request.headers.get("Origin") ?? "*";
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  const reqHeaders = request.headers.get("Access-Control-Request-Headers");
  if (reqHeaders) {
    headers.set("Access-Control-Allow-Headers", reqHeaders);
  }
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

async function handleSettingsGet(env: EnvBindings) {
  const [defaultQuery, defaultMode, ttsEngine, defaultVoiceId, xBlockedUntil] = await Promise.all([
    getSetting(env, "default_query"),
    getSetting(env, "default_mode"),
    getSetting(env, "tts_engine"),
    getSetting(env, "default_voice_id"),
    getSetting(env, "x_blocked_until"),
  ]);

  return jsonResponse({
    version: getAppVersion(env),
    defaultMode: (defaultMode as FeedMode | null) ?? "timeline",
    defaultQuery: (defaultQuery as string | null) ?? env.DEFAULT_FEED_QUERY ?? "",
    ttsEngine: (ttsEngine as string | null) ?? env.DEFAULT_TTS_ENGINE ?? "browser",
    defaultVoiceId: (defaultVoiceId as string | null) ?? "",
    xBlockedUntil: xBlockedUntil as string | null,
  });
}

async function handleSettingsPost(request: Request, env: EnvBindings) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const updates: [string, unknown][] = [];

  if (payload.defaultMode !== undefined) {
    if (payload.defaultMode === "timeline" || payload.defaultMode === "search") {
      updates.push(["default_mode", payload.defaultMode]);
    } else {
      return jsonResponse(
        { error: { message: "defaultMode must be 'timeline' or 'search'" } },
        { status: 400 }
      );
    }
  }

  if (payload.defaultQuery !== undefined) {
    if (typeof payload.defaultQuery === "string") {
      updates.push(["default_query", payload.defaultQuery.trim()]);
    } else {
      return jsonResponse(
        { error: { message: "defaultQuery must be a string" } },
        { status: 400 }
      );
    }
  }

  if (payload.ttsEngine !== undefined) {
    if (
      payload.ttsEngine === "browser" ||
      payload.ttsEngine === "elevenlabs" ||
      payload.ttsEngine === "none"
    ) {
      updates.push(["tts_engine", payload.ttsEngine]);
    } else {
      return jsonResponse(
        { error: { message: "ttsEngine must be browser|elevenlabs|none" } },
        { status: 400 }
      );
    }
  }

  if (payload.defaultVoiceId !== undefined) {
    if (typeof payload.defaultVoiceId === "string") {
      updates.push(["default_voice_id", payload.defaultVoiceId.trim()]);
    } else {
      return jsonResponse({ error: { message: "defaultVoiceId must be a string" } }, { status: 400 });
    }
  }

  for (const [key, value] of updates) {
    await setSetting(env, key, value);
  }

  return jsonResponse({ ok: true, updated: updates.map(([key]) => key) });
}

async function handleElevenLabsTTS(request: Request, env: EnvBindings, ctx: ExecutionContext) {
  if (!env.ELEVENLABS_API_KEY) {
    return jsonResponse(
      { error: { message: "ELEVENLABS_API_KEY is not configured on the Worker." } },
      { status: 501 }
    );
  }

  let payload: { text?: string; voiceId?: string; modelId?: string };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const text = (payload.text || "").trim();
  if (!text) {
    return jsonResponse({ error: { message: "Text is required for TTS" } }, { status: 400 });
  }

  const safeText = text.slice(0, 1_200); // guardrails
  const defaultVoiceId = (await getSetting(env, "default_voice_id")) as string | null;
  const voiceId =
    payload.voiceId ||
    defaultVoiceId ||
    env.ELEVENLABS_DEFAULT_VOICE_ID ||
    DEFAULT_ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    return jsonResponse(
      { error: { message: "voiceId not provided. Set defaultVoiceId in settings or pass in body." } },
      { status: 400 }
    );
  }

  const modelId = payload.modelId || "eleven_multilingual_v2";
  const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

  const apiResponse = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "xi-api-key": env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: safeText,
      model_id: modelId,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    return jsonResponse(
      {
        error: {
          message: "ElevenLabs API request failed",
          status: apiResponse.status,
          detail,
        },
      },
      { status: apiResponse.status }
    );
  }

  ctx.waitUntil(logUsage(env, "elevenlabs", "tts"));
  return new Response(apiResponse.body, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
    },
  });
}

async function fetchFromX(ctx: FetchContext): Promise<ProviderResult> {
  const { env, mode, query, limit } = ctx;
  const token = env.X_BEARER_TOKEN;
  if (!token) {
    throw new ProviderFetchError("x", "X_BEARER_TOKEN not configured", 500);
  }

  const endpoint = new URL("https://api.twitter.com/2/tweets/search/recent");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("max_results", String(limit));
  endpoint.searchParams.set(
    "tweet.fields",
    "author_id,created_at,lang,public_metrics,conversation_id"
  );
  endpoint.searchParams.set("expansions", "author_id");
  endpoint.searchParams.set("user.fields", "name,username,profile_image_url,verified");

  const response = await fetch(endpoint.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new ProviderFetchError("x", "Rate limit reached", response.status, true);
    }
    const detail = await response.text();
    throw new ProviderFetchError("x", `X API error: ${detail}`, response.status);
  }

  const remaining = Number(response.headers.get("x-rate-limit-remaining") || "");
  const resetHeader = response.headers.get("x-rate-limit-reset");
  let cooldownUntil: string | undefined;
  if (!Number.isNaN(remaining) && remaining <= 1 && resetHeader) {
    const resetSeconds = Number(resetHeader);
    if (!Number.isNaN(resetSeconds)) {
      cooldownUntil = new Date(resetSeconds * 1000).toISOString();
    }
  }

  const payload = await response.json<{
    data?: any[];
    includes?: { users?: any[] };
  }>();

  const posts = normalizeXPosts(payload, limit);
  return { provider: "x", posts, cooldownUntil };
}

async function fetchFromSociaVault(ctx: FetchContext): Promise<ProviderResult> {
  const { env, query, limit } = ctx;
  const apiKey = env.SOCIAVAULT_API_KEY;
  if (!apiKey) {
    throw new ProviderFetchError("sociavault", "SOCIAVAULT_API_KEY not configured", 500);
  }

  const handle =
    extractHandleFromQuery(query) ||
    (env.SOCIAVAULT_DEFAULT_HANDLE ? env.SOCIAVAULT_DEFAULT_HANDLE.trim() : "");

  if (!handle) {
    throw new ProviderFetchError(
      "sociavault",
      "SociaVault fallback requires a from:@handle query or SOCIAVAULT_DEFAULT_HANDLE.",
      400
    );
  }

  const endpoint = new URL("https://api.sociavault.com/v1/scrape/twitter/user-tweets");
  endpoint.searchParams.set("handle", handle);
  endpoint.searchParams.set("trim", "false");

  const response = await fetch(endpoint.toString(), {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const detailText = await response.text();
    let detailMessage = detailText;
    try {
      const parsed = JSON.parse(detailText);
      if (parsed?.error) {
        detailMessage = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
      }
    } catch {
      // ignore
    }
    if (/insufficient credits/i.test(detailMessage)) {
      detailMessage = "SociaVault credits exhausted. Please top up the plan.";
    }
    throw new ProviderFetchError("sociavault", detailMessage, response.status);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const message = (payload as any)?.data?.message;
  if (message && !(payload as any)?.data?.tweets) {
    throw new ProviderFetchError("sociavault", `SociaVault API error: ${message}`, 502);
  }

  const posts = normalizeSociaVaultPosts(payload, limit);
  return { provider: "sociavault", posts };
}

function normalizeXPosts(payload: { data?: any[]; includes?: { users?: any[] } }, limit: number) {
  const users = new Map<string, any>();
  for (const user of payload.includes?.users || []) {
    users.set(String(user.id), user);
  }

  const posts: UnifiedPost[] = [];
  for (const tweet of payload.data || []) {
    const author = users.get(tweet.author_id);
    const username = author?.username || "unknown";
    posts.push({
      id: String(tweet.id),
      author: author?.name || username,
      handle: toHandle(username),
      avatarUrl: author?.profile_image_url,
      text: tweet.text || "",
      createdAt: tweet.created_at || new Date().toISOString(),
      permalink: `https://x.com/${username}/status/${tweet.id}`,
    });
  }
  return posts.slice(0, limit);
}

function normalizeSociaVaultPosts(payload: Record<string, unknown>, limit: number) {
  const data = (payload as any)?.data ?? payload;
  let tweets: any[] = [];
  if (Array.isArray(data?.tweets)) {
    tweets = data.tweets;
  } else if (data?.tweets && typeof data.tweets === "object") {
    tweets = Object.values(data.tweets);
  } else if (Array.isArray(data)) {
    tweets = data;
  }

  const posts: UnifiedPost[] = [];
  for (const tweet of tweets) {
    if (!tweet || typeof tweet !== "object") continue;
    const parsed = mapSociaVaultTweet(tweet as Record<string, any>);
    if (parsed) {
      posts.push(parsed);
    }
    if (posts.length >= limit) break;
  }
  return posts;
}

function mapSociaVaultTweet(tweet: Record<string, any>): UnifiedPost | null {
  const userResult = tweet?.core?.user_results?.result;
  const legacyUser = userResult?.legacy || tweet?.user;
  const username =
    legacyUser?.screen_name ||
    legacyUser?.username ||
    tweet?.legacy?.screen_name ||
    tweet?.author?.username ||
    "";
  const displayName =
    legacyUser?.name || tweet?.author?.name || username || tweet?.legacy?.user?.name || "unknown";
  const avatarUrl =
    legacyUser?.profile_image_url_https || legacyUser?.profile_image_url || tweet?.author?.avatar;

  const text =
    tweet?.legacy?.full_text ||
    tweet?.legacy?.text ||
    tweet?.note_tweet?.note_tweet_results?.result?.text ||
    tweet?.note_tweet?.text ||
    tweet?.text ||
    "";

  const createdAt = tweet?.legacy?.created_at
    ? new Date(tweet.legacy.created_at).toISOString()
    : new Date().toISOString();

  const id = String(tweet?.rest_id || tweet?.legacy?.id_str || tweet?.id || crypto.randomUUID());
  const permalink =
    username && id ? `https://x.com/${username}/status/${tweet?.rest_id || id}` : undefined;

  return {
    id,
    author: displayName || "unknown",
    handle: username ? toHandle(username) : "@unknown",
    avatarUrl,
    text,
    createdAt,
    permalink,
  };
}

async function getCachedFeed(env: EnvBindings, key: string) {
  const row = await env.DB.prepare(
    "SELECT response_json, fetched_at FROM feed_cache WHERE feed_key = ?"
  )
    .bind(key)
    .first<{
      response_json: string;
      fetched_at: string;
    }>();

  if (!row) return null;
  return {
    payload: JSON.parse(row.response_json) as FeedResponse,
    fetchedAt: new Date(row.fetched_at),
  };
}

async function persistFeedCache(
  env: EnvBindings,
  key: string,
  provider: ProviderName,
  payload: FeedResponse
) {
  await env.DB.prepare(
    `INSERT INTO feed_cache (feed_key, source, response_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(feed_key) DO UPDATE SET
       source=excluded.source,
       response_json=excluded.response_json,
       fetched_at=excluded.fetched_at`
  )
    .bind(key, provider, JSON.stringify(payload), new Date().toISOString())
    .run();
}

async function getProviderOrder(env: EnvBindings): Promise<ProviderName[]> {
  const blockedUntilRaw = (await getSetting(env, "x_blocked_until")) as string | null;
  const blockedUntil = blockedUntilRaw ? new Date(blockedUntilRaw) : null;
  const now = new Date();

  if (blockedUntil && blockedUntil > now) {
    return ["sociavault", "x"];
  }
  return ["x", "sociavault"];
}

async function setXBlockedUntil(env: EnvBindings, status?: number, explicitUntil?: string) {
  const now = Date.now();
  const cooldownMs =
    status === 429
      ? 15 * 60 * 1000
      : status === 503 || status === 500
      ? 5 * 60 * 1000
      : 60 * 1000;
  const until = explicitUntil || new Date(now + cooldownMs).toISOString();
  await setSetting(env, "x_blocked_until", until);
}

async function logUsage(env: EnvBindings, provider: ProviderName | "elevenlabs", endpoint: string) {
  try {
    await env.DB.prepare(
      "INSERT INTO api_usage (provider, endpoint, timestamp) VALUES (?, ?, ?)"
    )
      .bind(provider, endpoint, new Date().toISOString())
      .run();
  } catch (error) {
    console.error("logUsage error", error);
  }
}

async function getSetting(env: EnvBindings, key: string) {
  const result = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!result) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    return result.value;
  }
}

async function setSetting(env: EnvBindings, key: string, value: unknown) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function getDefaultMode(env: EnvBindings): Promise<FeedMode> {
  const stored = (await getSetting(env, "default_mode")) as FeedMode | null;
  if (stored === "search" || stored === "timeline") return stored;
  return "timeline";
}

async function getDefaultQuery(env: EnvBindings) {
  const stored = (await getSetting(env, "default_query")) as string | null;
  return stored ?? env.DEFAULT_FEED_QUERY ?? "";
}

function getAppVersion(env: EnvBindings) {
  return env.APP_VERSION || DEFAULT_APP_VERSION;
}

function createMeta(
  provider: ProviderName | "cache",
  mode: FeedMode,
  query: string,
  limit: number,
  env: EnvBindings
): FeedMeta {
  return {
    fetchedAt: new Date().toISOString(),
    provider,
    fromCache: provider === "cache",
    stale: false,
    mode,
    query,
    limit,
    version: getAppVersion(env),
  };
}

function jsonResponse<T>(payload: T, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function methodNotAllowed(methods: string[]) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: methods.join(", ") },
  });
}

function withCors(request: Request, response: Response) {
  const origin = request.headers.get("Origin");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    const existingVary = response.headers.get("Vary");
    response.headers.set("Vary", existingVary ? `${existingVary}, Origin` : "Origin");
  } else {
    response.headers.set("Access-Control-Allow-Origin", "*");
  }
  response.headers.set("Access-Control-Allow-Credentials", "false");
  return response;
}

function clampLimit(limit: number) {
  if (Number.isNaN(limit) || limit <= 0) return DEFAULT_FEED_LIMIT;
  return Math.min(100, Math.max(5, limit));
}

function toHandle(username: string) {
  return username.startsWith("@") ? username : `@${username}`;
}

function extractHandleFromQuery(query: string) {
  if (!query) return null;
  const fromMatch = query.match(/from:([A-Za-z0-9_]+)/i);
  if (fromMatch) return fromMatch[1];
  const atMatch = query.match(/@([A-Za-z0-9_]+)/);
  if (atMatch) return atMatch[1];
  return null;
}

function getRuntimeConfig(env: EnvBindings) {
  return {
    cacheIntervalMs: Number(env.CACHE_INTERVAL_MS) || DEFAULT_CACHE_INTERVAL_MS,
    fallbackCacheMs: Number(env.FALLBACK_CACHE_MS) || DEFAULT_FALLBACK_CACHE_MS,
  };
}
