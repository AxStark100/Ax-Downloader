'use strict';

require('dotenv').config();

const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');

const { fetchInfo, USER_AGENT } = require('./src/tiktok');
const {
  HttpError,
  parseTikTokUrl,
  isSafeMediaUrl,
  safeFilename,
  contentDisposition,
  mapLimit,
} = require('./src/utils');

// sharp is optional: it is only used to produce "Standard" quality photos.
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[ax-download] "sharp" is not installed - Standard photos will be served at original size.');
}

const PORT = Number(process.env.PORT || 3000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 40);
const STANDARD_PHOTO_WIDTH = 720;

const app = express();
app.disable('x-powered-by');

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy);
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(compression());

// ---------- helpers ----------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function linkFromQuery(req) {
  const link = parseTikTokUrl(req.query.url);
  if (!link) throw new HttpError(400, 'Please enter a valid TikTok link.');
  return link;
}

async function fetchRemote(url, clientSignal) {
  if (!isSafeMediaUrl(url)) throw new HttpError(502, 'Blocked media URL.');

  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  clientSignal.addEventListener('abort', onClientAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20000); // connect/headers timeout only

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, referer: 'https://www.tiktok.com/' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      throw new HttpError(502, 'The media file could not be retrieved. Please try again.');
    }
    return response;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'The media file could not be retrieved. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function streamRemote(res, url, filename, fallbackType, signal) {
  const upstream = await fetchRemote(url, signal);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || fallbackType);
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Cache-Control', 'no-store');
  await pipeline(Readable.fromWeb(upstream.body), res);
}

async function loadPhoto(url, quality, signal) {
  const upstream = await fetchRemote(url, signal);
  const buffer = Buffer.from(await upstream.arrayBuffer());
  const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();

  if (quality === 'sd' && sharp) {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: STANDARD_PHOTO_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { buffer: out, ext: 'jpg', type: 'image/jpeg' };
  }

  const ext = type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : type.includes('heic') ? 'heic' : 'jpg';
  return { buffer, ext, type: type || 'image/jpeg' };
}

function baseName(info) {
  const who = safeFilename(info.author.username, 'tiktok');
  return `axdownload-${who}-${safeFilename(info.id, 'content')}`;
}

// ---------- API ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, photoResize: Boolean(sharp) });
});

app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute and try again.' },
  })
);

app.get(
  '/api/info',
  wrap(async (req, res) => {
    const entry = await fetchInfo(linkFromQuery(req));
    res.set('Cache-Control', 'no-store');
    res.json(entry.public);
  })
);

app.get(
  '/api/download',
  wrap(async (req, res) => {
    const link = linkFromQuery(req);
    const type = String(req.query.type || '');
    const quality = String(req.query.quality || 'sd');
    const entry = await fetchInfo(link);
    const { media, public: info } = entry;
    const base = baseName(info);

    // Abort upstream work when the visitor closes the connection early.
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });

    switch (type) {
      case 'video': {
        const url = quality === 'hd' ? media.hd : quality === 'wm' ? media.wm : media.sd;
        if (!url) throw new HttpError(400, 'This quality is not available for this video.');
        const suffix = quality === 'hd' ? '-hd' : quality === 'wm' ? '-watermark' : '-sd';
        return streamRemote(res, url, `${base}${suffix}.mp4`, 'video/mp4', aborter.signal);
      }

      case 'audio': {
        if (!media.audio) throw new HttpError(404, 'No audio is available for this post.');
        return streamRemote(res, media.audio, `${base}.mp3`, 'audio/mpeg', aborter.signal);
      }

      case 'photo': {
        const index = Number.parseInt(String(req.query.index), 10);
        if (!Number.isInteger(index) || index < 0 || index >= media.images.length) {
          throw new HttpError(400, 'Photo not found.');
        }
        const q = quality === 'hd' ? 'hd' : 'sd';
        const photo = await loadPhoto(media.images[index], q, aborter.signal);
        res.setHeader('Content-Type', photo.type);
        res.setHeader('Content-Length', photo.buffer.length);
        res.setHeader('Content-Disposition', contentDisposition(`${base}-${index + 1}-${q}.${photo.ext}`));
        res.setHeader('Cache-Control', 'no-store');
        return res.end(photo.buffer);
      }

      case 'photos-zip': {
        if (!media.images.length) throw new HttpError(400, 'This post has no photos.');
        const q = quality === 'hd' ? 'hd' : 'sd';

        // Load everything first so any error can still be reported as JSON.
        const photos = await mapLimit(media.images, 4, (url) => loadPhoto(url, q, aborter.signal));

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDisposition(`${base}-photos-${q}.zip`));
        res.setHeader('Cache-Control', 'no-store');

        const archive = archiver('zip', { zlib: { level: 1 } });
        res.on('close', () => archive.abort());
        const done = pipeline(archive, res);
        photos.forEach((photo, i) => {
          const n = String(i + 1).padStart(2, '0');
          archive.append(photo.buffer, { name: `${base}-${n}.${photo.ext}` });
        });
        await archive.finalize();
        return done;
      }

      default:
        throw new HttpError(400, 'Unknown download type.');
    }
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---------- static frontend ----------

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));

// ---------- errors ----------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return; // visitor cancelled
  if (res.headersSent) return res.destroy();

  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error('[ax-download]', err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
});

// ---------- start ----------

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Ax Download is running on http://localhost:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
