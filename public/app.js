/* ==========================================================================
   SLURP // UNIVERSAL MULTI-PLATFORM MEDIA CONTROLLER
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('slurpForm');
  const input = document.getElementById('urlInput');
  const goBtn = document.getElementById('goBtn');
  const btnArrow = document.getElementById('btnArrow');
  const statusLine = document.getElementById('statusLine');
  const outputSection = document.getElementById('slurpOutput');
  const pulseBar = document.getElementById('pulseBar');
  const outputContent = document.getElementById('outputContent');

  const MEDIA_REGEX = /(?:tiktok\.com|instagram\.com|instagr\.am|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.me|twitter\.com|x\.com)/i;

  // Submit Handler
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSlurp();
  });

  // Global Paste Handler (Cmd+V / Ctrl+V anywhere)
  window.addEventListener('paste', (e) => {
    if (document.activeElement !== input) {
      const text = e.clipboardData?.getData('text');
      if (text && MEDIA_REGEX.test(text)) {
        e.preventDefault();
        input.value = text.trim();
        handleSlurp();
      }
    }
  });

  // Instant Auto-Slurp on input paste
  input.addEventListener('paste', () => {
    setTimeout(() => {
      if (MEDIA_REGEX.test(input.value)) {
        handleSlurp();
      }
    }, 15);
  });

  // Platform Selectors
  const platPills = document.querySelectorAll('.plat-pill');
  platPills.forEach(pill => {
    pill.addEventListener('click', () => {
      platPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const placeholder = pill.getAttribute('data-placeholder');
      if (placeholder) {
        input.placeholder = placeholder;
      } else {
        input.placeholder = 'paste tiktok · ig · youtube · fb · x link...';
      }
      input.focus();
    });
  });

  // Auto-activate pill based on pathname or hash
  const pathname = window.location.pathname.toLowerCase();
  if (pathname.includes('tiktok')) {
    document.querySelector('.plat-pill[data-platform="tiktok"]')?.click();
  } else if (pathname.includes('instagram')) {
    document.querySelector('.plat-pill[data-platform="instagram"]')?.click();
  } else if (pathname.includes('youtube')) {
    document.querySelector('.plat-pill[data-platform="youtube"]')?.click();
  } else if (pathname.includes('twitter') || pathname.includes('x-video')) {
    document.querySelector('.plat-pill[data-platform="x"]')?.click();
  } else if (pathname.includes('facebook')) {
    document.querySelector('.plat-pill[data-platform="facebook"]')?.click();
  }

  // Escape key to reset
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetUI();
  });

  // URL Helper
  function formatMediaUrl(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath;
    return `https://www.tikwm.com${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
  }

  // Normalize TikTok payload
  function normalizeTikwmData(d) {
    const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
    const rawVideo = isSlideshow ? null : (d.play || d.hdplay || d.wmplay);

    return {
      success: true,
      platform: 'tiktok',
      id: String(d.id || Date.now()),
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
      videoUrl: formatMediaUrl(rawVideo),
      images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
    };
  }

  // Clean & Normalize URL from address bar, share sheet, or pasted text
  function cleanMediaUrl(input) {
    if (!input) return null;
    const match = input.match(/https?:\/\/[^\s]+/i);
    if (!match) return null;
    let url = match[0].replace(/[)>,;:.!?'\"\]}]+$/, '');

    // 1. Twitter / X: normalize address bar, modal, mobile, share params to canonical post URL
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

  // Blazing Fast Universal Resolver
  async function resolveMedia(rawUrl) {
    const cleanUrl = cleanMediaUrl(rawUrl) || rawUrl;
    const isTikTok = /tiktok\.com/i.test(cleanUrl);

    // If TikTok: race client endpoints with server for maximum speed
    if (isTikTok) {
      const params = new URLSearchParams({ url: cleanUrl }).toString();

      const clientA = fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: params
      }).then(r => r.json()).then(d => {
        if (d && d.code === 0 && d.data) return normalizeTikwmData(d.data);
        throw new Error('Client A failed');
      });

      const serverCall = fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      }).then(r => r.json()).then(d => {
        if (d && d.success) return d;
        throw new Error('Server failed');
      });

      try {
        return await Promise.any([clientA, serverCall]);
      } catch (e) {}
    }

    // Instagram, YouTube, Facebook, Twitter/X via Server Resolver
    const serverRes = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanUrl }),
    });

    const data = await serverRes.json();
    if (!serverRes.ok || !data.success) {
      throw new Error(data.error || 'Failed to extract media. Please check URL.');
    }
    return data;
  }

  async function handleSlurp() {
    const rawUrl = cleanMediaUrl(input.value.trim()) || input.value.trim();
    if (!rawUrl) {
      input.focus();
      return;
    }

    setLoading(true);
    statusLine.textContent = 'slurping signal...';

    try {
      const data = await resolveMedia(rawUrl);

      // Instant direct stream trigger
      triggerInstantDownload(data, rawUrl);

      setLoading(false);
      const platLabel = (data.platform || 'media').toUpperCase();
      statusLine.textContent = data.type === 'video' ? `${platLabel} video slurped` : `${platLabel} carousel slurped (${data.images.length} photos)`;
      renderOutput(data, rawUrl);

    } catch (err) {
      setLoading(false);
      statusLine.textContent = 'slurp failed';
      renderError(err.message || 'Unable to extract media. Check URL.');
    }
  }

  function getDownloadUrl(data, originUrl) {
    if (!data.videoUrl) return '';
    // Route all video downloads through same-origin stream endpoint to guarantee clean auto-download,
    // custom filename header, and 100% bypass of 403 / CORS hotlinking protection.
    const originParam = originUrl ? `&originUrl=${encodeURIComponent(originUrl)}` : '';
    return `/api/stream/video?url=${encodeURIComponent(data.videoUrl)}&title=${encodeURIComponent(sanitize(data.title))}&platform=${encodeURIComponent(data.platform || 'video')}${originParam}`;
  }

  function renderOutput(data, originUrl) {
    outputSection.style.display = 'block';
    const isVideo = data.type === 'video';
    const title = data.title || 'Media';
    const filename = `${sanitize(title)}.mp4`;
    const platform = (data.platform || 'media').toUpperCase();
    const downloadUrl = getDownloadUrl(data, originUrl);

    let previewHtml = '';
    let downloadHtml = '';

    if (isVideo) {
      const originParam = originUrl ? `&originUrl=${encodeURIComponent(originUrl)}` : '';
      const previewStreamUrl = `/api/stream/video?url=${encodeURIComponent(data.videoUrl)}&inline=1${originParam}`;
      const posterAttr = data.cover ? `poster="${escapeHtml(data.cover)}"` : '';
      previewHtml = `
        <div class="preview-mini-stage">
          <video src="${previewStreamUrl}" controls playsinline preload="metadata" ${posterAttr} referrerpolicy="no-referrer"></video>
        </div>
      `;
      let audioHtml = '';
      if (data.audioUrl) {
        const audioDownloadUrl = `/api/stream/video?url=${encodeURIComponent(data.audioUrl)}&title=${encodeURIComponent(sanitize(data.title))}&platform=audio${originParam}`;
        audioHtml = `
          <a href="${audioDownloadUrl}" class="btn-slurp-download btn-secondary-audio" download="${filename.replace(/\.mp4$/, '.mp3')}" style="margin-top: 8px; font-size: 0.8rem; opacity: 0.85;">
            ♫ DOWNLOAD .MP3 AUDIO
          </a>
        `;
      }
      downloadHtml = `
        <a href="${downloadUrl}" class="btn-slurp-download" download="${filename}">
          ↓ DOWNLOAD .MP4 [${platform}]
        </a>
        ${audioHtml}
      `;
    } else {
      const thumbs = data.images.map(img => `<img src="${img}" alt="Slide" loading="lazy" referrerpolicy="no-referrer" />`).join('');
      previewHtml = `
        <div class="slideshow-mini-reel">
          ${thumbs}
        </div>
      `;
      downloadHtml = `
        <button type="button" class="btn-slurp-download" id="zipDownloadBtn">
          📦 DOWNLOAD .ZIP (${data.images.length} PHOTOS)
        </button>
      `;
    }

    outputContent.innerHTML = `
      <div class="slurp-status-row">
        <div class="slurp-badge">
          <span class="slurp-badge-dot"></span>
          <span>${platform} ${isVideo ? 'VIDEO' : `CAROUSEL [${data.images.length}]`}</span>
        </div>
        <button type="button" class="btn-mini-reset" id="outputResetBtn">✕ CLEAR</button>
      </div>

      <div class="media-title-line" title="${escapeHtml(title)}">${escapeHtml(title)}</div>

      ${previewHtml}
      ${downloadHtml}
      <div class="auto-dl-text">Download started automatically. Click button above if blocked.</div>
    `;

    document.getElementById('outputResetBtn')?.addEventListener('click', resetUI);

    if (!isVideo) {
      document.getElementById('zipDownloadBtn')?.addEventListener('click', () => {
        downloadZip(data);
      });
    }
  }

  function renderError(msg) {
    outputSection.style.display = 'block';
    outputContent.innerHTML = `
      <div class="slurp-status-row">
        <div class="slurp-badge" style="color: #ff5252;">⚠ ERROR</div>
        <button type="button" class="btn-mini-reset" id="outputResetBtn">✕ CLEAR</button>
      </div>
      <div class="slurp-error">${escapeHtml(msg)}</div>
    `;
    document.getElementById('outputResetBtn')?.addEventListener('click', resetUI);
  }

  // Instant Streaming Download Trigger
  function triggerInstantDownload(data, originUrl) {
    if (data.type === 'video' && data.videoUrl) {
      const filename = `${sanitize(data.title)}.mp4`;
      const downloadUrl = getDownloadUrl(data, originUrl);
      
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.setAttribute('download', filename);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1000);
    } else if (data.type === 'slideshow') {
      downloadZip(data);
    }
  }

  // Fast Slideshow Zip Download
  async function downloadZip(data) {
    const btn = document.getElementById('zipDownloadBtn');
    if (btn) btn.textContent = '⚡ STREAMING ZIP...';

    try {
      const res = await fetch('/api/stream/slideshow-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: data.images,
          title: sanitize(data.title),
          musicUrl: data.music,
        }),
      });

      if (!res.ok) throw new Error('Failed to create ZIP');

      const blob = await res.blob();
      const zipUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `${sanitize(data.title)}_slideshow.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(zipUrl);

      if (btn) btn.textContent = `📦 DOWNLOAD .ZIP (${data.images.length} PHOTOS)`;
    } catch (err) {
      if (btn) btn.textContent = 'RETRY ZIP DOWNLOAD';
    }
  }

  function setLoading(isLoading) {
    goBtn.disabled = isLoading;
    btnArrow.textContent = isLoading ? '···' : '↓';
    pulseBar.classList.toggle('active', isLoading);
  }

  function resetUI() {
    input.value = '';
    outputSection.style.display = 'none';
    outputContent.innerHTML = '';
    pulseBar.classList.remove('active');
    statusLine.textContent = 'tiktok · instagram · youtube · facebook · x';
    goBtn.disabled = false;
    btnArrow.textContent = '↓';
    input.focus();
  }

  function sanitize(str) {
    return (str || 'slurp_media')
      .replace(/https?:\/\/[^\s]+/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/[<>:"/\\|?*#%&=;+`~[\]$@!]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'slurp_media';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
});
