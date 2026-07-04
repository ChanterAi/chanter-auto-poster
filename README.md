# CHANTER Auto Poster

Local Node.js + Express MVP for a personal TikTok photo content workflow. Upload a batch of images, edit captions and hashtags, schedule one post per day, and either publish through an approved TikTok Content Posting API setup or mark the next due item as ready for manual posting. Instagram Graph API publishing is available as a separate test-first module.

This app does not scrape TikTok, bypass TikTok security, or automate unofficial account behavior.

## Install

```bash
npm install
```

If PowerShell blocks `npm.ps1`, use:

```powershell
npm.cmd install
```

## Run Locally

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

If port `3000` is already in use, set `PORT` before running:

```powershell
$env:PORT = "3001"
npm.cmd run dev
```

Health check:

```text
GET /health
```

## Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Optional variables:

```env
PORT=3010
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
OPENAI_API_KEY=
OPENAI_CAPTION_MODEL=gpt-5.5
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
QWEN_API_KEY=
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-vl-max
AUTO_CAPTION_REQUEST_TIMEOUT_MS=120000
AUTO_CAPTION_FFMPEG_TIMEOUT_MS=120000
AUTO_CAPTION_MAX_AUDIO_SECONDS=600
AUTO_MUSIC_BACKGROUND_VOLUME=0.20
AUTO_MUSIC_FADE_SECONDS=0.8
AUTO_MUSIC_RENDER_TIMEOUT_MS=600000
AUTO_MUSIC_TOKEN_TTL_MINUTES=30
AUTO_MUSIC_TOKEN_SECRET=

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=http://localhost:3010/auth/tiktok/callback
TIKTOK_SCOPES=user.info.basic,video.publish
TIKTOK_CONTENT_POST_INIT_URL=https://open.tiktokapis.com/v2/post/publish/content/init/
TIKTOK_PRIVACY_LEVEL=SELF_ONLY

META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=http://localhost:3010/auth/instagram/callback
META_GRAPH_VERSION=v24.0
INSTAGRAM_SCOPES=instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement
META_ACCESS_TOKEN=
INSTAGRAM_BUSINESS_ACCOUNT_ID=
FACEBOOK_PAGE_ID=
INSTAGRAM_TEST_MODE=true
INSTAGRAM_PUBLISH_ENABLED=false
INSTAGRAM_STATUS_POLL_ATTEMPTS=5
INSTAGRAM_STATUS_POLL_INTERVAL_MS=3000

PUBLIC_BASE_URL=https://chanterr.com
APP_URL=https://chanter-auto-poster.onrender.com
APP_TIME_ZONE=Asia/Nicosia
TZ=Asia/Nicosia
CRON_SECRET=use-the-same-long-random-value-on-web-and-cron
```

`PUBLIC_BASE_URL` is only a fallback. For testing, paste a per-post `publicImageUrl` such as `https://chanterr.com/media/tiktok-posts/test-image.png` into the queue item.

## Auto Caption Engine

Set at least one of `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `QWEN_API_KEY` on the web service to enable the upload form's Auto Caption toggle. `AI_PROVIDER=gemini` is the default. With the toggle on, selecting an uploaded video calls the protected `POST /api/auto-caption` preflight endpoint before the normal `/upload` form can create or schedule a job.

The backend uses packaged FFmpeg and FFprobe binaries to inspect the video, extract five chronological JPEG frames, and detect an audio stream. When audio and an OpenAI key exist, it creates a compact mono MP3 and sends it to the optional transcription model. Caption generation always receives the five frames, transcript when available, original filename, and video metadata.

Provider attempts start with `AI_PROVIDER`, then continue through configured Gemini, OpenAI, and Qwen adapters without repeating a provider. A quota or API failure automatically advances to the next configured provider. If every provider fails, the server returns deterministic local copy with 8-15 safe hashtags instead of failing the upload workflow. Existing manual caption and hashtag text is preserved as the first choice for this fallback.

Qwen uses its OpenAI-compatible multimodal chat endpoint. Set `QWEN_BASE_URL` to the compatible-mode `/v1` base for the region associated with the API key. Model names are configurable because provider availability varies by account and region.

The response fills the editable Caption and Hashtags fields. Turning Auto Caption off leaves the original manual workflow unchanged. If frame analysis or the AI request fails, existing manual text is preserved; a blank caption must be filled manually before scheduling.

Optional binary overrides are available for environments that manage FFmpeg separately:

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
FFPROBE_PATH=/absolute/path/to/ffprobe
```

Temporary analysis uploads, extracted frames, and extracted audio are deleted after each request. `GET /health` reports only provider/library readiness flags; API keys remain server-side and are never included in HTML or JSON responses.

## Auto Background Music Engine

Auto Music reuses the Auto Caption frame, transcript, filename, and metadata analysis to classify the video into one of five local categories. The server selects the highest-scoring entry from `music-library/musicCatalog.json`, then uses FFmpeg to render an MP4 before the normal `/upload` workflow creates or schedules the post.

Each catalog record contains `id`, `filename`, `category`, `mood`, `bpm`, `intensity`, and `tags`. Audio files live under:

```text
music-library/anime-epic/
music-library/cyberpunk-dark/
music-library/motivation-calm/
music-library/emotional-orchestral/
music-library/aggressive-trap/
```

The included demo MP3 files are original synthetic audio generated by `npm run music:generate-demo`. Replace them with music you have the right to embed and update the catalog filenames and metadata. Do not add third-party tracks without the required commercial and synchronization rights.

When source audio exists, it remains at full volume and background music is mixed at `AUTO_MUSIC_BACKGROUND_VOLUME`, clamped to 0.15-0.25. Silent videos receive the music at normal level. Both paths trim to the video duration and apply short fades. The browser receives only a short-lived signed prepared-media token; signing secrets and local paths are never exposed.

The rendered MP4 is uploaded to Cloudinary and becomes the durable media URL used by post-now and scheduled jobs. If selection, FFmpeg, token verification, or rendered upload fails, the server uploads the original video and continues. A preflight render staged across a service restart or another web instance also degrades to the original upload rather than blocking posting.

## TikTok Setup

1. Create a TikTok Developer app.
2. Enable Login Kit.
3. Enable the Content Posting API.
4. Register this redirect URI:

```text
http://localhost:3010/auth/tiktok/callback
```

5. Request the `video.publish` scope.
6. Add the app credentials to `.env`, then click `Connect TikTok` in the dashboard.

Photo posting uses TikTok's official Content Posting API endpoint:

```text
POST https://open.tiktokapis.com/v2/post/publish/content/init/
```

The image URL sent to TikTok must be HTTPS and publicly accessible. Localhost callback URLs are okay for OAuth testing, but localhost image URLs are not okay for TikTok posting.

## Instagram Setup

Instagram support is parallel to TikTok. The existing scheduler still publishes through TikTok only; Instagram is triggered through the dedicated dashboard test button or API endpoint.

1. Create a Meta app and add Facebook Login/Instagram Graph API access.
2. Add a Facebook Page connected to an Instagram professional account.
3. Register this redirect URI:

```text
http://localhost:3010/auth/instagram/callback
```

4. Add the Meta app credentials to `.env`.
5. Keep `INSTAGRAM_TEST_MODE=true` and `INSTAGRAM_PUBLISH_ENABLED=false` while developing.
6. Click `Connect Instagram` in the dashboard, then use `Test Instagram` on a queued item.

Instagram publishing uses the official content publishing flow:

```text
POST /{ig-user-id}/media
GET /{container-id}?fields=id,status,status_code
POST /{ig-user-id}/media_publish
```

In test mode, CHANTER creates the media container and records/logs the API response, but skips `media_publish` so nothing is posted publicly. To allow public publishing later, set both:

```env
INSTAGRAM_TEST_MODE=false
INSTAGRAM_PUBLISH_ENABLED=true
```

Images, videos, and reels must be reachable through a public HTTPS URL. For videos/reels, add an `Instagram media URL` on the queue item or configure `PUBLIC_BASE_URL` so uploaded media resolves to a public URL.

Useful local endpoints:

```text
GET  /auth/instagram/start
GET  /auth/instagram/callback
GET  /api/instagram/status
GET  /api/instagram/status?containerId=...
POST /api/instagram/publish
```

`POST /api/instagram/publish` accepts JSON or form data:

```json
{
  "postId": "local-post-id",
  "mediaUrl": "https://example.com/image.jpg",
  "publishType": "photo",
  "caption": "Caption",
  "dryRun": true
}
```

Use `publishType` values `photo`, `reel`, or `story`. Every Instagram OAuth, discovery, media-container, status, and publish step is logged to the server console with access tokens redacted for Meta App Review screencasts.

## Manual Fallback

If TikTok API credentials or a public image URL are not configured, the scheduler still works locally:

1. Uploaded images are queued and auto-scheduled.
2. The scheduler checks every minute.
3. When a pending post is due, it is marked `ready`.
4. The dashboard shows `Open image` and `Copy caption` controls.
5. After posting manually in TikTok, click `Mark posted manually`.

## Render Scheduling

`render.yaml` defines a web service and a Render Cron Job that calls `/api/cron/tick` every minute. Set `APP_URL` on the cron service to the Render web-service URL. Both services must use the same `CRON_SECRET`; the Blueprint environment group handles this when deployed from `render.yaml`.

Each completed cron tick also writes a token-free heartbeat to the dedicated
`config/schedulerHeartbeat` Firestore document. The write contains only the
completion time, success state, and aggregate checked/due/posted/failed counts;
it does not call a social provider or store provider responses, job details,
tokens, or secrets. `/health` exposes this under
`schedulerHealth.durableHeartbeat` and marks missing, failed, unavailable, or
older-than-five-minute heartbeats as degraded while preserving the existing
HTTP status contract.

There is no in-process timer. Firestore is the source of truth, so a sleeping or restarted web service recovers overdue `scheduled` jobs on the next external tick. Each job is atomically changed to `processing` before TikTok publishing, then to `posted` or `failed`.

Deploy the required Firestore indexes before enabling the cron job:

```bash
firebase deploy --only firestore:indexes
```

To run and inspect one tick manually:

```bash
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/cron/tick"
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/debug/jobs"
```

The tick response reports `now`, `checked`, `due`, `posted`, `failed`, and `errors`. Render logs include `[CRON_TICK]`, `[CRON_QUERY]`, `[JOB_FOUND]`, `[JOB_DUE]`, `[POST_START]`, and either `[POST_SUCCESS]` or `[POST_FAILED]`.

## Data Storage

Queue state, settings, and OAuth tokens remain in Firestore. New image and video uploads are sent from the Node.js backend to Cloudinary with `resource_type: "auto"`; Firestore stores the returned `secure_url` as `mediaUrl`. The local `uploads/` directory is temporary staging only, so Render restarts do not remove scheduled media.

Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the Render web service. The API secret is server-only and must never use a `VITE_` prefix or be added to frontend code.

After deployment, verify Cloudinary connectivity and an optional upload/read/delete cycle using the existing `CRON_SECRET`:

```bash
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/storage/health?write=1"
```

The Add Media form also accepts an HTTPS Public Media URL without a file. When one file and a public URL are submitted together, the URL is used automatically if Cloudinary exhausts its upload retries.

Posts uploaded before this storage change may still reference Render-local `/uploads/...` paths. Re-upload those pending items after deployment if their media is no longer present.

## Campaign Mode v0.1 manual smoke

Campaign Mode is TikTok-only and uses the existing Firestore scheduler. Instagram configuration is not required.

1. Connect two TikTok accounts and confirm both appear as connected on `/private/autoposter`.
2. In Campaign Mode, choose one MP4, MOV, or WebM video.
3. Select two different accounts, enter a different caption and hashtag set for each, and choose a future base time.
4. Confirm the preview shows exactly two jobs, with account 2 scheduled 15 minutes after account 1.
5. Create the campaign and confirm Campaign history groups both child jobs under one campaign ID.
6. Inspect `/api/debug/jobs` or Firestore and confirm both children share `campaignId` and one media reference, use different account/copy fields, and have distinct `scheduledAt` minutes.
7. Let the cron tick run. Confirm each child transitions independently and a failed child keeps its error evidence without changing the sibling's queued or posted state.

Expected guards: more than two accounts, duplicate account selection, matching captions, matching hashtag sets, expired/disconnected tokens, past times, and occupied schedule minutes are rejected before campaign jobs are committed.

## Project Structure

```text
chanter-auto-poster/
  package.json
  .env.example
  README.md
  src/
    server.js
    config.js
    cloudinary.js
    scheduler.js
    storage.js
    tiktok.js
    routes.js
    views/
      index.ejs
  render.yaml
  firestore.indexes.json
  uploads/             # temporary staging only
```
