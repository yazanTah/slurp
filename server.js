const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const axios = require('axios');
const archiver = require('archiver');
const btch = require('btch-downloader');
const getFBInfo = require('@renpwn/fb-downloader');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

// --- bgutil POT (Proof-of-Origin) token server for yt-dlp ---
// YouTube bot-blocks datacenter IPs (e.g. Render) unless requests carry PO tokens.
// We spawn the vendored bgutil server locally and point yt-dlp's plugin at it.
const POT_SERVER_DIR = path.join(__dirname, 'vendor', 'bgutil-pot-server');
const POT_PLUGIN_DIR = path.join(__dirname, 'vendor', 'ytdlp-plugins');
const POT_PORT = parseInt(process.env.POT_PORT, 10) || 4416;
let potRestarts = 0;

function startPotServer() {
  if (!fs.existsSync(path.join(POT_SERVER_DIR, 'build', 'main.js'))) return;
  try {
    const child = spawn(process.execPath, ['build/main.js', '-p', String(POT_PORT)], {
      cwd: POT_SERVER_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const prefix = '[pot-server]';
    child.stdout.on('data', d => console.log(prefix, d.toString().trim()));
    child.stderr.on('data', d => console.error(prefix, d.toString().trim()));
    child.on('exit', (code) => {
      console.warn(`${prefix} exited with code ${code}`);
      // Crash-loop guard: up to 10 restarts, then give up (YouTube degrades to CDN fallbacks)
      if (potRestarts++ < 10) setTimeout(startPotServer, 5000);
    });
  } catch (e) {
    console.warn('Failed to spawn POT server:', e.message);
  }
}

let potReadyPromise = null;
function ensurePotReady() {
  if (!potReadyPromise) {
    potReadyPromise = (async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          const r = await axios.get(`http://127.0.0.1:${POT_PORT}/ping`, { timeout: 2000 });
          if (r.status === 200) return true;
        } catch (e) {}
        await new Promise(res => setTimeout(res, 1000));
      }
      console.warn('POT server not ready after 30s; continuing without PO tokens');
      return false;
    })();
  }
  return potReadyPromise;
}

// Shared yt-dlp flags: plugin dir, node as JS runtime, PO token provider endpoints
function ytdlpPotFlags() {
  return {
    pluginDirs: [POT_PLUGIN_DIR],
    jsRuntimes: 'node',
    noCheckCertificates: true,
    noWarnings: true,
    extractorArgs: [
      `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${POT_PORT}`,
      `youtubepot-bgutilscript:server_home=${POT_SERVER_DIR}`
    ]
  };
}

startPotServer();

// High-performance Keep-Alive Connection Pool for Massive Parallelism
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 50 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 50 });
const fastAxios = axios.create({ httpsAgent, httpAgent, timeout: 15000 });

// Security & Header Policy Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

// Ensure relative media URLs have full domain prefix
function formatMediaUrl(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
  if (rawPath.startsWith('/api/')) return null; // internal proxy route, not a fetchable CDN path
  return `https://www.tikwm.com${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
}

// Safe descriptive filename for HTTP Content-Disposition headers
function sanitizeFilename(name, fallback = 'slurp_media') {
  if (!name) return fallback;
  const clean = name
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/[^\x20-\x7E]/g, '') // ASCII only
    .replace(/[<>:"/\\|?*#%&=;+`~[\]$@!]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

// Platform detector
function detectPlatform(url) {
  if (!url || typeof url !== 'string') return 'unknown';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch|fb\.me/i.test(url)) return 'facebook';
  if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
  return 'unknown';
}

// Clean and normalize media URLs from any browser address bar, share sheet, or text copy
function cleanMediaUrl(input) {
  if (!input) return null;
  const match = input.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  let url = match[0].replace(/[)>,;:.!?'\"\]}]+$/, '');

  // 1. Twitter / X: normalize all variations (status, web, modal, mobile, query params) to canonical post URL
  const twMatch = url.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?(?:[^\/\s]+\/status\/|status\/|i\/status\/|i\/web\/status\/)(\d+)/i);
  if (twMatch && twMatch[1]) {
    return `https://x.com/i/status/${twMatch[1]}`;
  }

  // 2. Facebook: strip tracking params (mibextid, rdid, ref, sfnsn) and normalize watch/reels
  try {
    const u = new URL(url);
    if (u.hostname.includes('facebook.com') || u.hostname.includes('fb.watch') || u.hostname.includes('fb.me')) {
      const v = u.searchParams.get('v');
      u.search = v ? `?v=${v}` : '';
      return u.toString().replace(/\/+$/, '');
    }
  } catch (e) {}

  // 3. Instagram: clean tracking params while preserving post/reel ID
  const igMatch = url.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (igMatch && igMatch[1]) {
    const type = url.includes('/reel') ? 'reel' : 'p';
    return `https://www.instagram.com/${type}/${igMatch[1]}/`;
  }

  // 4. YouTube: normalize all Shorts, Watch, Mobile, and Share links
  const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/|v\/|live\/))([A-Za-z0-9_-]{11})/i);
  if (ytMatch && ytMatch[1]) {
    const ytId = ytMatch[1];
    if (url.includes('/shorts/')) {
      return `https://www.youtube.com/shorts/${ytId}`;
    }
    return `https://www.youtube.com/watch?v=${ytId}`;
  }

  return url;
}

// High-performance In-Memory Media Cache with 15-Minute TTL
const RESOLVE_CACHE = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function getCachedMedia(key) {
  const item = RESOLVE_CACHE.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    RESOLVE_CACHE.delete(key);
    return null;
  }
  return item.data;
}

function setCachedMedia(key, data, customTtl = CACHE_TTL_MS) {
  // Prevent unbounded memory growth (max 1000 entries)
  if (RESOLVE_CACHE.size > 1000) {
    const oldestKey = RESOLVE_CACHE.keys().next().value;
    if (oldestKey) RESOLVE_CACHE.delete(oldestKey);
  }
  RESOLVE_CACHE.set(key, { data, expiry: Date.now() + customTtl });
}

// --- FAST RESOLVERS ---

// 1. TikTok Fast Resolver
async function resolveTikTok(targetUrl) {
  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  const endpointA = fastAxios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: targetUrl }).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }
  }).then(r => r.data);

  const endpointB = fastAxios.post('https://tikwm.com/api/', new URLSearchParams({ url: targetUrl }).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
    }
  }).then(r => r.data);

  try {
    const data = await Promise.any([
      endpointA.then(d => { if (d && d.code === 0 && d.data) return d; throw new Error('A failed'); }),
      endpointB.then(d => { if (d && d.code === 0 && d.data) return d; throw new Error('B failed'); })
    ]);

    if (data && data.data) {
      const d = data.data;
      const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
      const mediaId = String(d.id || Date.now());

      const result = {
        success: true,
        platform: 'tiktok',
        id: mediaId,
        title: d.title || 'TikTok Media',
        author: {
          name: d.author?.nickname || 'TikTok Creator',
          username: d.author?.unique_id || 'user',
          avatar: formatMediaUrl(d.author?.avatar) || '',
        },
        cover: formatMediaUrl(d.cover || d.origin_cover),
        duration: d.duration || 0,
        music: formatMediaUrl(d.music || d.music_info?.play),
        musicTitle: d.music_info?.title || 'Soundtrack',
        type: isSlideshow ? 'slideshow' : 'video',
        videoUrl: formatMediaUrl(isSlideshow ? null : (d.play || d.hdplay || d.wmplay)),
        images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
      };
      setCachedMedia(targetUrl, result);
      return result;
    }
  } catch (err) {
    const getRes = await fastAxios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (getRes.data && getRes.data.code === 0 && getRes.data.data) {
      const d = getRes.data.data;
      const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
      const result = {
        success: true,
        platform: 'tiktok',
        id: String(d.id || Date.now()),
        title: d.title || 'TikTok Media',
        type: isSlideshow ? 'slideshow' : 'video',
        videoUrl: formatMediaUrl(d.play || d.hdplay),
        images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
        music: formatMediaUrl(d.music)
      };
      setCachedMedia(targetUrl, result);
      return result;
    }
  }
  throw new Error('Could not resolve TikTok media.');
}

// 2. Instagram Fast Resolver (Reels & Carousels)
async function resolveInstagram(targetUrl) {
  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  try {
    const igData = await btch.igdl(targetUrl);
    if (igData && igData.status && Array.isArray(igData.result) && igData.result.length > 0) {
      const validItems = igData.result.filter(item => item.url);
      if (validItems.length > 1) {
        const result = {
          success: true,
          platform: 'instagram',
          id: String(Date.now()),
          title: 'Instagram Carousel',
          type: 'slideshow',
          images: validItems.map(item => item.url),
          cover: validItems[0].url
        };
        setCachedMedia(targetUrl, result);
        return result;
      } else if (validItems.length === 1) {
        const item = validItems[0];
        const isVideo = item.url.includes('.mp4') || (item.thumbnail && item.thumbnail.length > 0);
        const result = {
          success: true,
          platform: 'instagram',
          id: String(Date.now()),
          title: 'Instagram Media',
          type: isVideo ? 'video' : 'slideshow',
          videoUrl: isVideo ? item.url : null,
          images: isVideo ? [] : [item.url],
          cover: item.thumbnail || item.url
        };
        setCachedMedia(targetUrl, result);
        return result;
      }
    }
  } catch (e) {}

  throw new Error('Unable to extract Instagram link. Make sure the post is public.');
}

// 3. YouTube & Shorts Resolver (High-Speed & Reliable Multi-Tier Engine)
async function resolveYouTube(targetUrl) {
  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  const ytMatch = targetUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/|v\/|live\/))([A-Za-z0-9_-]{11})/i);
  const ytId = ytMatch ? ytMatch[1] : null;
  const canonicalUrl = ytId
    ? (targetUrl.includes('/shorts/') ? `https://www.youtube.com/shorts/${ytId}` : `https://www.youtube.com/watch?v=${ytId}`)
    : targetUrl;

  // Engine 1: youtubedl (Ultra-reliable metadata extractor)
  try {
    await ensurePotReady();
    const info = await youtubedl(canonicalUrl, {
      dumpSingleJson: true,
      ...ytdlpPotFlags()
    });

    if (info && info.title) {
      const result = {
        success: true,
        platform: 'youtube',
        id: ytId || info.id || String(Date.now()),
        title: info.title || 'YouTube Video',
        author: {
          name: info.uploader || info.channel || 'YouTube Channel',
          username: info.uploader_id || info.uploader || 'creator',
          avatar: info.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '')
        },
        cover: info.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : ''),
        duration: info.duration || 0,
        type: 'video',
        videoUrl: `/api/stream/video?originUrl=${encodeURIComponent(canonicalUrl)}&platform=youtube`,
        audioUrl: `/api/stream/video?originUrl=${encodeURIComponent(canonicalUrl)}&platform=youtube&format=audio`,
        images: []
      };
      const YT_CACHE_TTL_MS = 5 * 60 * 1000;
      setCachedMedia(targetUrl, result, YT_CACHE_TTL_MS);
      if (canonicalUrl !== targetUrl) setCachedMedia(canonicalUrl, result, YT_CACHE_TTL_MS);
      return result;
    }
  } catch (err) {
    console.warn('YouTube Engine 1 (youtubedl) failed, falling back:', err.message);
  }

  // Engine 2: btch.youtube Fallback
  try {
    const yt = await btch.youtube(canonicalUrl);
    if (yt && yt.status && (yt.mp4 || yt.mp3)) {
      const result = {
        success: true,
        platform: 'youtube',
        id: ytId || String(Date.now()),
        title: yt.title || 'YouTube Video',
        author: {
          name: yt.author || 'YouTube Channel',
          username: yt.author || 'creator',
          avatar: yt.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '')
        },
        cover: yt.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : ''),
        type: 'video',
        videoUrl: `/api/stream/video?originUrl=${encodeURIComponent(canonicalUrl)}&platform=youtube`,
        audioUrl: yt.mp3 || '',
        images: []
      };
      setCachedMedia(targetUrl, result, 2 * 60 * 1000);
      if (canonicalUrl !== targetUrl) setCachedMedia(canonicalUrl, result, 2 * 60 * 1000);
      return result;
    }
  } catch (e) {}

  throw new Error('Unable to extract YouTube video. Make sure the video is public.');
}

// 4. Facebook Reels & Watch High-Speed Resolver (Dual-Engine Parallel Race)
async function resolveFacebook(targetUrl) {
  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  // Extract video ID or slug from target URL
  let fbId = '';
  try {
    const u = new URL(targetUrl);
    const v = u.searchParams.get('v');
    if (v) fbId = v;
    else {
      const match = u.pathname.match(/(?:reel|videos|status|p|shorts|v)\/([A-Za-z0-9_-]+)/i);
      if (match) fbId = match[1];
    }
  } catch (e) {}

  function cleanFbTitle(rawTitle) {
    if (rawTitle && typeof rawTitle === 'string' && !/^(facebook|facebook video|watch|reel|log in|log into facebook)$/i.test(rawTitle.trim())) {
      const clean = rawTitle.replace(/ \| Facebook$/i, '').replace(/https?:\/\/[^\s]+/g, '').replace(/[\r\n\t]+/g, ' ').trim();
      if (clean.length >= 3) return clean.slice(0, 80);
    }
    const type = targetUrl.includes('reel') ? 'Reel' : 'Video';
    return fbId ? `Facebook_${type}_${fbId}` : `Facebook_${type}`;
  }

  // Engine A: Direct HTML/GraphQL Scraper via @renpwn/fb-downloader (~300ms)
  const engineA = (async () => {
    try {
      const fb = await getFBInfo(targetUrl);
      if (fb && (fb.hd || fb.sd)) {
        return {
          success: true,
          platform: 'facebook',
          id: fbId || String(Date.now()),
          title: cleanFbTitle(fb.title),
          cover: fb.thumbnail || '',
          type: 'video',
          videoUrl: fb.hd || fb.sd,
          images: []
        };
      }
    } catch (e) {}
    throw new Error('Engine A failed');
  })();

  // Engine B: BTCH fbdown resolver
  const engineB = (async () => {
    try {
      const fbPromise = btch.fbdown(targetUrl);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000));
      const fb = await Promise.race([fbPromise, timeoutPromise]);
      if (fb && fb.status && (fb.HD || fb.Normal_video)) {
        return {
          success: true,
          platform: 'facebook',
          id: fbId || String(Date.now()),
          title: cleanFbTitle(fb.title),
          type: 'video',
          videoUrl: fb.HD || fb.Normal_video,
          images: []
        };
      }
    } catch (e) {}
    throw new Error('Engine B failed');
  })();

  try {
    const result = await Promise.any([engineA, engineB]);
    setCachedMedia(targetUrl, result);
    return result;
  } catch (e) {}

  throw new Error('Unable to extract Facebook video. Make sure post is public and not private/restricted.');
}

// 5. Twitter / X Fast Resolver
async function resolveTwitter(targetUrl) {
  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  let twId = '';
  try {
    const match = targetUrl.match(/status\/(\d+)/i);
    if (match) twId = match[1];
  } catch (e) {}

  function cleanTwTitle(rawTitle) {
    if (rawTitle && typeof rawTitle === 'string' && !/^(x video|twitter video|tweet)$/i.test(rawTitle.trim())) {
      const clean = rawTitle.replace(/https?:\/\/[^\s]+/g, '').replace(/[\r\n\t]+/g, ' ').trim();
      if (clean.length >= 3) return clean.slice(0, 80);
    }
    return twId ? `X_Post_${twId}` : 'X_Video';
  }

  try {
    const twPromise = btch.twitter(targetUrl);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000));
    const tw = await Promise.race([twPromise, timeoutPromise]);

    if (tw && tw.status) {
      let video = null;
      if (Array.isArray(tw.url) && tw.url.length > 0) {
        const valid = tw.url.find(u => {
          if (!u) return false;
          if (typeof u === 'string' && u.startsWith('http')) return true;
          return u.hd || u.sd || u.url;
        });
        if (valid) {
          video = typeof valid === 'string' ? valid : (valid.hd || valid.sd || valid.url);
        }
      } else if (typeof tw.url === 'string' && tw.url.startsWith('http')) {
        video = tw.url;
      } else if (tw.HD || tw.Normal_video || tw.video) {
        video = tw.HD || tw.Normal_video || tw.video;
      }

      if (video) {
        const result = {
          success: true,
          platform: 'twitter',
          id: twId || String(Date.now()),
          title: cleanTwTitle(tw.title),
          type: 'video',
          videoUrl: video,
          images: []
        };
        setCachedMedia(targetUrl, result);
        return result;
      }
    }
  } catch (e) {}

  throw new Error('Unable to extract X / Twitter video. Please ensure the post is public and has a video.');
}

// Universal Resolver Router
async function resolveUniversalMedia(rawInput) {
  const targetUrl = cleanMediaUrl(rawInput);
  if (!targetUrl) {
    throw new Error('Please enter a valid link (TikTok, Instagram, YouTube, Facebook, or X).');
  }

  const cached = getCachedMedia(targetUrl);
  if (cached) return cached;

  const platform = detectPlatform(targetUrl);
  let result = null;

  switch (platform) {
    case 'tiktok':
      result = await resolveTikTok(targetUrl);
      break;
    case 'instagram':
      result = await resolveInstagram(targetUrl);
      break;
    case 'youtube':
      result = await resolveYouTube(targetUrl);
      break;
    case 'facebook':
      result = await resolveFacebook(targetUrl);
      break;
    case 'twitter':
      result = await resolveTwitter(targetUrl);
      break;
    default:
      try { result = await resolveTikTok(targetUrl); } catch (e) {}
      if (!result) { try { result = await resolveYouTube(targetUrl); } catch (e) {} }
      if (!result) { try { result = await resolveFacebook(targetUrl); } catch (e) {} }
      if (!result) {
        throw new Error('Unsupported platform. Supported: TikTok, Instagram, YouTube, Facebook, and X.');
      }
  }

  if (result) {
    setCachedMedia(targetUrl, result);
  }
  return result;
}

// Ultra-fast Store-Mode In-Memory ZIP Archiver (Zero-CPU compression for instant 10ms packaging)
async function streamZipArchive(res, images, title, musicUrl) {
  const safeZipName = `${sanitizeFilename(title, 'slurp_slideshow')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);

  const archive = archiver('zip', { store: true });

  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).send({ error: err.message });
  });

  archive.pipe(res);

  const fetchPromises = images.map(async (imgUrl, index) => {
    try {
      const padNum = String(index + 1).padStart(2, '0');
      const ext = imgUrl.includes('.png') ? 'png' : (imgUrl.includes('.webp') ? 'webp' : 'jpg');
      const formatted = formatMediaUrl(imgUrl);
      const imgRes = await fastAxios.get(formatted, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 12000
      });
      archive.append(Buffer.from(imgRes.data), { name: `slide_${padNum}.${ext}` });
    } catch (e) {
      console.warn(`Failed slide ${index + 1}:`, e.message);
    }
  });

  let musicPromise = Promise.resolve();
  if (musicUrl) {
    const formattedMusic = formatMediaUrl(musicUrl);
    musicPromise = fastAxios.get(formattedMusic, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 12000
    }).then((audioRes) => {
      archive.append(Buffer.from(audioRes.data), { name: 'soundtrack.mp3' });
    }).catch(() => {});
  }

  try {
    await Promise.all([...fetchPromises, musicPromise]);
    archive.append(`SLURP Multi-Platform Archive\nTitle: ${title || 'Media Slideshow'}\nSlides: ${images.length}\n`, { name: 'info.txt' });
    await archive.finalize();
  } catch (err) {
    archive.abort();
  }
}

// Direct Instant Video Streamer with Range, Hotlink-Bypass & Auto-Refresh Support
app.get('/api/stream/video', async (req, res) => {
  const { url, title, inline, platform, originUrl, format } = req.query;
  if (!url && !originUrl) {
    return res.status(400).send('Missing video URL.');
  }

  const isAudio = format === 'audio' || format === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const asciiTitle = sanitizeFilename(title, 'slurp_video');
  const safeFilename = `${asciiTitle}.${ext}`;
  const cleanTitle = (title && typeof title === 'string') ? title.replace(/[\r\n\t]+/g, ' ').trim() : 'slurp_video';
  const utf8Filename = encodeURIComponent(cleanTitle) + `.${ext}`;
  const dispositionType = (inline === '1' || inline === 'true') ? 'inline' : 'attachment';

  // Fast-Path: If YouTube originUrl is present, stream directly via high-speed yt-dlp pipe (handles 2+ hour 4K/1080p without any stalling or 2MB cutoffs).
  // Datacenter IPs (e.g. Render) are frequently bot-blocked by YouTube, so yt-dlp can die with zero output.
  // Headers are only committed once the first byte arrives; otherwise we fall back to the HTTP CDN stream below.
  const isYouTube = platform === 'youtube' || (originUrl && (originUrl.includes('youtube.com') || originUrl.includes('youtu.be')));
  if (isYouTube && originUrl) {
    const YTDLP_FIRST_BYTE_TIMEOUT_MS = 15000;
    await ensurePotReady();
    const subprocess = youtubedl.exec(originUrl, {
      output: '-',
      format: isAudio ? 'bestaudio[ext=m4a]/bestaudio/best' : '18/best[ext=mp4]/best',
      ...ytdlpPotFlags()
    });
    // youtube-dl-exec v3 returns a thenable ChildProcess that rejects on non-zero exit
    // (bot-blocked datacenter IPs, killed subprocesses). Consume the rejection so it
    // never becomes an unhandledRejection that crashes the server.
    if (subprocess && typeof subprocess.catch === 'function') subprocess.catch(() => {});

    let stderrTail = '';
    const headChunks = [];
    let settled = false;
    let firstByte;
    const firstBytePromise = new Promise((resolve, reject) => { firstByte = { resolve, reject }; });

    const timer = setTimeout(() => {
      if (!settled) { settled = true; firstByte.reject(new Error(`yt-dlp produced no data within ${YTDLP_FIRST_BYTE_TIMEOUT_MS}ms`)); }
    }, YTDLP_FIRST_BYTE_TIMEOUT_MS);

    const onData = (chunk) => {
      headChunks.push(chunk);
      if (!settled) { settled = true; clearTimeout(timer); firstByte.resolve(); }
    };
    subprocess.stdout.on('data', onData);
    subprocess.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-300); });
    subprocess.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); firstByte.reject(new Error(`yt-dlp exited (code ${code}) before any data${stderrTail ? ': ' + stderrTail : ''}`)); }
    });
    subprocess.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); firstByte.reject(err); }
    });

    try {
      await firstBytePromise;

      res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${safeFilename}"; filename*=UTF-8''${utf8Filename}`);

      req.on('close', () => {
        try { subprocess.kill('SIGKILL'); } catch(e) {}
      });

      subprocess.stdout.removeListener('data', onData);
      subprocess.stdout.pause();
      for (const chunk of headChunks) res.write(chunk);
      subprocess.stdout.pipe(res);
      return;
    } catch (err) {
      try { subprocess.kill('SIGKILL'); } catch(e) {}
      console.warn('yt-dlp direct stream unavailable, falling back to CDN stream:', err.message);
    }
  }

  let targetUrl = url ? formatMediaUrl(url) : null;

  // Direct YouTube CDN stream via btch fallback engine.
  // resolveUniversalMedia() returns a relative /api/stream proxy path for YouTube, which is not fetchable here.
  async function refreshYouTubeTarget() {
    const yt = await btch.youtube(originUrl);
    if (yt && yt.status) {
      const direct = isAudio ? (yt.mp3 || yt.mp4) : (yt.mp4 || yt.mp3);
      if (direct) return direct;
    }
    throw new Error('No direct YouTube CDN stream available from fallback engine.');
  }

  async function fetchStream(mediaUrl) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };

    // Set origin/referer headers to bypass hotlinking 403 blocks
    if (mediaUrl.includes('twimg.com') || mediaUrl.includes('twitter.com') || mediaUrl.includes('x.com')) {
      headers['Referer'] = 'https://twitter.com/';
      headers['Origin'] = 'https://twitter.com';
    } else if (mediaUrl.includes('tikwm') || mediaUrl.includes('tiktokcdn')) {
      headers['Referer'] = 'https://www.tikwm.com/';
    } else if (mediaUrl.includes('instagram.com') || mediaUrl.includes('cdninstagram.com')) {
      headers['Referer'] = 'https://www.instagram.com/';
    } else if (mediaUrl.includes('facebook.com') || mediaUrl.includes('fbcdn.net')) {
      headers['Referer'] = 'https://www.facebook.com/';
    } else if (mediaUrl.includes('googlevideo.com') || mediaUrl.includes('youtube.com')) {
      headers['Referer'] = 'https://www.youtube.com/';
      headers['Origin'] = 'https://www.youtube.com';
    }

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    return await axios({
      method: 'GET',
      url: mediaUrl,
      responseType: 'stream',
      headers,
      timeout: 45000,
      validateStatus: (status) => status >= 200 && status < 400,
    });
  }

  try {
    // YouTube CDN links are throttled to ~2MB when fetched from datacenter IPs (Render).
    // Redirect the browser to a fresh direct CDN link instead of proxying, so the
    // download runs at the client's full speed and server bandwidth stays near zero.
    if (isYouTube && !targetUrl) {
      const directUrl = await refreshYouTubeTarget();
      return res.redirect(302, directUrl);
    }
    let videoResponse;
    try {
      if (!targetUrl && originUrl) {
        targetUrl = formatMediaUrl((await resolveUniversalMedia(originUrl))?.videoUrl);
      }
      videoResponse = await fetchStream(targetUrl);
    } catch (initialErr) {
      // If stream link expired or blocked (403/404/410) and originUrl is present, re-resolve fresh media stream
      if (originUrl && (initialErr.response?.status === 403 || initialErr.response?.status === 404 || initialErr.response?.status === 410 || !targetUrl)) {
        console.warn(`Stream token expired (${initialErr.message}). Re-resolving origin: ${originUrl}`);
        RESOLVE_CACHE.delete(originUrl);
        if (isYouTube) {
          const directUrl = await refreshYouTubeTarget();
          return res.redirect(302, directUrl);
        }
        const fresh = await resolveUniversalMedia(originUrl);
        if (fresh && fresh.videoUrl) {
          targetUrl = formatMediaUrl(fresh.videoUrl);
          videoResponse = await fetchStream(targetUrl);
        } else {
          throw initialErr;
        }
      } else {
        throw initialErr;
      }
    }

    req.on('close', () => {
      if (videoResponse && videoResponse.data && !videoResponse.data.destroyed) {
        videoResponse.data.destroy();
      }
    });

    res.status(videoResponse.status);
    res.setHeader('Content-Type', videoResponse.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    res.setHeader('Content-Disposition', `${dispositionType}; filename="${safeFilename}"; filename*=UTF-8''${utf8Filename}`);

    if (videoResponse.headers['content-length']) {
      res.setHeader('Content-Length', videoResponse.headers['content-length']);
    }
    if (videoResponse.headers['content-range']) {
      res.setHeader('Content-Range', videoResponse.headers['content-range']);
    }

    videoResponse.data.pipe(res);
  } catch (err) {
    console.error('Video stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Failed to stream video.');
    }
  }
});

// Fast In-Memory ZIP Archiver (Level 0 / Store mode for instant packaging)
app.post('/api/stream/slideshow-zip', async (req, res) => {
  const { images, title, musicUrl } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).send('No images provided for slideshow.');
  }
  await streamZipArchive(res, images, title, musicUrl);
});

// API: Universal Resolve endpoint
app.post('/api/resolve', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Please provide a valid link.' });
  }

  try {
    const data = await resolveUniversalMedia(url);
    res.json(data);
  } catch (err) {
    res.status(422).json({ error: err.message || 'Failed to process media link.' });
  }
});

// --- 12 PROGRAMMATIC SEO & AEO LANDING PAGES ---
const SEO_LANDING_PAGES = {
  '/tiktok-slideshow-downloader': {
    title: 'TikTok Slideshow Downloader (ZIP + Audio) | SLURP',
    description: 'Download full TikTok photo slideshows and carousels as high-resolution ZIP files with original soundtrack MP3. 100% free, fast, zero watermark.',
    keywords: 'tiktok slideshow downloader, download tiktok photos zip, tiktok carousel downloader, tiktok photo album download',
    canonical: 'https://slurp.media/tiktok-slideshow-downloader',
    status: 'tiktok slideshow to zip · soundtrack mp3 · no watermark',
    placeholder: 'paste tiktok photo slideshow link...',
    badge: 'TIKTOK SLIDESHOWS',
    breadcrumb: 'TikTok Slideshow Downloader',
    heading: 'TikTok Slideshow to ZIP Downloader',
    subheading: 'Extract all high-resolution slides and soundtrack into a single instant ZIP archive without watermarks.',
    answer: 'SLURP is an instant media archiver that resolves TikTok photo slideshows and bundles all full-resolution image slides (JPEG/WebP) alongside the original soundtrack (MP3) into a single downloadable ZIP file in under 10ms with zero watermarks.',
    steps: [
      { num: '01', title: 'Copy Slideshow Link', desc: 'Open TikTok, find the photo slideshow post, tap <strong>Share</strong> and copy the link.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the URL into the machine bar above or press <code>⌘V</code> anywhere on the page.' },
      { num: '03', title: 'Download .ZIP', desc: 'SLURP packages all full-res photos and original soundtrack into an instant ZIP archive.' }
    ],
    features: [
      { title: '10ms In-Memory ZIP Packaging', desc: 'Zero compression wait time. Packages 20+ HD images directly from CDN streams into one clean archive.' },
      { title: 'Soundtrack MP3 Extraction', desc: 'Includes the original isolated background music file (soundtrack.mp3) with every slideshow.' },
      { title: 'Zero Watermark & Full HD', desc: 'Preserves original pixel dimensions without any TikTok logo overlays or username watermarks.' }
    ],
    faqs: [
      { q: 'How do I download all photos from a TikTok slideshow at once?', a: 'Paste the slideshow URL into SLURP. It automatically detects all photo slides and bundles them with the background audio into a single .ZIP archive in under 10ms.' },
      { q: 'Can I download TikTok slideshows on iPhone (iOS)?', a: 'Yes! Tap Download on Safari, open the downloaded .ZIP file in the iOS Files app, and tap Uncompress to view all photos in original quality.' },
      { q: 'Is there a limit on how many slides I can download?', a: 'No. SLURP supports slideshows with any number of photos with zero limits.' }
    ]
  },
  '/tiktok-downloader': {
    title: 'TikTok Video Downloader Without Watermark HD | SLURP',
    description: 'Download TikTok videos in Full HD MP4 without watermark. Direct high-speed CDN stream, no ads, no sign-up.',
    keywords: 'tiktok video downloader, tiktok no watermark, download tiktok mp4, tiktok hd video download',
    canonical: 'https://slurp.media/tiktok-downloader',
    status: 'tiktok mp4 video · direct cdn stream · no watermark',
    placeholder: 'paste tiktok video link...',
    badge: 'TIKTOK VIDEO',
    breadcrumb: 'TikTok Video Downloader',
    heading: 'TikTok Video Downloader (No Watermark)',
    subheading: 'Download high-definition TikTok videos without watermark in original source bitrate.',
    answer: 'SLURP extracts clean, watermark-free TikTok videos directly from origin content delivery network (CDN) servers in full 1080p MP4 format with original high-bitrate audio.',
    steps: [
      { num: '01', title: 'Copy Video Link', desc: 'Open TikTok on app or web, tap <strong>Share</strong> and copy the video URL.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the URL into the input bar above. SLURP resolves the clean video stream instantly.' },
      { num: '03', title: 'Save .MP4', desc: 'Click Download to save the clean .MP4 file directly to your camera roll or downloads folder.' }
    ],
    features: [
      { title: '100% Clean / No Watermark', desc: 'Streams raw CDN bitrates without TikTok watermark or logo overlay.' },
      { title: 'Ultra-Fast Stream Direct', desc: 'Direct streaming eliminates server re-encoding delays.' },
      { title: 'Universal Device Support', desc: 'Works natively on iPhone Safari, Android Chrome, Mac, and Windows.' }
    ],
    faqs: [
      { q: 'Does SLURP remove watermarks from TikTok videos?', a: 'Yes. SLURP downloads the original unwatermarked source video directly from TikTok CDN servers.' },
      { q: 'Is SLURP free to download TikTok videos?', a: 'Yes, 100% free with unlimited downloads and zero ads.' }
    ]
  },
  '/tiktok-soundtrack-downloader': {
    title: 'TikTok MP3 Soundtrack & Audio Downloader | SLURP',
    description: 'Download original audio and soundtrack MP3 from any TikTok video or photo slideshow in high bitrate 320kbps. 100% free.',
    keywords: 'tiktok audio downloader, download tiktok mp3, tiktok sound download, extract audio from tiktok',
    canonical: 'https://slurp.media/tiktok-soundtrack-downloader',
    status: 'tiktok audio mp3 · 320kbps original bitrate · instant',
    placeholder: 'paste tiktok link to extract audio...',
    badge: 'TIKTOK AUDIO',
    breadcrumb: 'TikTok Soundtrack Downloader',
    heading: 'TikTok MP3 Soundtrack & Audio Downloader',
    subheading: 'Extract and download high-quality isolated audio and soundtrack MP3 files from any TikTok post.',
    answer: 'SLURP isolates and extracts the pure background music and audio track from any TikTok post, delivering a clean 320kbps MP3 sound file directly to your device.',
    steps: [
      { num: '01', title: 'Copy Post Link', desc: 'Copy the link of the TikTok containing the soundtrack you want to extract.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the link into SLURP. The engine isolates the soundtrack automatically.' },
      { num: '03', title: 'Download MP3', desc: 'Click download to save the uncompressed MP3 audio track.' }
    ],
    features: [
      { title: 'Original High-Bitrate Audio', desc: 'Extracts full fidelity audio directly from source media.' },
      { title: 'Works on Slideshows & Videos', desc: 'Isolates audio from both video posts and photo carousel sound loops.' },
      { title: 'Instant Processing', desc: 'No queue or slow conversion time.' }
    ],
    faqs: [
      { q: 'Can I extract sound from TikTok slideshows?', a: 'Yes! SLURP extracts the complete soundtrack MP3 from both videos and multi-photo slideshows.' }
    ]
  },
  '/instagram-reel-downloader': {
    title: 'Instagram Reels Downloader (1080p MP4) | SLURP',
    description: 'Download Instagram Reels and videos in high-definition MP4. Fast direct streaming with original audio.',
    keywords: 'instagram reel downloader, download ig reels mp4, instagram video download 1080p',
    canonical: 'https://slurp.media/instagram-reel-downloader',
    status: 'instagram reels · 1080p mp4 · original audio',
    placeholder: 'paste instagram reel link...',
    badge: 'INSTAGRAM REELS',
    breadcrumb: 'Instagram Reels Downloader',
    heading: 'Instagram Reels & Video Downloader',
    subheading: 'Save Instagram Reels, posts, and videos in crystal-clear 1080p MP4 with original audio.',
    answer: 'SLURP provides direct CDN video stream extraction for Instagram Reels, saving videos in original 1080p MP4 format with full audio clarity and zero watermarks.',
    steps: [
      { num: '01', title: 'Copy Reel Link', desc: 'Open Instagram, tap the three dots or Share icon on any Reel, and copy the link.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the URL into the input bar above.' },
      { num: '03', title: 'Download MP4', desc: 'Your download starts immediately with original sound and resolution.' }
    ],
    features: [
      { title: 'Full 1080p HD Quality', desc: 'Extracts the highest available bitrate Instagram video stream.' },
      { title: 'Original Audio Preserved', desc: 'Full stereo soundtrack saved directly inside the .MP4 file.' },
      { title: 'No Account Required', desc: 'Download public reels without logging into Instagram.' }
    ],
    faqs: [
      { q: 'Can I download Instagram Reels on my phone?', a: 'Yes, SLURP works directly in your mobile browser without installing third-party apps.' },
      { q: 'Can I download private Instagram posts?', a: 'No, only publicly viewable Instagram Reels and posts can be downloaded.' }
    ]
  },
  '/instagram-carousel-downloader': {
    title: 'Instagram Carousel & Multi-Photo Downloader | SLURP',
    description: 'Download multiple photos and videos from Instagram carousel posts in full original resolution.',
    keywords: 'instagram carousel downloader, download instagram multi photos, instagram slide downloader',
    canonical: 'https://slurp.media/instagram-carousel-downloader',
    status: 'instagram carousels · multi-photo download · hd',
    placeholder: 'paste instagram carousel link...',
    badge: 'INSTAGRAM CAROUSEL',
    breadcrumb: 'Instagram Carousel Downloader',
    heading: 'Instagram Carousel & Photo Downloader',
    subheading: 'Download multi-slide photo posts and albums in full resolution.',
    answer: 'SLURP extracts every photo and video slide from multi-item Instagram carousels in a single request, preserving full uncompressed original resolutions.',
    steps: [
      { num: '01', title: 'Copy Carousel Link', desc: 'Copy the URL of any multi-photo Instagram post.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the link into SLURP to extract all individual images.' },
      { num: '03', title: 'Download Photos', desc: 'Save all images in original resolution directly to your device.' }
    ],
    features: [
      { title: 'Multi-Image Extraction', desc: 'Grabs all photos in the carousel in one single request.' },
      { title: 'Original Resolution', desc: 'Downloads full uncompressed images.' },
      { title: 'Fast & Private', desc: 'No trackers, no data collection.' }
    ],
    faqs: [
      { q: 'How many photos can I extract from one Instagram post?', a: 'All photos present in the carousel (up to 10 or 20 items) will be extracted.' }
    ]
  },
  '/instagram-story-downloader': {
    title: 'Instagram Story & Highlights Downloader | SLURP',
    description: 'Download public Instagram Stories and Highlight videos in full HD MP4 quality anonymously. 100% free.',
    keywords: 'instagram story downloader, download ig story, instagram highlights downloader',
    canonical: 'https://slurp.media/instagram-story-downloader',
    status: 'instagram stories & highlights · anonymous · hd mp4',
    placeholder: 'paste public instagram story link...',
    badge: 'INSTAGRAM STORIES',
    breadcrumb: 'Instagram Story Downloader',
    heading: 'Instagram Story & Highlights Downloader',
    subheading: 'Download public Instagram Stories and Highlights anonymously in Full HD.',
    answer: 'SLURP resolves public Instagram Stories and Highlights, streaming the clean MP4 video or high-res photo directly to your browser with full anonymity.',
    steps: [
      { num: '01', title: 'Copy Story Link', desc: 'Copy the URL of any public Instagram Story or Highlight.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste into the machine bar above.' },
      { num: '03', title: 'Save Media', desc: 'Download original quality MP4 or JPEG files.' }
    ],
    features: [
      { title: '100% Anonymous', desc: 'Views and downloads public stories without logging into an Instagram account.' },
      { title: 'Original 1080p Resolution', desc: 'Saves the uncompressed source stream.' },
      { title: 'Zero App Installs', desc: 'Works directly in your mobile browser.' }
    ],
    faqs: [
      { q: 'Can I download stories anonymously?', a: 'Yes. SLURP does not require an Instagram login, ensuring your view is completely anonymous.' }
    ]
  },
  '/youtube-shorts-downloader': {
    title: 'YouTube Shorts Downloader (HD MP4) | SLURP',
    description: 'Download YouTube Shorts and videos directly in HD MP4 without popups or slow transcoding queues.',
    keywords: 'youtube shorts downloader, download youtube shorts mp4, youtube short video save',
    canonical: 'https://slurp.media/youtube-shorts-downloader',
    status: 'youtube shorts & videos · instant mp4 · zero queue',
    placeholder: 'paste youtube shorts link...',
    badge: 'YOUTUBE SHORTS',
    breadcrumb: 'YouTube Shorts Downloader',
    heading: 'YouTube Shorts & Video Downloader',
    subheading: 'Download YouTube Shorts and videos in HD MP4 with zero wait time and zero popups.',
    answer: 'SLURP is a high-speed YouTube Shorts extractor that delivers direct MP4 stream downloads without converter queues, third-party ads, or popups.',
    steps: [
      { num: '01', title: 'Copy Shorts URL', desc: 'Copy the link of any YouTube Short or regular video.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the link into the machine bar above.' },
      { num: '03', title: 'Download MP4', desc: 'Direct streaming begins immediately.' }
    ],
    features: [
      { title: 'Zero Transcoding Delay', desc: 'Streams direct media URLs with no waiting in converter queues.' },
      { title: 'Clean Vertical Video', desc: 'Maintains original vertical aspect ratio and resolution.' },
      { title: 'Ad-Free Experience', desc: 'No shady popups, fake download buttons, or malware.' }
    ],
    faqs: [
      { q: 'How do I download YouTube Shorts on mobile?', a: 'Paste the YouTube Shorts URL into SLURP on Safari (iOS) or Chrome (Android) and tap Download.' }
    ]
  },
  '/youtube-video-downloader': {
    title: 'YouTube Video Downloader (1080p MP4) | SLURP',
    description: 'Download YouTube videos in 1080p Full HD MP4 format. Direct stream connection with zero wait time.',
    keywords: 'youtube video downloader, download youtube mp4, youtube 1080p downloader, save youtube video',
    canonical: 'https://slurp.media/youtube-video-downloader',
    status: 'youtube videos · 1080p full hd · fast stream',
    placeholder: 'paste youtube video link...',
    badge: 'YOUTUBE VIDEO',
    breadcrumb: 'YouTube Video Downloader',
    heading: 'YouTube Video Downloader (1080p MP4)',
    subheading: 'Stream and save YouTube videos in Full HD MP4 directly to your device.',
    answer: 'SLURP extracts raw YouTube video streams in Full HD 1080p MP4 format, bypassing re-encoding lag and delivering instant downloads directly to your device.',
    steps: [
      { num: '01', title: 'Copy Video URL', desc: 'Copy the URL of any public YouTube video.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste into the machine input bar.' },
      { num: '03', title: 'Save .MP4', desc: 'Download Full HD video file.' }
    ],
    features: [
      { title: '1080p Full HD', desc: 'Crisp video streams with original audio tracks.' },
      { title: 'Direct Streaming', desc: 'Zero queue delays or external converter redirects.' },
      { title: 'Clean Interface', desc: 'Zero intrusive popups or advertisements.' }
    ],
    faqs: [
      { q: 'Is it free to download YouTube videos on SLURP?', a: 'Yes, SLURP is 100% free with unlimited downloads.' }
    ]
  },
  '/twitter-video-downloader': {
    title: 'X / Twitter Video Downloader (HD MP4) | SLURP',
    description: 'Download X (Twitter) videos and GIFs in highest available bitrate. Free, fast, and watermark-free.',
    keywords: 'twitter video downloader, x video downloader, download twitter mp4, save x video',
    canonical: 'https://slurp.media/twitter-video-downloader',
    status: 'x / twitter videos & gifs · highest bitrate hd',
    placeholder: 'paste x / twitter link...',
    badge: 'X / TWITTER',
    breadcrumb: 'X / Twitter Video Downloader',
    heading: 'X / Twitter Video Downloader',
    subheading: 'Save videos and GIFs from X (Twitter) in highest available bitrate.',
    answer: 'SLURP connects directly to X (Twitter) video endpoints to fetch the highest available bitrate MP4 video and animated GIF stream without watermarks.',
    steps: [
      { num: '01', title: 'Copy Tweet Link', desc: 'Tap Share on any post containing a video or GIF on X.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste into the machine input bar.' },
      { num: '03', title: 'Download HD MP4', desc: 'Saves the video directly in crystal-clear MP4.' }
    ],
    features: [
      { title: 'Highest Bitrate Selection', desc: 'Automatically selects the best HD stream available.' },
      { title: 'GIF to MP4 Support', desc: 'Converts animated GIFs into smooth standard MP4 files.' },
      { title: 'Direct CDN Links', desc: 'Zero proxy bottlenecks.' }
    ],
    faqs: [
      { q: 'Can I download GIFs from Twitter?', a: 'Yes, Twitter GIFs are encoded as MP4 videos and can be downloaded instantly.' }
    ]
  },
  '/facebook-reel-downloader': {
    title: 'Facebook Reels Downloader (HD MP4) | SLURP',
    description: 'Download Facebook Reels short-form videos in High Definition MP4 with original audio. Free & instant.',
    keywords: 'facebook reels downloader, download fb reels mp4, facebook reel video download',
    canonical: 'https://slurp.media/facebook-reel-downloader',
    status: 'facebook reels · 1080p hd mp4 · instant download',
    placeholder: 'paste facebook reel link...',
    badge: 'FACEBOOK REELS',
    breadcrumb: 'Facebook Reels Downloader',
    heading: 'Facebook Reels Downloader (HD MP4)',
    subheading: 'Download Facebook Reels in High Definition with original audio quality.',
    answer: 'SLURP extracts public Facebook Reels in crisp HD MP4 format, ensuring original audio synchronization and zero watermarks.',
    steps: [
      { num: '01', title: 'Copy Reel Link', desc: 'Click Share on any Facebook Reel and copy the link.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste the URL into SLURP.' },
      { num: '03', title: 'Download HD Video', desc: 'Instant direct download.' }
    ],
    features: [
      { title: 'HD Quality', desc: 'Fetches the highest resolution Facebook Reel stream.' },
      { title: 'Fast Direct Pipeline', desc: 'Direct stream avoids slow intermediate server buffering.' },
      { title: 'Mobile Friendly', desc: 'Saves directly to iOS Camera Roll and Android Downloads.' }
    ],
    faqs: [
      { q: 'Can I download Facebook Reels on iPhone?', a: 'Yes, tap Download in Safari, select the file, tap Share, and choose Save Video.' }
    ]
  },
  '/facebook-video-downloader': {
    title: 'Facebook Video Downloader (HD MP4) | SLURP',
    description: 'Download Facebook Watch and public videos in HD MP4. Direct CDN streams with zero waiting.',
    keywords: 'facebook video downloader, facebook watch downloader, download fb video mp4',
    canonical: 'https://slurp.media/facebook-video-downloader',
    status: 'facebook reels & watch videos · hd mp4',
    placeholder: 'paste facebook video link...',
    badge: 'FACEBOOK VIDEO',
    breadcrumb: 'Facebook Video Downloader',
    heading: 'Facebook Video Downloader',
    subheading: 'Download public Facebook videos and Watch clips in High Definition.',
    answer: 'SLURP extracts public Facebook Watch videos in HD and SD resolutions, offering direct stream MP4 downloads without third-party apps.',
    steps: [
      { num: '01', title: 'Copy Facebook Link', desc: 'Click Share and copy the public post or Watch link.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste into SLURP input bar.' },
      { num: '03', title: 'Download Video', desc: 'Instant MP4 file download.' }
    ],
    features: [
      { title: 'HD Quality Available', desc: 'Fetches HD video stream whenever available.' },
      { title: 'Works on Reels & Watch', desc: 'Full support for both short-form Reels and long-form Watch videos.' },
      { title: '100% Free', desc: 'No login or installation required.' }
    ],
    faqs: [
      { q: 'Can I download private Facebook videos?', a: 'No, only public videos can be extracted.' }
    ]
  },
  '/no-watermark-video-downloader': {
    title: 'Universal No Watermark Video Downloader | SLURP',
    description: 'Universal media downloader for TikTok, Instagram, YouTube, Facebook, and X with zero watermarks. Fast, free, and ad-free.',
    keywords: 'no watermark video downloader, remove video watermark, download video without watermark, clean mp4 downloader',
    canonical: 'https://slurp.media/no-watermark-video-downloader',
    status: 'universal downloader · zero watermark · 5 platforms',
    placeholder: 'paste any video or slideshow link...',
    badge: 'UNIVERSAL EXTRACTOR',
    breadcrumb: 'Universal No Watermark Downloader',
    heading: 'Universal No Watermark Video Downloader',
    subheading: 'Extract videos and slideshows from TikTok, Instagram, YouTube, Facebook, and X with 100% clean streams.',
    answer: 'SLURP is a universal media extraction engine that connects directly to origin CDN streams across TikTok, Instagram, YouTube, Facebook, and X to provide clean, unwatermarked HD video and ZIP archives.',
    steps: [
      { num: '01', title: 'Copy Any Link', desc: 'Copy a public media link from TikTok, IG, YouTube, FB, or X.' },
      { num: '02', title: 'Paste in SLURP', desc: 'Paste into the machine bar for instant auto-detection.' },
      { num: '03', title: 'Download Clean Media', desc: 'Download watermark-free MP4 video or ZIP photo archive.' }
    ],
    features: [
      { title: '5 Major Platforms', desc: 'Universal parser handles TikTok, IG, YouTube, Facebook, and X.' },
      { title: '0 Watermarks Added', desc: 'Extracts clean original source streams.' },
      { title: 'Ultra-Fast Zero Queue', desc: 'Direct streaming architecture with high socket parallelism.' }
    ],
    faqs: [
      { q: 'Which platforms does SLURP support?', a: 'SLURP supports TikTok (videos, slideshows, audio), Instagram (Reels, carousels, stories), YouTube (Shorts, videos), Facebook (Reels, Watch), and X / Twitter.' }
    ]
  }
};

let cachedLandingTemplate = '';
function getLandingTemplate() {
  if (!cachedLandingTemplate || process.env.NODE_ENV !== 'production') {
    cachedLandingTemplate = fs.readFileSync(path.join(__dirname, 'public', 'landing-template.html'), 'utf8');
  }
  return cachedLandingTemplate;
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = req.headers['x-forwarded-proto'] || (isLocal ? req.protocol : 'https');
  return `${protocol}://${host}`;
}

function generateStructuredData(meta, canonicalUrl, baseUrl) {
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${canonicalUrl}#webapp`,
        "name": meta.title,
        "url": canonicalUrl,
        "description": meta.description,
        "applicationCategory": "MultimediaApplication",
        "operatingSystem": "All",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "featureList": meta.features.map(f => f.title)
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Home",
            "item": `${baseUrl}/`
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": meta.breadcrumb,
            "item": canonicalUrl
          }
        ]
      },
      {
        "@type": "HowTo",
        "name": `How to Download with SLURP (${meta.badge})`,
        "description": meta.subheading,
        "step": meta.steps.map(s => ({
          "@type": "HowToStep",
          "name": s.title,
          "text": s.desc.replace(/<[^>]*>/g, '')
        }))
      },
      {
        "@type": "FAQPage",
        "mainEntity": meta.faqs.map(f => ({
          "@type": "Question",
          "name": f.q,
          "acceptedAnswer": { "@type": "Answer", "text": f.a }
        }))
      },
      {
        "@type": "Organization",
        "name": "SLURP Media",
        "url": `${baseUrl}/`,
        "logo": `${baseUrl}/favicon.svg`
      }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
}

function generateLandingContent(meta) {
  const stepsHtml = meta.steps.map(s => `
    <li class="step-card">
      <div class="step-num">${s.num}</div>
      <h3 class="step-heading">${s.title}</h3>
      <p class="step-desc">${s.desc}</p>
    </li>
  `).join('');

  const featuresHtml = meta.features.map(f => `
    <div class="platform-card">
      <div class="platform-card-header">
        <span class="platform-name">${f.title}</span>
        <span class="platform-tag">FAST</span>
      </div>
      <p class="platform-text">${f.desc}</p>
    </div>
  `).join('');

  const faqsHtml = meta.faqs.map((f, i) => `
    <details name="faq" class="faq-item" ${i === 0 ? 'open' : ''}>
      <summary class="faq-summary">
        <span>${f.q}</span>
        <span class="faq-icon">+</span>
      </summary>
      <div class="faq-answer">
        <p>${f.a}</p>
      </div>
    </details>
  `).join('');

  return `
    <section class="seo-section">
      <div class="section-badge">${meta.badge}</div>
      <h1 class="section-title">${meta.heading}</h1>
      <p class="section-subtitle">${meta.subheading}</p>

      <div class="geo-answer-box">
        <span class="geo-answer-label">Quick Summary</span>
        <p class="geo-answer-text">${meta.answer}</p>
      </div>

      <ol class="steps-grid">
        ${stepsHtml}
      </ol>
    </section>

    <section class="seo-section">
      <div class="section-badge">PERFORMANCE MATRIX</div>
      <h2 class="section-title">Engineered for Ludicrous Speed</h2>
      <div class="platform-grid">
        ${featuresHtml}
      </div>
    </section>

    <section class="seo-section">
      <div class="section-badge">FAQ</div>
      <h2 class="section-title">Frequently Asked Questions</h2>
      <div class="faq-list">
        ${faqsHtml}
      </div>
    </section>
  `;
}

// Dynamic Sitemap endpoint
app.get('/sitemap.xml', (req, res) => {
  const base = getBaseUrl(req);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>2026-08-16</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${Object.keys(SEO_LANDING_PAGES).map(r => `  <url>
    <loc>${base}${r}</loc>
    <lastmod>2026-08-16</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.90</priority>
  </url>`).join('\n')}
</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

// Dynamic Robots.txt endpoint
app.get('/robots.txt', (req, res) => {
  const base = getBaseUrl(req);
  const txt = `User-agent: *
Allow: /
Disallow: /api/

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: ${base}/sitemap.xml
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(txt);
});

// Bind all 12 programmatic routes
Object.entries(SEO_LANDING_PAGES).forEach(([routePath, meta]) => {
  app.get(routePath, (req, res) => {
    try {
      const template = getLandingTemplate();
      const baseUrl = getBaseUrl(req);
      const canonicalUrl = `${baseUrl}${routePath}`;
      const content = generateLandingContent(meta);
      const structuredData = generateStructuredData(meta, canonicalUrl, baseUrl);

      const html = template
        .replace(/{{PAGE_TITLE}}/g, meta.title)
        .replace(/{{PAGE_DESCRIPTION}}/g, meta.description)
        .replace(/{{PAGE_KEYWORDS}}/g, meta.keywords)
        .replace(/{{CANONICAL_URL}}/g, canonicalUrl)
        .replace(/{{HEADER_STATUS}}/g, meta.status)
        .replace(/{{INPUT_PLACEHOLDER}}/g, meta.placeholder)
        .replace(/{{BREADCRUMB_NAME}}/g, meta.breadcrumb)
        .replace('{{STRUCTURED_DATA}}', structuredData)
        .replace('{{PAGE_CONTENT}}', content);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error('Error rendering landing page:', e);
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  });
});

// Health check endpoint
app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

// Automated Keep-Alive for Render Free Tier
const externalUrl = process.env.RENDER_EXTERNAL_URL;
if (externalUrl) {
  const pingInterval = 12 * 60 * 1000;
  setInterval(() => {
    fastAxios.get(`${externalUrl}/api/ping`, {
      headers: { 'User-Agent': 'SLURP-KeepAlive/1.0' }
    }).catch(() => {});
  }, pingInterval);
}

// Start Server on 0.0.0.0 for universal reachability
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ SLURP Universal running on http://localhost:${PORT}`);
});
