const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const axios = require('axios');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// High-performance Keep-Alive Connection Pool
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const fastAxios = axios.create({ httpsAgent, httpAgent, timeout: 15000 });

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
function sanitizeFilename(name, fallback = 'tiktok_media') {
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

// Clean and extract valid TikTok URL
function cleanTikTokUrl(input) {
  if (!input) return null;
  const urlMatch = input.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s]+/i);
  if (!urlMatch) return null;
  return urlMatch[0].replace(/[)>,;]+$/, '');
}

// Fast parallel resolve
async function fetchTikTokData(rawInput) {
  const targetUrl = cleanTikTokUrl(rawInput);
  if (!targetUrl) {
    throw new Error('Please enter a valid TikTok link.');
  }

  const endpointA = fastAxios.post('https://www.tikwm.com/api/', new URLSearchParams({ url: targetUrl, hd: '1' }).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }
  }).then(r => r.data);

  const endpointB = fastAxios.post('https://tikwm.com/api/', new URLSearchParams({ url: targetUrl, hd: '1' }).toString(), {
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

      const rawVideo = isSlideshow ? null : (d.play || d.hdplay || d.wmplay);
      const rawHdVideo = d.hdplay || d.play;

      return {
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
    }
  } catch (err) {
    try {
      const getRes = await fastAxios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (getRes.data && getRes.data.code === 0 && getRes.data.data) {
        const d = getRes.data.data;
        const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
        const mediaId = String(d.id || Date.now());

        return {
          success: true,
          id: mediaId,
          title: d.title || 'tiktok_media',
          type: isSlideshow ? 'slideshow' : 'video',
          videoUrl: formatMediaUrl(d.play || d.hdplay),
          hdVideoUrl: formatMediaUrl(d.hdplay || d.play),
          images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
          music: formatMediaUrl(d.music)
        };
      }
    } catch (e) {}
  }

  throw new Error('Unable to resolve TikTok. Make sure post is public.');
}

// Direct Instant Video Streamer (No cache dependencies, 100% reliable)
app.get('/api/stream/video', async (req, res) => {
  const { url, title } = req.query;
  if (!url) {
    return res.status(400).send('Missing video URL.');
  }

  const safeFilename = `${sanitizeFilename(title, 'tiktok_video')}.mp4`;
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

// Fast In-Memory ZIP Archiver (Level 1 compression)
app.post('/api/stream/slideshow-zip', async (req, res) => {
  const { images, title, musicUrl } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).send('No images provided for slideshow.');
  }

  const safeZipName = `${sanitizeFilename(title, 'tiktok_slideshow')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);

  const archive = archiver('zip', { zlib: { level: 1 } });

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
        headers: { 'User-Agent': 'Mozilla/5.0' }
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
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }).then((audioRes) => {
      archive.append(Buffer.from(audioRes.data), { name: 'soundtrack.mp3' });
    }).catch(() => {});
  }

  try {
    await Promise.all([...fetchPromises, musicPromise]);
    archive.append(`SLURP Slideshow Archive\nTitle: ${title || 'TikTok Slideshow'}\nSlides: ${images.length}\n`, { name: 'info.txt' });
    await archive.finalize();
  } catch (err) {
    archive.abort();
  }
});

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
  console.log(`⚡ SLURP running on http://localhost:${PORT}`);
});
