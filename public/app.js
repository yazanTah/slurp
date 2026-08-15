/* ==========================================================================
   SLURP // CLIENT CONTROLLER
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

  // Global Paste Handler (Cmd+V / Ctrl+V anywhere)
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

  // Escape key to reset
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetUI();
  });

  async function handleSlurp() {
    const rawUrl = input.value.trim();
    if (!rawUrl) {
      input.focus();
      return;
    }

    setLoading(true);
    statusLine.textContent = 'slurping signal...';

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to slurp. Make sure the TikTok link is public.');
      }

      setLoading(false);
      statusLine.textContent = data.type === 'video' ? 'video slurped' : `slideshow slurped (${data.images.length} photos)`;
      renderOutput(data);
      triggerAutoDownload(data);

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
    const filename = sanitize(title);

    let previewHtml = '';
    let downloadHtml = '';

    if (isVideo) {
      const directDownloadUrl = `/api/download/${data.id}/video`;
      previewHtml = `
        <div class="preview-mini-stage">
          <video src="${data.videoUrl}" controls playsinline autoplay muted></video>
        </div>
      `;
      downloadHtml = `
        <a href="${directDownloadUrl}" class="btn-slurp-download" download="${filename}.mp4">
          ↓ DOWNLOAD .MP4
        </a>
      `;
    } else {
      // Slideshow
      const directZipUrl = `/api/download/${data.id}/slideshow.zip`;
      const thumbs = data.images.map(img => `<img src="${img}" alt="Slide" />`).join('');
      previewHtml = `
        <div class="slideshow-mini-reel">
          ${thumbs}
        </div>
      `;
      downloadHtml = `
        <a href="${directZipUrl}" class="btn-slurp-download" download="${filename}_slideshow.zip">
          📦 DOWNLOAD .ZIP (${data.images.length} PHOTOS + AUDIO)
        </a>
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

  function triggerAutoDownload(data) {
    const downloadUrl = data.type === 'video' 
      ? `/api/download/${data.id}/video`
      : `/api/download/${data.id}/slideshow.zip`;
    const filename = data.type === 'video' 
      ? `${sanitize(data.title)}.mp4` 
      : `${sanitize(data.title)}_slideshow.zip`;

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
