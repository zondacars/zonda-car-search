// Vercel Serverless Function — /api/search
// Holds the Anthropic API key securely (server-side) and runs the search.
// The browser NEVER sees the key.

export default async function handler(req, res) {
  // CORS (so coworkers on any device can use it)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured: ANTHROPIC_API_KEY is missing in Vercel environment variables.' });
  }

  try {
    const { query, sources, maxMiles } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing search query.' });

    const srcList = Array.isArray(sources) && sources.length
      ? sources.join(', ')
      : 'all major classic car marketplaces';

    const mileageRule = maxMiles
      ? `\n- ONLY include cars with ${Number(maxMiles).toLocaleString()} miles or fewer. Exclude anything clearly above that.`
      : '';

    const prompt = `You are a classic and rare car listing search engine. The user is searching for this car: "${query}".

Use web search to find REAL, CURRENTLY-FOR-SALE listings for this exact car across sources like: ${srcList}.

STRICT RULES:
- ONLY include cars that are CURRENTLY FOR SALE. Do NOT include sold listings, ended/past auctions, or sold price comps under any circumstances.
- Only include listings you can ground in actual web search results, each with a REAL direct listing URL from those results.
- NEVER invent URLs, prices, listings, or images. If you find none, return an empty array.
- For "image", include a direct image URL ONLY if one appears in the search results; otherwise null. Never guess an image URL.
- Prefer the rarest / closest matches to the requested trim.${mileageRule}

Return ONLY a valid JSON array (no markdown fences, no commentary). Each object:
{
  "title": "full listing title",
  "source": "platform name",
  "price": "current asking price string, or null",
  "mileage": "mileage string or null",
  "location": "city/state or null",
  "condition": "one-word condition or null",
  "description": "1-2 sentence highlight of key specs and condition",
  "url": "real direct listing URL from search results, or null",
  "image": "direct image URL from results, or null"
}

Aim for up to 10 active listings. Return [] if none found.`;

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      return res.status(anthropicResp.status).json({
        error: `Anthropic API error (${anthropicResp.status}). ${
          anthropicResp.status === 401 ? 'Check your API key.' :
          anthropicResp.status === 429 ? 'Rate limit or out of credits.' :
          errText.slice(0, 200)
        }`
      });
    }

    const data = await anthropicResp.json();
    const raw = (data.content || [])
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('');

    // pull the JSON array out of the response
    const match = raw.match(/\[[\s\S]*\]/);
    let listings = [];
    if (match) {
      try { listings = JSON.parse(match[0]); } catch (e) { listings = []; }
    }

    // server-side safety net: strip any sold/ended listings
    listings = listings.filter(it => {
      const blob = `${(it && it.price) || ''} ${(it && it.condition) || ''} ${(it && it.title) || ''}`.toLowerCase();
      return !/(sold|no longer available|auction ended|ended:)/.test(blob);
    });

    return res.status(200).json({ listings });

  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + (err.message || 'unknown error') });
  }
}
