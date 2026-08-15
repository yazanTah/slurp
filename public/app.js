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

  // Blazing Fast Universal Resolver
  async function resolveMedia(rawUrl) {
    const isTikTok = /tiktok\.com/i.test(rawUrl);

    // If TikTok: race client endpoints with server for maximum speed
    if (isTikTok) {
      const params = new URLSearchParams({ url: rawUrl }).toString();

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
        body: JSON.stringify({ url: rawUrl }),
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
      body: JSON.stringify({ url: rawUrl }),
    });

    const data = await serverRes.json();
    if (!serverRes.ok || !data.success) {
      throw new Error(data.error || 'Failed to extract media. Please check URL.');
    }
    return data;
  }

  async function handleSlurp() {
    const rawUrl = input.value.trim();
    if (!rawUrl) {
      input.focus();
      return;
    }

    setLoading(true);
    statusLine.textContent = 'slurping signal...';

    try {
      const data = await resolveMedia(rawUrl);

      // Instant direct stream trigger
      triggerInstantDownload(data);

      setLoading(false);
      const platLabel = (data.platform || 'media').toUpperCase();
      statusLine.textContent = data.type === 'video' ? `${platLabel} video slurped` : `${platLabel} carousel slurped (${data.images.length} photos)`;
      renderOutput(data);

    } catch (err) {
      setLoading(false);
      statusLine.textContent = 'slurp failed';
      renderError(err.message || 'Unable to extract media. Check URL.');
    }
  }

  function renderOutput(data) {
    outputSection.style.display = 'block';
    const isVideo = data.type === 'video';
    const title = data.title || 'Media';
    const filename = `${sanitize(title)}.mp4`;
    const platform = (data.platform || 'media').toUpperCase();
    const streamUrl = `/api/stream/video?url=${encodeURIComponent(data.videoUrl)}&title=${encodeURIComponent(sanitize(title))}`;

    let previewHtml = '';
    let downloadHtml = '';

    if (isVideo) {
      previewHtml = `
        <div class="preview-mini-stage">
          <video src="${data.videoUrl}" controls playsinline autoplay muted></video>
        </div>
      `;
      downloadHtml = `
        <a href="${streamUrl}" class="btn-slurp-download" download="${filename}">
          ↓ DOWNLOAD .MP4 [${platform}]
        </a>
      `;
    } else {
      const thumbs = data.images.map(img => `<img src="${img}" alt="Slide" loading="lazy" />`).join('');
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
  function triggerInstantDownload(data) {
    if (data.type === 'video' && data.videoUrl) {
      const filename = `${sanitize(data.title)}.mp4`;
      const streamUrl = `/api/stream/video?url=${encodeURIComponent(data.videoUrl)}&title=${encodeURIComponent(sanitize(data.title))}`;
      
      const a = document.createElement('a');
      a.href = streamUrl;
      a.setAttribute('download', filename);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => document.body.removeChild(a), 1000);
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
    return (str || 'slurp_media').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 35);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
});
