const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for resolved media (auto-cleans after 30 mins)
const mediaCache = new Map();

function cleanOldCache() {
  const now = Date.now();
  for (const [id, item] of mediaCache.entries()) {
    if (now - item.timestamp > 30 * 60 * 1000) {
      mediaCache.delete(id);
    }
  }
}
setInterval(cleanOldCache, 5 * 60 * 1000);

// Ensure relative media URLs have full domain prefix
function formatMediaUrl(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    return rawPath;
  }
  return `https://www.tikwm.com${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
}

// Safe ASCII filename for HTTP Content-Disposition headers
function sanitizeFilename(name, fallback = 'tiktok_media') {
  if (!name) return fallback;
  const clean = name
    .replace(/[^\x20-\x7E]/g, '') // ASCII only
    .replace(/[<>:"/\\|?*#%&=;+`~[\]$@!]/g, '') // Remove forbidden chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40)
    .trim();
  return clean || fallback;
}

// Clean and extract valid TikTok URL
function cleanTikTokUrl(input) {
  if (!input) return null;
  const urlMatch = input.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s]+/i);
  if (!urlMatch) return null;
  return urlMatch[0].replace(/[)>,;]+$/, '');
}

// Fetch TikTok data with multiple cloud-safe strategies
async function fetchTikTokData(rawInput) {
  const targetUrl = cleanTikTokUrl(rawInput);
  if (!targetUrl) {
    throw new Error('Please enter a valid TikTok link.');
  }

  const strategies = [
    // Strategy 1: TikWM POST with mobile app headers (Bypasses Cloudflare 403 on cloud hosts)
    async () => {
      const params = new URLSearchParams({ url: targetUrl, hd: '1' });
      const res = await axios.post('https://www.tikwm.com/api/', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'com.ss.android.ugc.trill/260103 (Linux; U; Android 12; en_US; Pixel 6; Build/SQ3A.220705.004; Cronet/58.0.2991.0)',
          'Accept': 'application/json, text/plain, */*',
        },
        timeout: 10000,
      });
      return res.data;
    },
    // Strategy 2: TikWM GET Query
    async () => {
      const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        timeout: 10000,
      });
      return res.data;
    },
    // Strategy 3: Mirror endpoint
    async () => {
      const params = new URLSearchParams({ url: targetUrl, count: '12', cursor: '0', web: '1', hd: '1' });
      const res = await axios.post('https://api.tikwm.com/api/', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        },
        timeout: 10000,
      });
      return res.data;
    }
  ];

  let lastError = null;

  for (const strategy of strategies) {
    try {
      const data = await strategy();
      if (data && data.code === 0 && data.data) {
        const d = data.data;
        const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
        const mediaId = String(d.id || Date.now());

        const rawVideo = isSlideshow ? null : (d.play || d.hdplay || d.wmplay);
        const rawHdVideo = d.hdplay || d.play;

        const payload = {
          success: true,
          id: mediaId,
          title: d.title || 'tiktok_media',
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
          videoUrl: formatMediaUrl(rawVideo),
          hdVideoUrl: formatMediaUrl(rawHdVideo),
          images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
          stats: {
            likes: d.digg_count || 0,
            comments: d.comment_count || 0,
            shares: d.share_count || 0,
            views: d.play_count || 0,
          },
        };

        // Cache for direct downloads
        mediaCache.set(mediaId, {
          ...payload,
          timestamp: Date.now()
        });

        return payload;
      } else {
        lastError = data?.msg || 'Post not found or private.';
      }
    } catch (err) {
      lastError = err.message || 'Connection error.';
    }
  }

  throw new Error(lastError || 'Unable to resolve TikTok. Make sure post is public.');
}

// Helper: Bundle images and audio into a streaming zip
async function streamZipArchive(res, images, title, musicUrl) {
  const safeZipName = `${sanitizeFilename(title, 'tiktok_slideshow')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    console.error('Archive error:', err);
    if (!res.headersSent) {
      res.status(500).send({ error: err.message });
    }
  });

  archive.pipe(res);

  const fetchPromises = images.map(async (imgUrl, index) => {
    try {
      const padNum = String(index + 1).padStart(2, '0');
      const ext = imgUrl.includes('.png') ? 'png' : (imgUrl.includes('.webp') ? 'webp' : 'jpg');
      const formatted = formatMediaUrl(imgUrl);
      const imgRes = await axios.get(formatted, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      });
      archive.append(Buffer.from(imgRes.data), { name: `slide_${padNum}.${ext}` });
    } catch (e) {
      console.warn(`Failed slide ${index + 1}:`, e.message);
    }
  });

  let musicPromise = Promise.resolve();
  if (musicUrl) {
    const formattedMusic = formatMediaUrl(musicUrl);
    musicPromise = axios.get(formattedMusic, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    }).then((audioRes) => {
      archive.append(Buffer.from(audioRes.data), { name: 'soundtrack.mp3' });
    }).catch((e) => {
      console.warn('Failed audio track:', e.message);
    });
  }

  try {
    await Promise.all([...fetchPromises, musicPromise]);
    archive.append(`SLURP Slideshow Archive\nTitle: ${title || 'TikTok Slideshow'}\nSlides: ${images.length}\n`, { name: 'info.txt' });
    await archive.finalize();
  } catch (err) {
    console.error('Slideshow error:', err);
    archive.abort();
  }
}

// API: Resolve endpoint
app.post('/api/resolve', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Please provide a TikTok link.' });
  }

  try {
    const data = await fetchTikTokData(url);
    res.json(data);
  } catch (err) {
    res.status(422).json({ error: err.message || 'Failed to process TikTok link.' });
  }
});

// Clean Direct Video Download by ID: /api/download/:id/video
app.get('/api/download/:id/video', async (req, res) => {
  const { id } = req.params;
  const item = mediaCache.get(id);

  if (!item || !item.videoUrl) {
    return res.status(404).send('Download session expired or video not found. Please paste link again.');
  }

  const safeFilename = `${sanitizeFilename(item.title, 'tiktok_video')}.mp4`;

  try {
    const videoResponse = await axios({
      method: 'GET',
      url: item.videoUrl,
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

// Clean Direct Slideshow ZIP Download by ID: /api/download/:id/slideshow.zip
app.get('/api/download/:id/slideshow.zip', async (req, res) => {
  const { id } = req.params;
  const item = mediaCache.get(id);

  if (!item || !item.images || item.images.length === 0) {
    return res.status(404).send('Download session expired or slideshow not found. Please paste link again.');
  }

  await streamZipArchive(res, item.images, item.title, item.music);
});

// Direct Slideshow ZIP Streaming by POST
app.post('/api/stream/slideshow-zip', async (req, res) => {
  const { images, title, musicUrl } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).send('No images provided for slideshow.');
  }

  await streamZipArchive(res, images, title, musicUrl);
});

// Health check endpoint
app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

// Automated Keep-Alive for Render Free Tier
const externalUrl = process.env.RENDER_EXTERNAL_URL;
if (externalUrl) {
  const pingInterval = 12 * 60 * 1000; // 12 minutes
  setInterval(() => {
    axios.get(`${externalUrl}/api/ping`, {
      headers: { 'User-Agent': 'SLURP-KeepAlive/1.0' }
    })
      .then(() => console.log('🔄 Render Keep-Alive ping sent.'))
      .catch((e) => console.warn('Keep-alive ping failed:', e.message));
  }, pingInterval);
  console.log(`📡 Auto Keep-Alive enabled for: ${externalUrl}`);
}

// Start Server on 0.0.0.0 for universal reachability
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ SLURP running on http://localhost:${PORT}`);
});
