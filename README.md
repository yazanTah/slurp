# ⟁ SLURP

> **The ultra-minimalist, single-purpose TikTok video & slideshow downloader.**  
> Zero ads. Zero watermarks. Zero bloat. Paste a link $\rightarrow$ get an HD `.mp4` video or bundled `.zip` photo archive instantly.

---

## 📑 Table of Contents
- [About](#-about)
- [Overview](#-overview)
- [Key Features](#-key-features)
- [AI & Agent Integration](#-ai--agent-integration)
- [REST API Reference](#-rest-api-reference)
  - [1. Resolve Media Metadata](#1-resolve-media-metadata)
  - [2. Download Video (.mp4)](#2-download-video-mp4)
  - [3. Download Slideshow (.zip)](#3-download-slideshow-zip)
  - [4. Dynamic ZIP Stream (POST)](#4-dynamic-zip-stream-post)
- [Architecture & Tech Stack](#-architecture--tech-stack)
- [Project Directory Tree](#-project-directory-tree)
- [Local Setup & Installation](#-local-setup--installation)
- [Deployment & Custom Domains](#-deployment--custom-domains)
- [UX & Keyboard Shortcuts](#-ux--keyboard-shortcuts)
- [Disclaimer & License](#-disclaimer--license)

---

## ⟁ About

**SLURP** was created to kill the clutter of modern media downloaders. 

Most download websites are packed with intrusive banner ads, deceptive "Download" buttons, forced 15-second wait times, and bloated trackings. **SLURP** is the pure anti-bloat alternative built on a single manifesto:

> **Do 1 thing flawlessly: paste a TikTok link $\rightarrow$ get your clean `.mp4` video or full-res `.zip` photo carousel. Zero ads. Zero watermarks. Nothing more, nothing less.**

Read the full design philosophy in **[ABOUT.md](ABOUT.md)**.

---

## ⚡ Overview

**SLURP** is a focused web service and developer API designed to do **one thing flawlessly**:
1. **TikTok Videos**: Extracts high-definition streams and serves clean, watermark-free `.mp4` files with sanitized filenames.
2. **TikTok Slideshows (Photo Carousels)**: Packages full-resolution images, original soundtrack audio (`.mp3`), and metadata into a clean `.zip` archive on the fly using in-memory compression.

---

## 🌟 Key Features

- **No Permanent Disk Buildup**: Media files and ZIP bundles stream directly through memory pipelines without filling server storage.
- **Smart URL Parsing**: Automatically normalizes short links (`vm.tiktok.com`, `vt.tiktok.com`), desktop URLs (`tiktok.com/@user/video/...`), photo links (`tiktok.com/@user/photo/...`), and links with tracking parameters.
- **RFC 5987 / UTF-8 Header Safety**: Prevents browser `"Site wasn't available"` download crashes by stripping non-ASCII characters and invalid HTTP header tokens.
- **Ultra-Minimalist Brutalist UI**: Dark-monolith aesthetic, fluid typography, zero ads, zero popups, and 100% mobile-responsive layout.
- **Agent-Ready Endpoints**: Simple JSON payloads and predictable streaming endpoints built for autonomous AI agents, scrapers, and automation scripts.

---

## 🤖 AI & Agent Integration

Autonomous agents and LLMs can interact directly with SLURP via HTTP without a browser.

### Agent Quickstart (cURL)
```bash
# Step 1: Resolve TikTok URL
curl -X POST http://localhost:3000/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"url":"https://vm.tiktok.com/ZMhY9fL5L/"}'

# Step 2: Download the resulting video or zip using the returned 'id'
curl -OJ http://localhost:3000/api/download/<MEDIA_ID>/video
```

### Agent Quickstart (Python)
```python
import requests

SERVER_URL = "http://localhost:3000"
tiktok_url = "https://www.tiktok.com/@creator/video/1234567890"

# Resolve
res = requests.post(f"{SERVER_URL}/api/resolve", json={"url": tiktok_url}).json()

if res.get("type") == "video":
    video_data = requests.get(f"{SERVER_URL}/api/download/{res['id']}/video").content
    with open(f"{res['id']}.mp4", "wb") as f:
        f.write(video_data)
    print("Video downloaded successfully.")
elif res.get("type") == "slideshow":
    zip_data = requests.get(f"{SERVER_URL}/api/download/{res['id']}/slideshow.zip").content
    with open(f"{res['id']}.zip", "wb") as f:
        f.write(zip_data)
    print("Slideshow ZIP downloaded successfully.")
```

---

## 📡 REST API Reference

### 1. Resolve Media Metadata
Extracts metadata, media type (`video` vs `slideshow`), author info, stats, and download session ID.

- **Endpoint**: `POST /api/resolve`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "url": "https://vm.tiktok.com/ZMhY9fL5L/"
  }
  ```
- **Response (`video` example)**:
  ```json
  {
    "success": true,
    "id": "7416827565396086021",
    "title": "Example Video Title",
    "author": {
      "name": "Creator Name",
      "username": "creator_handle",
      "avatar": "https://p16-common-sign.tiktokcdn-us.com/..."
    },
    "cover": "https://p19-common-sign.tiktokcdn-us.com/...",
    "duration": 15,
    "music": "https://v16-ies-music.tiktokcdn-us.com/...",
    "musicTitle": "Original Sound Track",
    "type": "video",
    "videoUrl": "https://www.tikwm.com/video/media/play/...",
    "hdVideoUrl": "https://www.tikwm.com/video/media/hdplay/...",
    "images": [],
    "stats": {
      "likes": 1250,
      "comments": 42,
      "shares": 19,
      "views": 25000
    }
  }
  ```
- **Response (`slideshow` example)**:
  ```json
  {
    "success": true,
    "id": "7416827565396086022",
    "title": "Photo Carousel Post",
    "type": "slideshow",
    "images": [
      "https://p16-common-sign.tiktokcdn-us.com/slide1.jpeg",
      "https://p16-common-sign.tiktokcdn-us.com/slide2.jpeg"
    ],
    "music": "https://v16-ies-music.tiktokcdn-us.com/soundtrack.mp3"
  }
  ```

---

### 2. Download Video (.mp4)
Streams the clean, watermark-free MP4 file directly to the client with attachment headers.

- **Endpoint**: `GET /api/download/:id/video`
- **Parameters**: `id` — Session ID returned from `/api/resolve`
- **Response Headers**:
  - `Content-Type: video/mp4`
  - `Content-Disposition: attachment; filename="<sanitized_title>.mp4"`

---

### 3. Download Slideshow (.zip)
Bundles all full-resolution slide images and the background audio track into a single ZIP file.

- **Endpoint**: `GET /api/download/:id/slideshow.zip`
- **Parameters**: `id` — Session ID returned from `/api/resolve`
- **Archive Contents**:
  - `slide_01.jpg`, `slide_02.jpg`, ... (Full-res images)
  - `soundtrack.mp3` (Original audio track)
  - `info.txt` (Metadata and title)
- **Response Headers**:
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="<sanitized_title>.zip"`

---

### 4. Dynamic ZIP Stream (POST)
Directly create a ZIP archive from an arbitrary list of image URLs and audio source.

- **Endpoint**: `POST /api/stream/slideshow-zip`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "images": [
      "https://example.com/image1.jpg",
      "https://example.com/image2.jpg"
    ],
    "title": "custom_archive_name",
    "musicUrl": "https://example.com/audio.mp3"
  }
  ```
- **Response**: Binary streaming `application/zip` stream.

---

## 🏗️ Architecture & Tech Stack

```
                               ┌─────────────────────────────┐
                               │   User Browser / AI Agent   │
                               └──────────────┬──────────────┘
                                              │ HTTP JSON / Stream
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXPRESS BACKEND                                │
│                                                                             │
│  POST /api/resolve ───► Clean URL ───► Upstream TikWM / Scraper CDN         │
│                                              │                              │
│                                              ▼                              │
│                                  In-Memory Session Cache                    │
│                                              │                              │
│  GET /api/download/:id/video ────────► Stream MP4 Pipe (No Watermark)       │
│  GET /api/download/:id/slideshow.zip ─► Archiver Streaming ZIP Pipeline     │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Backend**: Node.js, Express, Axios, Archiver
- **Frontend**: Vanilla ES6 JavaScript, HTML5, CSS Variables, Web Audio API
- **Memory Safety**: Automated 30-minute session cleanup timer

---

## 📁 Project Directory Tree

```
slurp/
├── .gitignore            # Git exclusion rules
├── package.json          # Node dependencies & project metadata
├── package-lock.json     # Dependency lockfile
├── README.md             # Documentation
├── server.js             # Express application & streaming controller
└── public/
    ├── index.html        # Minimalist single-page interface
    ├── style.css         # Dark brutalist design system & responsive layout
    └── app.js            # Frontend controller, clipboard hook & download triggers
```

---

## 💻 Local Setup & Installation

### Prerequisites
- Node.js `v18.0.0` or higher
- npm `v9.0.0` or higher

### Steps
1. **Clone the repository**:
   ```bash
   git clone https://github.com/yazanTah/slurp.git
   cd slurp
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

4. **Open in browser**:
   Navigate to `http://localhost:3000`.

---

## 🚀 Deployment & Custom Domains

SLURP binds to `0.0.0.0` and uses `process.env.PORT`, making it 100% cloud-ready for instant deployment on any platform:

### 1. Render / Railway / Fly.io
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**: `PORT` (automatically assigned)

### 2. Linux VPS (Ubuntu/Debian) with PM2
```bash
git clone https://github.com/yazanTah/slurp.git
cd slurp
npm install
npx pm2 start server.js --name "slurp"
npx pm2 startup
npx pm2 save
```

### 3. Reverse Proxy (Nginx Config Snippet)
```nginx
server {
    server_name slurp.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## ⌨️ UX & Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>V</kbd> / <kbd>Cmd</kbd> + <kbd>V</kbd> | Paste link from clipboard anywhere on screen and trigger auto-download |
| <kbd>Enter</kbd> | Submit input field |
| <kbd>Esc</kbd> | Reset interface to clean state |

---

## ⚖️ Disclaimer & License

- **Disclaimer**: This tool is intended for personal archiving and fair-use content backup. Always respect copyright and creator rights.
- **License**: [MIT License](LICENSE) — free for personal and commercial modification.
