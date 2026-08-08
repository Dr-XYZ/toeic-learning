// Cloudflare Worker for TOEIC AI Tutor Cloud Storage
// Environment Variables / Secrets required:
// - TOEIC_DATA_KV: KV Namespace Binding
// - AUTH_TOKEN (Optional): Secret token for authentication

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function verifyAuth(request, env) {
  const secretToken = env.AUTH_TOKEN;
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!secretToken) {
    return { ok: true, token: token || 'default' };
  }

  const secret = secretToken.trim();
  if (
    token === secret ||
    token.startsWith(secret + ':') ||
    token.startsWith(secret + '#') ||
    token.startsWith(secret + '-') ||
    token.startsWith(secret + '_')
  ) {
    return { ok: true, token };
  }
  return { ok: false, token: '' };
}

async function getKvKey(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token || 'default');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `user_data_${hashHex.slice(0, 16)}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', time: new Date().toISOString() });
    }

    if (url.pathname === '/api/data') {
      const auth = verifyAuth(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: 'Unauthorized: Invalid token or account key' }, 401);
      }
      const kvKey = await getKvKey(auth.token);

      if (request.method === 'GET') {
        try {
          let rawData = await env.TOEIC_DATA_KV.get(kvKey);
          if (!rawData && (auth.token === (env.AUTH_TOKEN || '').trim() || auth.token === 'default')) {
            rawData = await env.TOEIC_DATA_KV.get('user_data');
          }
          if (!rawData) {
            return jsonResponse({
              version: 1,
              updatedAt: null,
              history: [],
              savedWords: [],
            });
          }
          const parsed = JSON.parse(rawData);
          return jsonResponse(parsed);
        } catch (err) {
          return jsonResponse({ error: 'Failed to read data from KV: ' + err.message }, 500);
        }
      }

      if (request.method === 'POST') {
        try {
          const body = await request.json();
          if (!body || typeof body !== 'object') {
            return jsonResponse({ error: 'Invalid payload' }, 400);
          }

          const payload = {
            version: body.version || 1,
            updatedAt: Date.now(),
            history: Array.isArray(body.history) ? body.history : [],
            savedWords: Array.isArray(body.savedWords) ? body.savedWords : [],
          };

          await env.TOEIC_DATA_KV.put(kvKey, JSON.stringify(payload));
          return jsonResponse({ success: true, updatedAt: payload.updatedAt });
        } catch (err) {
          return jsonResponse({ error: 'Failed to write data to KV: ' + err.message }, 500);
        }
      }

      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if (url.pathname === '/api/gemini') {
      const auth = verifyAuth(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: 'Unauthorized: Invalid token' }, 401);
      }
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
      }

      const clientApiKey = request.headers.get('X-Gemini-API-Key') || '';
      const apiKey = (env.GEMINI_API_KEY || clientApiKey).trim();

      if (!apiKey) {
        return jsonResponse({ error: '伺服器未設定 GEMINI_API_KEY，且未提供 API Key' }, 400);
      }

      try {
        const body = await request.json();
        const model = body.model || 'gemini-flash-latest';
        const action = body.action || 'generateContent';
        const payload = body.payload || body;

        const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}?key=${apiKey}`;

        const geminiResp = await fetch(googleUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await geminiResp.json();
        return jsonResponse(data, geminiResp.status);
      } catch (err) {
        return jsonResponse({ error: 'Cloudflare Gemini proxy 錯誤: ' + err.message }, 500);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
