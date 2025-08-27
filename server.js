const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AbortController = require('abort-controller');

const app = express();
const port = process.env.PORT || 8787;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Key', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const DEFAULT_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'cache-control': 'no-cache',
  'content-type': 'application/json',
  'origin': 'https://iframe.y2meta-uk.com',
  'pragma': 'no-cache',
  'priority': 'u=1, i',
  'referer': 'https://iframe.y2meta-uk.com/',
  'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'
];

const PRESETS = {
  mp4: [1080, 720, 360, 240, 144],
  mp3: [320, 128]
};

function normalizeYouTubeLink(link) {
  if (!link) return null;
  const r = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|shorts\/|embed\/)?([A-Za-z0-9_-]{11})(\?.*)?$/;
  const m = String(link).match(r);
  return m ? String(link) : null;
}

async function fetchCookies() {
  const apiBase = process.env.API_BASE || 'https://www.mp3youtube.cc';
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  try {
    const resp = await fetch(apiBase, {
      headers: { ...DEFAULT_HEADERS, 'user-agent': userAgent }
    });
    const setCookie = resp.headers.get('set-cookie');
    const cookies = setCookie ? setCookie.split(',').map(c => c.split(';')[0]).join('; ') : '';
    return cookies;
  } catch (err) {
    return '';
  }
}

// Simple in-memory cache for API key with TTL
let cachedKey = null;
let cachedKeyExpiresAt = 0;

async function fetchKey() {
  if (process.env.API_KEY) {
    return process.env.API_KEY;
  }
  const now = Date.now();
  if (cachedKey && now < cachedKeyExpiresAt) {
    return cachedKey;
  }

  const maxRetries = 5;
  const apiBase = process.env.API_BASE || 'https://api.mp3youtube.cc';
  const cookies = await fetchCookies();
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const headers = {
        ...DEFAULT_HEADERS,
        'user-agent': userAgent,
        'cookie': cookies || undefined
      };

      const resp = await fetch(`${apiBase}/v2/sanity/key`, {
        headers,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Failed to fetch key: ${resp.status} - ${text}`);
      }

      const data = await resp.json();
      if (!data.key) {
        throw new Error('No key in API response');
      }

      cachedKey = data.key;
      cachedKeyExpiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
      return data.key;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = 5000 + Math.random() * 2000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function callConvert(params) {
  const key = await fetchKey();
  const apiBase = process.env.API_BASE || 'https://api.mp3youtube.cc';
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const cookies = await fetchCookies();
  const payload = new URLSearchParams({
    link: params.link,
    format: params.format || 'mp4',
    audioBitrate: String(params.audioBitrate ?? 128),
    videoQuality: String(params.videoQuality ?? 1080),
    filenameStyle: params.filenameStyle || 'pretty',
    vCodec: params.vCodec || 'h264'
  });

  const maxRetries = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${apiBase}/v2/converter`, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': userAgent,
          'cookie': cookies || undefined,
          key
        },
        body: payload
      });
      const data = await resp.json();
      return { status: resp.status, data };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = 5000 + Math.random() * 2000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

app.get('/', (req, res) => {
  res.json({ presets: PRESETS });
});

app.get('/presets', (req, res) => {
  res.json({ presets: PRESETS });
});

app.get('/key', async (req, res) => {
  try {
    const key = await fetchKey();
    res.json({ key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/convert', async (req, res) => {
  try {
    const body = Object.assign({}, req.body, req.query);
    const link = normalizeYouTubeLink(body.link || body.url);
    if (!link) {
      return res.status(400).json({ error: 'Invalid or missing YouTube link' });
    }
    if (body.format && !PRESETS[body.format]?.includes(Number(body.videoQuality || body.audioBitrate))) {
      return res.status(400).json({ error: `Invalid quality for format ${body.format}` });
    }
    const { status, data } = await callConvert({
      link,
      format: body.format || 'mp4',
      audioBitrate: body.audioBitrate ? Number(body.audioBitrate) : 128,
      videoQuality: body.videoQuality ? Number(body.videoQuality) : 1080,
      filenameStyle: body.filenameStyle || 'pretty',
      vCodec: body.vCodec || 'h264'
    });
    res.status(status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/download', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing url' });
    }
    const upstream = await fetch(targetUrl, {
      headers: {
        Range: req.headers['range'] || undefined,
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      }
    });

    // Pipe headers
    res.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.set('content-length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.set('content-range', contentRange);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) res.set('accept-ranges', acceptRanges);

    res.status(upstream.status);
    if (upstream.body && upstream.body.pipe) {
      upstream.body.pipe(res);
    } else {
      const buffer = await upstream.buffer();
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});


