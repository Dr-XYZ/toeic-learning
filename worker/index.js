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
  if (!secretToken) return true; // If no secret configured, allow access
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token === secretToken.trim();
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
      if (!verifyAuth(request, env)) {
        return jsonResponse({ error: 'Unauthorized: Invalid token' }, 401);
      }

      if (request.method === 'GET') {
        try {
          const rawData = await env.TOEIC_DATA_KV.get('user_data');
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

          await env.TOEIC_DATA_KV.put('user_data', JSON.stringify(payload));
          return jsonResponse({ success: true, updatedAt: payload.updatedAt });
        } catch (err) {
          return jsonResponse({ error: 'Failed to write data to KV: ' + err.message }, 500);
        }
      }

      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
