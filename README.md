# AX Download

TikTok video, photo slideshow, and audio downloader built with Node.js + Express.

## Local

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. Import the repository in Vercel.
3. Framework Preset: **Other**.
4. Build Command: leave empty.
5. Output Directory: leave empty.
6. Deploy.

Vercel uses `api/index.js` as the serverless entry point. The existing Express app serves both the frontend and `/api/*` endpoints.

### Environment variables

If you want to override defaults, add these in Vercel Project Settings → Environment Variables:

- `RATE_LIMIT_MAX`
- `CACHE_TTL_SECONDS`
- `UPSTREAM_MIN_INTERVAL_MS`
- `TIKWM_API`

Do not upload `.env` or secrets to GitHub. Use `.env.example` only as a template.

## Endpoints

- `/api/health`
- `/api/info?url=<tiktok link>`
- `/api/download?url=<link>&type=video&quality=sd|hd|wm`
- `/api/download?url=<link>&type=audio`
- `/api/download?url=<link>&type=photo&index=0&quality=sd|hd`
- `/api/download?url=<link>&type=photos-zip&quality=sd|hd`
