/* ==========================================================================
   SLURP // HYPER-OPTIMIZED ZERO-LATENCY CLIENT CONTROLLER
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

  // Submit Handler
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSlurp();
  });

  // Instant Auto-Slurp on Global Paste
  window.addEventListener('paste', (e) => {
    if (document.activeElement !== input) {
      const text = e.clipboardData?.getData('text');
      if (text && /tiktok\.com/i.test(text)) {
        e.preventDefault();
        input.value = text.trim();
        handleSlurp();
      }
    }
  });

  // Auto-Slurp on input paste event
  input.addEventListener('paste', (e) => {
    setTimeout(() => {
      if (/tiktok\.com/i.test(input.value)) {
        handleSlurp();
      }
    }, 10);
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

  // Normalize payload
  function normalizeTikwmData(d) {
    const isSlideshow = Array.isArray(d.images) && d.images.length > 0;
    const rawVideo = isSlideshow ? null : (d.play || d.hdplay || d.wmplay);
    const rawHdVideo = d.hdplay || d.play;

    return {
      success: true,
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
      hdVideoUrl: formatMediaUrl(rawHdVideo),
      images: isSlideshow ? d.images.map(img => formatMediaUrl(img)) : [],
      stats: {
        likes: d.digg_count || 0,
        comments: d.comment_count || 0,
        shares: d.share_count || 0,
        views: d.play_count || 0,
      }
    };
  }

  // Blazing Fast Parallel Race Resolver
  async function resolveTikTok(rawUrl) {
    const params = new URLSearchParams({ url: rawUrl, hd: '1' }).toString();

    // Fast-race multiple client endpoints simultaneously: first response wins!
    const clientPromiseA = fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params
    }).then(r => r.json()).then(d => {
      if (d && d.code === 0 && d.data) return normalizeTikwmData(d.data);
      throw new Error('A failed');
    });

    const clientPromiseB = fetch('https://tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params
    }).then(r => r.json()).then(d => {
      if (d && d.code === 0 && d.data) return normalizeTikwmData(d.data);
      throw new Error('B failed');
    });

    const serverFallback = fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl }),
    }).then(r => r.json()).then(d => {
      if (d && d.success) return d;
      throw new Error('Server fallback failed');
    });

    try {
      return await Promise.any([clientPromiseA, clientPromiseB, serverFallback]);
    } catch (e) {
      // Last-ditch direct attempt
      const lastRes = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl }),
      });
      const data = await lastRes.json();
      if (!lastRes.ok || !data.success) throw new Error(data.error || 'Failed to extract TikTok media.');
      return data;
    }
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
      const data = await resolveTikTok(rawUrl);

      // Instant Download Trigger immediately before DOM updates
      triggerAutoDownload(data);

      setLoading(false);
      statusLine.textContent = data.type === 'video' ? 'video slurped' : `slideshow slurped (${data.images.length} photos)`;
      renderOutput(data);

    } catch (err) {
      setLoading(false);
      statusLine.textContent = 'slurp failed';
      renderError(err.message || 'Unable to extract TikTok. Check URL.');
    }
  }

  function renderOutput(data) {
    outputSection.style.display = 'block';
    const isVideo = data.type === 'video';
    const title = data.title || 'TikTok Media';

    let previewHtml = '';
    let downloadHtml = '';

    if (isVideo) {
      previewHtml = `
        <div class="preview-mini-stage">
          <video src="${data.videoUrl}" controls playsinline autoplay muted></video>
        </div>
      `;
      downloadHtml = `
        <button type="button" class="btn-slurp-download" id="videoDownloadBtn">
          ↓ DOWNLOAD .MP4 [NO WATERMARK]
        </button>
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
          📦 DOWNLOAD .ZIP (${data.images.length} PHOTOS + AUDIO)
        </button>
      `;
    }

    outputContent.innerHTML = `
      <div class="slurp-status-row">
        <div class="slurp-badge">
          <span class="slurp-badge-dot"></span>
          <span>${isVideo ? 'VIDEO' : `SLIDESHOW [${data.images.length}]`}</span>
        </div>
        <button type="button" class="btn-mini-reset" id="outputResetBtn">✕ CLEAR</button>
      </div>

      <div class="media-title-line" title="${escapeHtml(title)}">${escapeHtml(title)}</div>

      ${previewHtml}
      ${downloadHtml}
      <div class="auto-dl-text">Download started automatically. Click button above if blocked.</div>
    `;

    document.getElementById('outputResetBtn')?.addEventListener('click', resetUI);

    if (isVideo) {
      document.getElementById('videoDownloadBtn')?.addEventListener('click', () => {
        downloadDirectVideo(data);
      });
    } else {
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

  // Trigger Automatic Download
  function triggerAutoDownload(data) {
    if (data.type === 'video') {
      downloadDirectVideo(data);
    } else {
      downloadZip(data);
    }
  }

  // Direct High-Speed Video Download (Instant Direct Blob / Anchor Stream)
  async function downloadDirectVideo(data) {
    const filename = `${sanitize(data.title)}.mp4`;
    const btn = document.getElementById('videoDownloadBtn');

    try {
      if (btn) btn.textContent = 'DOWNLOADING .MP4...';
      const res = await fetch(data.videoUrl);
      if (!res.ok) throw new Error('Direct fetch error');
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);

      if (btn) btn.textContent = '↓ DOWNLOAD .MP4 [NO WATERMARK]';
    } catch (e) {
      const a = document.createElement('a');
      a.href = data.videoUrl;
      a.target = '_blank';
      a.setAttribute('download', filename);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (btn) btn.textContent = '↓ DOWNLOAD .MP4 [NO WATERMARK]';
    }
  }

  // Ultra-Fast Slideshow Zip Download
  async function downloadZip(data) {
    const btn = document.getElementById('zipDownloadBtn');
    if (btn) btn.textContent = 'PACKAGING ZIP...';

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

      if (btn) btn.textContent = `📦 DOWNLOAD .ZIP (${data.images.length} PHOTOS + AUDIO)`;
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
    statusLine.textContent = 'paste link → get mp4 or zip';
    goBtn.disabled = false;
    btnArrow.textContent = '↓';
    input.focus();
  }

  function sanitize(str) {
    return (str || 'tiktok_media').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 35);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
});
