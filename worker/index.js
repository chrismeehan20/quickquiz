/**
 * Quick Quiz API Proxy Worker
 *
 * Handles API requests to Anthropic with:
 * - Server-side API key storage (never exposed to browser)
 * - Rate limiting per user (fingerprint + IP)
 * - 10 requests per day per user
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only handle /api/anthropic endpoint
    if (!url.pathname.startsWith('/api/anthropic')) {
      return env.ASSETS.fetch(request);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get client identifier (fingerprint + IP)
    const clientId = request.headers.get('X-Client-ID') || 'unknown';
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const identifier = `${clientId}:${clientIP}`;

    // Check rate limit
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const key = `usage:${identifier}:${today}`;

    let currentUsage = 0;
    try {
      currentUsage = parseInt(await env.RATE_LIMIT_KV.get(key) || '0');
    } catch (e) {
      console.error('KV read error:', e);
    }

    const DAILY_LIMIT = 10;

    if (currentUsage >= DAILY_LIMIT) {
      return new Response(JSON.stringify({
        error: {
          type: 'rate_limit_exceeded',
          message: `Daily limit of ${DAILY_LIMIT} quizzes reached. Please try again tomorrow.`,
          limit: DAILY_LIMIT,
          used: currentUsage,
          resets: 'midnight UTC'
        }
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-RateLimit-Limit': DAILY_LIMIT.toString(),
          'X-RateLimit-Remaining': '0',
        }
      });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Forward request to Anthropic
    let anthropicResponse;
    try {
      anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error('Anthropic API error:', e);
      return new Response(JSON.stringify({ error: 'Failed to reach API' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Only increment usage on successful API calls
    if (anthropicResponse.ok) {
      try {
        await env.RATE_LIMIT_KV.put(key, (currentUsage + 1).toString(), {
          expirationTtl: 86400 // 24 hours
        });
      } catch (e) {
        console.error('KV write error:', e);
      }
    }

    // Return response with rate limit headers
    const responseBody = await anthropicResponse.text();
    const remaining = DAILY_LIMIT - currentUsage - 1;

    return new Response(responseBody, {
      status: anthropicResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-RateLimit-Limit': DAILY_LIMIT.toString(),
        'X-RateLimit-Remaining': Math.max(0, remaining).toString(),
      }
    });
  }
};
