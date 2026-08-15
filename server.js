const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const axios = require('axios');
const archiver = require('archiver');
const btch = require('btch-downloader');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

// High-performance Keep-Alive Connection Pool for Massive Parallelism
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 50 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200, maxFreeSockets: 50 });
const fastAxios = axios.create({ httpsAgent, httpAgent, timeout: 12000 });

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
  return `https://www.tikwm.com${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
}

// Safe ASCII filename for HTTP Content-Disposition headers
function sanitizeFilename(name, fallback = 'slurp_media') {
  if (!name) return fallback;
  const clean = name
    .replace(/[^\x20-\x7E]/g, '') // ASCII only
    .replace(/[<>:"/\\|?*#%&=;+`~[\]$@!]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 35)
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

// Clean and extract valid media URL
function cleanMediaUrl(input) {
  if (!input) return null;
  const match = input.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  return match[0].replace(/[)>,;]+$/, '');
}

// --- FAST RESOLVERS ---

// 1. TikTok Fast Resolver
async function resolveTikTok(targetUrl) {
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

      return {
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
    }
  } catch (err) {
    const getRes = await fastAxios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (getRes.data && getRes.data.code === 0 && getRes.data.data) {
      const d = getRes.data.data;
      const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
      return {
        success: true,
        platform: 'tiktok',
        id: String(d.id || Date.now()),
        title: d.title || 'TikTok Media',
        type: isSlideshow ? 'slideshow' : 'video',
        videoUrl: formatMediaUrl(d.play || d.hdplay),
        images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
        music: formatMediaUrl(d.music)
      };
    }
  }
  throw new Error('Could not resolve TikTok media.');
}

// 2. Instagram Fast Resolver (Reels & Carousels)
async function resolveInstagram(targetUrl) {
  try {
    const igData = await btch.igdl(targetUrl);
    if (igData && igData.status && Array.isArray(igData.result) && igData.result.length > 0) {
      const validItems = igData.result.filter(item => item.url);
      if (validItems.length > 1) {
        return {
          success: true,
          platform: 'instagram',
          id: String(Date.now()),
          title: 'Instagram Carousel',
          type: 'slideshow',
          images: validItems.map(item => item.url),
          cover: validItems[0].url
        };
      } else if (validItems.length === 1) {
        const item = validItems[0];
        const isVideo = item.url.includes('.mp4') || (item.thumbnail && item.thumbnail.length > 0);
        return {
          success: true,
          platform: 'instagram',
          id: String(Date.now()),
          title: 'Instagram Media',
          type: isVideo ? 'video' : 'slideshow',
          videoUrl: isVideo ? item.url : null,
          images: isVideo ? [] : [item.url],
          cover: item.thumbnail || item.url
        };
      }
    }
  } catch (e) {}

  throw new Error('Unable to extract Instagram link. Make sure the post is public.');
}

// 3. YouTube & Shorts Fast-Racing Resolver
async function resolveYouTube(targetUrl) {
  // Strategy A: Direct @distube/ytdl-core stream extraction
  const ytdlStrategy = (async () => {
    const info = await ytdl.getInfo(targetUrl);
    const formats = ytdl.filterFormats(info.formats, 'audioandvideo');
    const bestFormat = formats.find(f => f.qualityLabel === '720p') || formats[0];
    if (bestFormat && bestFormat.url) {
      return {
        success: true,
        platform: 'youtube',
        id: info.videoDetails?.videoId || String(Date.now()),
        title: info.videoDetails?.title || 'YouTube Video',
        author: {
          name: info.videoDetails?.author?.name || 'YouTube Creator',
          username: info.videoDetails?.author?.user || 'user',
          avatar: info.videoDetails?.author?.thumbnails?.[0]?.url || ''
        },
        cover: info.videoDetails?.thumbnails?.[0]?.url || '',
        type: 'video',
        videoUrl: bestFormat.url,
        images: []
      };
    }
    throw new Error('ytdl format error');
  })();

  // Strategy B: btch.youtube proxy fallback
  const btchStrategy = (async () => {
    const yt = await btch.youtube(targetUrl);
    if (yt && yt.status && yt.mp4) {
      return {
        success: true,
        platform: 'youtube',
        id: String(Date.now()),
        title: yt.title || 'YouTube Video',
        author: { name: yt.author || 'YouTube Channel', username: yt.author || 'creator', avatar: '' },
        cover: yt.thumbnail || '',
        type: 'video',
        videoUrl: yt.mp4,
        images: []
      };
    }
    throw new Error('btch failed');
  })();

  try {
    return await Promise.any([ytdlStrategy, btchStrategy]);
  } catch (e) {
    throw new Error('Unable to extract YouTube video. Make sure video is public.');
  }
}

// 4. Facebook Reels & Watch Fast-Racing Resolver
async function resolveFacebook(targetUrl) {
  // Strategy A: btch.fbdown (RapidCDN stream extraction)
  const btchFbPromise = (async () => {
    const fb = await btch.fbdown(targetUrl);
    if (fb && fb.status && (fb.HD || fb.Normal_video)) {
      return {
        success: true,
        platform: 'facebook',
        id: String(Date.now()),
        title: 'Facebook Reel',
        type: 'video',
        videoUrl: fb.HD || fb.Normal_video,
        images: []
      };
    }
    throw new Error('fbdown failed');
  })();

  // Strategy B: Direct SSR HTML regex extraction
  const regexFbPromise = (async () => {
    const fbPage = await fastAxios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 6000
    });
    const html = fbPage.data;
    const hdMatch = html.match(/"browser_native_hd_url":"([^"]+)"/) || html.match(/"playable_url_quality_hd":"([^"]+)"/);
    const sdMatch = html.match(/"browser_native_sd_url":"([^"]+)"/) || html.match(/"playable_url":"([^"]+)"/);
    const videoRaw = hdMatch ? hdMatch[1] : (sdMatch ? sdMatch[1] : null);
    if (videoRaw) {
      return {
        success: true,
        platform: 'facebook',
        id: String(Date.now()),
        title: 'Facebook Video',
        type: 'video',
        videoUrl: JSON.parse(`"${videoRaw}"`),
        images: []
      };
    }
    throw new Error('regex failed');
  })();

  try {
    return await Promise.any([btchFbPromise, regexFbPromise]);
  } catch (e) {
    throw new Error('Unable to extract Facebook video. Make sure post is public.');
  }
}

// 5. Twitter / X Fast Resolver
async function resolveTwitter(targetUrl) {
  try {
    const tw = await btch.twitter(targetUrl);
    if (tw && tw.status && Array.isArray(tw.url) && tw.url.length > 0) {
      const valid = tw.url.find(u => u.hd || u.sd || u.url);
      const video = valid?.hd || valid?.sd || valid?.url || (typeof valid === 'string' ? valid : null);
      if (video) {
        return {
          success: true,
          platform: 'twitter',
          id: String(Date.now()),
          title: tw.title || 'X Video',
          type: 'video',
          videoUrl: video,
          images: []
        };
      }
    }
  } catch (e) {}

  throw new Error('Unable to extract X / Twitter video.');
}

// Universal Resolver Router
async function resolveUniversalMedia(rawInput) {
  const targetUrl = cleanMediaUrl(rawInput);
  if (!targetUrl) {
    throw new Error('Please enter a valid link (TikTok, Instagram, YouTube, Facebook, or X).');
  }

  const platform = detectPlatform(targetUrl);

  switch (platform) {
    case 'tiktok':
      return await resolveTikTok(targetUrl);
    case 'instagram':
      return await resolveInstagram(targetUrl);
    case 'youtube':
      return await resolveYouTube(targetUrl);
    case 'facebook':
      return await resolveFacebook(targetUrl);
    case 'twitter':
      return await resolveTwitter(targetUrl);
    default:
      try { return await resolveTikTok(targetUrl); } catch (e) {}
      try { return await resolveYouTube(targetUrl); } catch (e) {}
      try { return await resolveFacebook(targetUrl); } catch (e) {}
      throw new Error('Unsupported platform. Supported: TikTok, Instagram, YouTube, Facebook, and X.');
  }
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

// Direct Instant Video Streamer (No cache dependencies, 100% reliable)
app.get('/api/stream/video', async (req, res) => {
  const { url, title } = req.query;
  if (!url) {
    return res.status(400).send('Missing video URL.');
  }

  const safeFilename = `${sanitizeFilename(title, 'slurp_video')}.mp4`;
  const targetUrl = formatMediaUrl(url);

  try {
    const videoResponse = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 40000,
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    if (videoResponse.headers['content-length']) {
      res.setHeader('Content-Length', videoResponse.headers['content-length']);
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
