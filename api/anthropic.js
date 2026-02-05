/**
 * Quick Quiz API Proxy (Vercel Serverless Function)
 *
 * Handles API requests to Anthropic with:
 * - Server-side API key storage (never exposed to browser)
 * - Rate limiting per user (fingerprint + IP) via Upstash Redis
 * - 10 requests per day per user
 */

import { Redis } from '@upstash/redis';

const DAILY_LIMIT = 10;

function getRedis() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return null;
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-ID');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get client identifier (fingerprint + IP)
  const clientId = req.headers['x-client-id'] || 'unknown';
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const identifier = `${clientId}:${clientIP}`;

  // Check rate limit
  const today = new Date().toISOString().split('T')[0];
  const key = `usage:${identifier}:${today}`;
  const redis = getRedis();

  let currentUsage = 0;
  if (redis) {
    try {
      currentUsage = parseInt(await redis.get(key) || '0');
    } catch (e) {
      console.error('Redis read error:', e);
    }
  }

  if (currentUsage >= DAILY_LIMIT) {
    return res.status(429)
      .setHeader('X-RateLimit-Limit', DAILY_LIMIT.toString())
      .setHeader('X-RateLimit-Remaining', '0')
      .json({
        error: {
          type: 'rate_limit_exceeded',
          message: `Daily limit of ${DAILY_LIMIT} quizzes reached. Please try again tomorrow.`,
          limit: DAILY_LIMIT,
          used: currentUsage,
          resets: 'midnight UTC'
        }
      });
  }

  // Forward request to Anthropic
  let anthropicResponse;
  try {
    anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body)
    });
  } catch (e) {
    console.error('Anthropic API error:', e);
    return res.status(502).json({ error: 'Failed to reach API' });
  }

  // Only increment usage on successful API calls
  if (anthropicResponse.ok && redis) {
    try {
      await redis.set(key, currentUsage + 1, { ex: 86400 });
    } catch (e) {
      console.error('Redis write error:', e);
    }
  }

  // Return response with rate limit headers
  const responseBody = await anthropicResponse.text();
  const remaining = DAILY_LIMIT - currentUsage - 1;

  res.setHeader('X-RateLimit-Limit', DAILY_LIMIT.toString());
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining).toString());
  return res.status(anthropicResponse.status).send(responseBody);
}
