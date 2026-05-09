# CHANTER Auto Poster

Local Node.js + Express MVP for a personal TikTok photo content workflow. Upload a batch of images, edit captions and hashtags, schedule one post per day, and either publish through an approved TikTok Content Posting API setup or mark the next due item as ready for manual posting.

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
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=http://localhost:3010/auth/tiktok/callback
TIKTOK_SCOPES=user.info.basic,video.publish
TIKTOK_CONTENT_POST_INIT_URL=https://open.tiktokapis.com/v2/post/publish/content/init/
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
PUBLIC_BASE_URL=https://chanterr.com
```

`PUBLIC_BASE_URL` is only a fallback. For testing, paste a per-post `publicImageUrl` such as `https://chanterr.com/media/tiktok-posts/test-image.png` into the queue item.

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

## Manual Fallback

If TikTok API credentials or a public image URL are not configured, the scheduler still works locally:

1. Uploaded images are queued and auto-scheduled.
2. The scheduler checks every minute.
3. When a pending post is due, it is marked `ready`.
4. The dashboard shows `Open image` and `Copy caption` controls.
5. After posting manually in TikTok, click `Mark posted manually`.

## Data Storage

This MVP uses JSON files and local uploads:

```text
data/posts.json
data/settings.json
uploads/
```

There is no database yet. Back up `data/` and `uploads/` if you care about preserving the queue.

## Project Structure

```text
chanter-auto-poster/
  package.json
  .env.example
  README.md
  src/
    server.js
    config.js
    scheduler.js
    storage.js
    tiktok.js
    routes.js
    views/
      index.ejs
  data/
    posts.json
    settings.json
    tiktok_auth.json
  uploads/
```
