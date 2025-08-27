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

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Key,Range',
  'access-control-expose-headers': 'Content-Length,Content-Range,Accept-Ranges',
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...(init.headers || {}) },
    status: init.status || 200
  });
}

function badRequest(message, status = 400) {
  return json({ error: message }, { status });
}

function withCORS(resp) {
  const headers = new Headers(resp.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(resp.body, { status: resp.status, headers });
}

function normalizeYouTubeLink(link) {
  if (!link) return null;
  const r = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|shorts\/|embed\/)?([A-Za-z0-9_-]{11})(\?.*)?$/;
  const m = link.match(r);
  return m ? link : null;
}

async function fetchCookies(env) {
  const apiBase = env.API_BASE || 'https://www.mp3youtube.cc';
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  try {
    const resp = await fetch(apiBase, {
      headers: { ...DEFAULT_HEADERS, 'user-agent': userAgent }
    });
    const cookies = resp.headers.get('set-cookie')?.split(',').map(c => c.split(';')[0]).join('; ') || '';
    console.log(`Fetched cookies: ${cookies}`);
    return cookies;
  } catch (err) {
    console.error(`fetchCookies Error: ${err.message}`);
    return '';
  }
}

async function fetchKey(env) {
  // Priority 1: Use env.API_KEY
  if (env.API_KEY) {
    console.log('Using environment API key');
    return env.API_KEY;
  }

  // Priority 2: Use KV cache
  if (env.KV_NAMESPACE) {
    const cachedKey = await env.KV_NAMESPACE.get('api_key');
    if (cachedKey) {
      console.log('Using cached API key');
      return cachedKey;
    }
  }

  // Priority 3: Fetch key (likely to fail)
  const maxRetries = 5;
  let lastError;
  const apiBase = env.API_BASE || 'https://api.mp3youtube.cc';
  const cookies = await fetchCookies(env);

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
      console.log(`fetchKey Attempt ${attempt}, Status: ${resp.status}, Ray ID: ${resp.headers.get('cf-ray') || 'none'}`);

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`fetchKey Error: Status ${resp.status}, Body: ${errorText}`);
        throw new Error(`Failed to fetch key: ${resp.status} - ${errorText}`);
      }

      const data = await resp.json();
      if (!data.key) {
        console.error('No key in response:', JSON.stringify(data));
        throw new Error('No key in API response');
      }

      if (env.KV_NAMESPACE) {
        await env.KV_NAMESPACE.put('api_key', data.key, { expirationTtl: 3600 });
        console.log('Cached API key');
      }

      return data.key;
    } catch (err) {
      lastError = err;
      console.error(`fetchKey Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const delay = 5000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function callConvert(params, env) {
  const key = await fetchKey(env);
  const apiBase = env.API_BASE || 'https://api.mp3youtube.cc';
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const cookies = await fetchCookies(env);
  const payload = new URLSearchParams({
    link: params.link,
    format: params.format || 'mp4',
    audioBitrate: String(params.audioBitrate ?? 128),
    videoQuality: String(params.videoQuality ?? 1080),
    filenameStyle: params.filenameStyle || 'pretty',
    vCodec: params.vCodec || 'h264'
  });

  // Retry for /convert to vary IPs
  const maxRetries = 3;
  let lastError;
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

      console.log(`callConvert Attempt ${attempt}, Status: ${resp.status}, Ray ID: ${resp.headers.get('cf-ray') || 'none'}`);
      const data = await resp.json();
      return { status: resp.status, data };
    } catch (err) {
      lastError = err;
      console.error(`callConvert Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        const delay = 5000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;

  // Y2Mate Fallback (uncomment to use):
  /*
  const apiBase = env.API_BASE || 'https://www.y2mate.com';
  const payload = new URLSearchParams({
    url: params.link,
    ftype: params.format || 'mp4',
    fquality: params.videoQuality ? `${params.videoQuality}p` : '720p'
  });
  const resp = await fetch(`${apiBase}/youtube/convert`, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent
    },
    body: payload
  });
  console.log(`callConvert Y2Mate Status: ${resp.status}`);
  if (!resp.ok) throw new Error(`Conversion failed: ${resp.status}`);
  const data = await resp.json();
  return { status: resp.status, data };
  */
}

function buildDownloadResponse(upstreamResponse) {
  const headers = new Headers(upstreamResponse.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

const PRESETS = {
  mp4: [1080, 720, 360, 240, 144],
  mp3: [320, 128]
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/' || pathname === '/presets') {
        return json({ presets: PRESETS });
      }

      if (pathname === '/key' && request.method === 'GET') {
        const key = await fetchKey(env);
        return json({ key });
      }

      if (pathname === '/convert' && request.method === 'POST') {
        let body = {};
        if (request.headers.get('content-type')?.includes('application/json')) {
          body = await request.json();
        } else if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
          const form = await request.formData();
          form.forEach((v, k) => { body[k] = v; });
        } else {
          searchParams.forEach((v, k) => { body[k] = v; });
        }

        const link = normalizeYouTubeLink(body.link || body.url);
        if (!link) return badRequest('Invalid or missing YouTube link');

        if (body.format && !PRESETS[body.format]?.includes(Number(body.videoQuality || body.audioBitrate))) {
          return badRequest(`Invalid quality for format ${body.format}`);
        }

        const { status, data } = await callConvert({
          link,
          format: body.format || 'mp4',
          audioBitrate: body.audioBitrate ? Number(body.audioBitrate) : 128,
          videoQuality: body.videoQuality ? Number(body.videoQuality) : 1080,
          filenameStyle: body.filenameStyle || 'pretty',
          vCodec: body.vCodec || 'h264'
        }, env);
        return json(data, { status });
      }

      if (pathname === '/download' && request.method === 'GET') {
        const targetUrl = searchParams.get('url');
        if (!targetUrl) return badRequest('Missing url');

        const upstream = await fetch(targetUrl, {
          headers: {
            Range: request.headers.get('Range') || undefined,
            'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
          }
        });
        return buildDownloadResponse(upstream);
      }

      return badRequest('Not Found', 404);
    } catch (err) {
      console.error(`Handler Error: ${err.message}, Stack: ${err.stack}`);
      return json({ error: err.message }, { status: 500 });
    }
  }
};