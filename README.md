# ⟁ SLURP

> Minimalist single-purpose tool to extract & download watermark-free TikTok videos and bulk photo slideshow ZIP archives instantly.

---

## ⚡ Features
- **Pure Utility**: Paste a TikTok link $\rightarrow$ automatic type detection $\rightarrow$ direct file download.
- **Videos**: High quality `.mp4` video without watermarks.
- **Slideshows**: Direct `.zip` archive streaming containing all full-resolution photos and soundtrack audio.
- **Ultra-Minimalist UI**: Built with a dark brutalist-zen aesthetic, responsive typography, and tactile interactions.
- **No Limits**: No account required, no local storage buildup (in-memory streaming).

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

Open `http://localhost:3000` in your browser.

---

## 🛠️ Tech Stack
- **Backend**: Node.js, Express, Axios, Archiver (streaming ZIP generator)
- **Frontend**: Vanilla HTML5, CSS3, JavaScript (zero heavy dependencies)

---

## 📦 Deployment
Compatible with any standard Node.js hosting platform (Railway, Render, Fly.io, DigitalOcean, VPS):
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Port**: Set via `process.env.PORT` (defaults to 3000)
