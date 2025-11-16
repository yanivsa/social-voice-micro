# Social Voice Micro Browser

Micro browser (single-user) for monitoring X/Twitter posts with speech synthesis on Android Chrome. The stack is a Cloudflare Worker + D1 database and a single-file frontend (`public/index.html`). The Worker proxies X API v2, falls back to SociaVault when rate-limited, and exposes an ElevenLabs-powered TTS endpoint.

## Features

- **Single HTML file** frontend (vanilla JS + inline CSS) optimized for RTL and mobile.
- **Cloudflare Worker API** with caching + throttling to protect X quota.
- **Cloudflare D1** schema for settings, feed cache, basic API usage telemetry.
- **Automatic provider fallback**: try X API first, then SociaVault.
- **Browser TTS + ElevenLabs** integration for Hebrew playback.
- Polling every 5s on the client, with server-side cache interval controls.
- Visible app version (`v0.1.4`) shared between Worker + UI.

## Project layout

```
.
├── public/
│   └── index.html          # Single-file UI
├── src/
│   └── worker.ts          # Cloudflare Worker (API + TTS proxy)
├── migrations/
│   └── 001_init.sql       # D1 schema
├── wrangler.toml          # Worker config/bindings
├── package.json           # Scripts for dev/deploy
└── README.md
```

## Configuration

### Environment bindings

Set these on your Worker via `wrangler secret put` or the Cloudflare dashboard:

- `X_BEARER_TOKEN` – X/Twitter API v2 bearer token (App-only).
- `SOCIAVAULT_API_KEY` – SociaVault API key for fallback scraping.
- `ELEVENLABS_API_KEY` – optional; required for the `/api/tts/elevenlabs` endpoint.

Plain (non-secret) vars are set inside `wrangler.toml`:

- `APP_VERSION` – keep in sync with `public/index.html` for visible version label.
- `CACHE_INTERVAL_MS` – min ms between provider fetches per feed key (default 15000).
- `FALLBACK_CACHE_MS` – stale cache window when both providers fail (default 120000).
- `DEFAULT_FEED_QUERY` – timeline query (e.g. `from:twitterdev OR #hebrew`).
- `DEFAULT_TTS_ENGINE` – `browser`, `elevenlabs`, or `none`.
- `SOCIAVAULT_DEFAULT_HANDLE` – optional; if set, SociaVault fallback will use this handle when no `from:handle` clause
  is present in the query.
- `ELEVENLABS_DEFAULT_VOICE_ID` – optional override for the ElevenLabs voice (defaults to their “Rachel” voice ID).

### D1 database

1. Create a D1 DB: `wrangler d1 create social_voice_db`.
2. Update `database_id` in `wrangler.toml` with the printed UUID.
3. Apply migrations locally (optional) and to prod:
   ```sh
   wrangler d1 migrations apply DB
   ```

### SociaVault endpoint note

SociaVault fallback now targets the `https://api.sociavault.com/v1/scrape/twitter/user-tweets` endpoint. Because this endpoint
requires a specific handle, the Worker tries to extract the first `from:handle` or `@handle` token from the query. If no handle is
found, it will use `SOCIAVAULT_DEFAULT_HANDLE` (when supplied) or skip the fallback entirely. Make sure your timeline/search
queries include `from:handle` when you want SociaVault to kick in (for example `from:ynetalerts lang:he`).

### ElevenLabs voice defaults

Store a preferred Hebrew voice ID in the settings table (key `default_voice_id`) via `/api/settings` or direct SQL, so the Worker can call ElevenLabs without passing `voiceId` from the client.

## Development workflow

```sh
# Install deps (Wrangler should already be installed globally)
npm install

# Start local dev server (binds Worker + static file via wrangler)
npm run dev

# Deploy to Cloudflare
npm run deploy
```

- The Worker currently returns a simple text message on `/`. Serve `public/index.html` with Cloudflare Pages or your preferred static hosting, pointing it to `/api/...` on the Worker domain (or add a static asset loader if you want the Worker to handle `/`).
- Update `APP_VERSION` in both `wrangler.toml` and `public/index.html` whenever the frontend changes, so the badge matches.

## API reference

- `GET /api/feed?mode=timeline|search&limit=20&q=query` – returns unified posts + meta.
- `GET /api/settings` – loads persisted defaults (mode/query/TTS) and current block status.
- `POST /api/settings` – update keys `{ defaultMode, defaultQuery, ttsEngine, defaultVoiceId }`.
- `POST /api/tts/elevenlabs` – proxy to ElevenLabs (body: `{ text, voiceId?, modelId? }`).
- `GET /api/meta` – simple heartbeat/version info.

## Hosting strategy

- **Frontend**: deploy `public/index.html` via Cloudflare Pages (one-file project) or embed it into a Worker static asset pipeline. Route `/api/*` to the Worker.
- **Worker**: handles data fetching, caching, and TTS proxying. Configure routes in `wrangler.toml` or Cloudflare dashboard.
- **Database**: D1 handles lightweight persistence (no heavy relational logic required).

## Next steps / TODOs

1. Finalize SociaVault endpoints & adjust `fetchFromSociaVault` if their response differs.
2. Set `default_query` and `default_voice_id` via `/api/settings` or SQL so the timeline + ElevenLabs behave out of the box.
3. Optionally add auth (basic token) if you expose the Worker publicly.
4. Wire the Worker to serve `index.html` directly if you prefer a single origin.

Enjoy your self-use Hebrew-friendly Social Voice browser!
