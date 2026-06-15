// Vercel Serverless Function — /api/search
// Holds the Anthropic API key securely (server-side) and runs the search.
// The browser NEVER sees the key.

// Allow up to 60s on Vercel (Hobby max) so the deep multi-search has time to finish.
export const maxDuration = 60;

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

Do MANY targeted web searches across these sources to find as many real matches as possible: ${srcList}. Search each promising source specifically (e.g. site-specific searches), not just one broad query.

CRITICAL — INDIVIDUAL CAR PAGES ONLY:
- Every result MUST link to a SINGLE specific vehicle's own listing page (one car, its own price, photos, and description).
- REJECT and never return: search results pages, category/browse pages, "X cars for sale" roundup pages, filtered-list URLs, dealer inventory index pages, or auction "results" archives. If a URL contains things like /search, /results, ?make=, ?model=, /cars-for-sale (with no specific vehicle), /inventory (index), it is NOT a valid result.
- A valid listing URL points at one car — typically with a unique listing/stock/item ID or a specific car slug in the path (e.g. .../listing/2023-dodge-challenger-srt-hellcat-12345 or an eBay item number).
- If you only find a search/category page for a source, do NOT include it — open through to the individual cars, or skip that source.

Treat AVAILABILITY and PRICE as separate. Three price states:
1. For sale WITH a price -> include, put price in "price".
2. For sale but "Call for price" / "Inquire" / "POA" -> INCLUDE, put "Call for price" in "price". These are live cars.
3. SOLD / ended auction / withdrawn / no longer available -> EXCLUDE.

OTHER RULES:
- Only real listings grounded in actual search results, each with a real individual-listing URL. NEVER invent URLs, prices, listings, or images. Never pad to reach a count.
- For "image", include a direct image URL only if one appears in results; otherwise null.${mileageRule}

Return ONLY a valid JSON array (no markdown, no commentary). Each object:
{
  "title": "full listing title",
  "source": "platform name",
  "price": "asking price string, or 'Call for price'",
  "mileage": "mileage string or null",
  "location": "city/state or null",
  "condition": "one-word condition or null",
  "description": "1-2 sentence highlight of key specs and condition",
  "url": "real INDIVIDUAL listing URL (never a search/category page)",
  "image": "direct image URL from results, or null"
}

Aim for up to 20 currently-available individual listings when they genuinely exist. Real ones only. Return [] if none found.`;

    const callAnthropic = async () => {
      // abort before the 60s function limit (set via maxDuration below) so we can return a clean error
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55000);
      try {
        return await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 6000,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    // retry transient upstream failures (503/529/502) a couple of times
    let anthropicResp;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        anthropicResp = await callAnthropic();
        if (anthropicResp.ok) break;
        if (![502, 503, 529].includes(anthropicResp.status)) break; // non-transient: stop
      } catch (e) {
        lastErr = e; // network/abort error — retry
      }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1))); // brief backoff
    }

    if (!anthropicResp) {
      return res.status(504).json({ error: 'The search took too long or the connection dropped. Please try again — narrowing the search (fewer sources) also helps.' });
    }

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

    // drop aggregator search/category pages and url-less results; require an individual listing URL
    const looksLikeIndexPage = (u) => {
      if (!u) return true;
      const s = String(u).toLowerCase();
      const signals = [
        '/search', '/results', 'shopping/results', '/cars-for-sale/all',
        '?make=', '&make=', '?model=', '&model=', 'keyword=', 'searchradius',
        'zip=', 'sortby=', 'page=', '/auctions/results', '/listings?'
      ];
      if (signals.some(sig => s.includes(sig))) return true;
      if (/\/cars-for-sale\/?$/.test(s)) return true;   // bare category page
      if (/\/listings\/?$/.test(s)) return true;
      if (/\/inventory\/?$/.test(s)) return true;        // dealer inventory index
      return false;
    };
    listings = listings.filter(it => it && it.url && !looksLikeIndexPage(it.url));

    // dedupe by normalized URL
    const seen = new Set();
    listings = listings.filter(it => {
      const key = String(it.url).split('?')[0].replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ listings });

  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + (err.message || 'unknown error') });
  }
}
