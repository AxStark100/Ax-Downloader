'use strict';

const { HttpError, absoluteUrl, isSafeMediaUrl, sleep } = require('./utils');

const API_BASE = (process.env.TIKWM_API || 'https://www.tikwm.com').replace(/\/+$/, '');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 600) * 1000;
const CACHE_MAX = 500;
const MIN_INTERVAL_MS = Number(process.env.UPSTREAM_MIN_INTERVAL_MS || 1100);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map(); // tiktok url -> { expires, entry }
const inflight = new Map(); // tiktok url -> Promise<entry>

// The upstream service allows roughly one request per second on its free tier,
// so every upstream call waits for its slot here.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function requestUpstream(tiktokUrl) {
  const endpoint = `${API_BASE}/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  let lastMessage = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();

    let json;
    try {
      const res = await fetch(endpoint, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      json = await res.json();
    } catch {
      if (attempt === 2) {
        throw new HttpError(502, 'Could not reach the download service. Please try again in a moment.');
      }
      continue;
    }

    if (json && json.code === 0 && json.data) return json.data;

    lastMessage = String((json && json.msg) || '');
    if (/limit/i.test(lastMessage)) {
      if (attempt < 2) continue;
      throw new HttpError(429, 'The service is busy right now. Please try again in a few seconds.');
    }
    break;
  }

  throw new HttpError(404, 'Content not found. Make sure the link is correct and the post is public.');
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalize(data) {
  const author = data.author || {};
  const music = data.music_info || {};

  const play = absoluteUrl(API_BASE, data.play);
  const hdRaw = absoluteUrl(API_BASE, data.hdplay);
  const wmRaw = absoluteUrl(API_BASE, data.wmplay);
  const images = (Array.isArray(data.images) ? data.images : [])
    .map((u) => absoluteUrl(API_BASE, u))
    .filter((u) => u && isSafeMediaUrl(u));
  const audio = absoluteUrl(API_BASE, data.music || music.play);

  const media = {
    sd: play && isSafeMediaUrl(play) ? play : null,
    hd: hdRaw && hdRaw !== play && isSafeMediaUrl(hdRaw) ? hdRaw : null,
    wm: wmRaw && wmRaw !== play && isSafeMediaUrl(wmRaw) ? wmRaw : null,
    audio: audio && isSafeMediaUrl(audio) ? audio : null,
    images,
  };

  const isPhoto = images.length > 0;

  const publicInfo = {
    id: String(data.id || ''),
    kind: isPhoto ? 'photo' : 'video',
    title: data.title || '',
    createdAt: data.create_time ? new Date(Number(data.create_time) * 1000).toISOString() : null,
    duration: isPhoto ? null : toNumber(data.duration),
    region: data.region || null,
    author: {
      nickname: author.nickname || '',
      username: author.unique_id || '',
      avatar: absoluteUrl(API_BASE, author.avatar),
    },
    stats: {
      views: toNumber(data.play_count) || 0,
      likes: toNumber(data.digg_count) || 0,
      comments: toNumber(data.comment_count) || 0,
      shares: toNumber(data.share_count) || 0,
      saves: toNumber(data.collect_count) || 0,
      downloads: toNumber(data.download_count) || 0,
    },
    cover: absoluteUrl(API_BASE, data.origin_cover || data.cover),
    video: isPhoto
      ? null
      : {
          sizes: { sd: toNumber(data.size), hd: toNumber(data.hd_size), wm: toNumber(data.wm_size) },
          hasHd: Boolean(media.hd),
          hasWatermarked: Boolean(media.wm),
        },
    photos: isPhoto ? { count: images.length, items: images.map((thumb, i) => ({ index: i, thumb })) } : null,
    music: {
      title: music.title || '',
      author: music.author || '',
      duration: toNumber(music.duration),
      cover: absoluteUrl(API_BASE, music.cover),
      available: Boolean(media.audio),
    },
  };

  return { public: publicInfo, media };
}

function remember(key, entry) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, entry });
}

/**
 * Returns { public, media } for a TikTok URL. `public` is safe to send to the
 * browser; `media` holds the real file URLs and never leaves the server.
 */
async function fetchInfo(tiktokUrl) {
  const hit = cache.get(tiktokUrl);
  if (hit && hit.expires > Date.now()) return hit.entry;
  if (hit) cache.delete(tiktokUrl);

  if (inflight.has(tiktokUrl)) return inflight.get(tiktokUrl);

  const job = (async () => {
    const data = await requestUpstream(tiktokUrl);
    const entry = normalize(data);
    if (!entry.media.sd && entry.media.images.length === 0 && !entry.media.audio) {
      throw new HttpError(404, 'No downloadable media was found for this link.');
    }
    remember(tiktokUrl, entry);
    return entry;
  })();

  inflight.set(tiktokUrl, job);
  try {
    return await job;
  } finally {
    inflight.delete(tiktokUrl);
  }
}

module.exports = { fetchInfo, normalize, USER_AGENT };
