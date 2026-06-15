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

    // Map each selected source id to a clear phrase the search can act on.
    const SOURCE_PHRASES = {
      bat: 'Bring a Trailer (bringatrailer.com)',
      ebay: 'eBay Motors',
      hemmings: 'Hemmings (hemmings.com)',
      classiccars: 'ClassicCars.com',
      carsandbids: 'Cars & Bids (carsandbids.com)',
      cars: 'Cars.com',
      kbb: 'Kelley Blue Book Cars for Sale (kbb.com/cars-for-sale only)',
      copart: 'Copart',
      autotrader: 'AutoTrader',
      cargurus: 'CarGurus',
      facebook: 'Facebook Marketplace',
      dealerships: "individual cars for sale NATIONWIDE from: dealer & specialist dealer websites, private-seller listings, auto museums that sell cars, and collector-car sales sites. Each result must link to ONE specific car's own page — never a dealer homepage, 'our inventory' page, or browse/listing page"
    };
    const srcList = Array.isArray(sources) && sources.length
      ? sources.map(id => SOURCE_PHRASES[id] || id).join('; ')
      : 'all major classic car marketplaces and specialist dealer websites';

    const mileageRule = maxMiles
      ? `\n- ONLY include cars with ${Number(maxMiles).toLocaleString()} miles or fewer. Exclude anything clearly above that.`
      : '';

    const prompt = `You are a classic and rare car listing search engine. The user is searching for this car: "${query}".

PROCESS (follow in order):
1. Use web_search to find candidate listings across sources like: ${srcList}. Run several targeted searches.
2. For EACH promising candidate, try to use web_fetch to OPEN the actual listing page and read it.
3. From the fetched page content, KEEP a listing ONLY if it is clearly still FOR SALE right now. DISCARD it if the page shows any of: "sold", "sale pending", "no longer available", "this listing has ended", "auction ended", "bidding ended", "winning bid", a past end-date, or a 404/removed page. eBay ended auctions and sold ClassicCars pages MUST be discarded here.
4. Verification depends on the source type:
   - AUCTION / MARKETPLACE listings (eBay, Bring a Trailer, Cars & Bids, ClassicCars, Hemmings auctions, Copart, etc.): you MUST fetch and confirm the listing is active. If you cannot fetch/confirm it, DO NOT include it — these are where sold/ended listings hide.
   - DEALER / SPECIALIST SITE listings and Cars.com/CarGurus/AutoTrader/KBB dealer vehicle pages: try to fetch. But many dealer sites BLOCK automated fetching. If the fetch is blocked or fails, you may STILL include the listing as long as the search result clearly shows ONE specific car for sale (with a price or "call for price") and nothing indicates it sold. Dealers remove cars when they sell, so an unfetchable dealer vehicle page is presumed active.
   - Never include anything that actually shows sold/ended, regardless of source.

EXCLUDE these entirely (they are not live individual-car marketplaces):
- Valuation / info sites: Edmunds, NADA, JD Power, Carfax value pages.
- For Kelley Blue Book (kbb.com): its "Cars for Sale" individual listings ARE allowed, but its valuation/pricing/review pages are NOT — only include a KBB result if it's a specific car for sale (a kbb.com/cars-for-sale/ vehicle page).
- Search results pages, category/browse pages, "X cars for sale" roundups, dealer inventory index pages, dealer HOMEPAGES, and auction results archives.
Every result URL must be ONE specific car's own listing page (unique stock/item ID or specific-car slug in the path) — NEVER a dealer's homepage or "our inventory" page. For the Dealers/Museums/Collectors source, look nationwide across dealer sites, private sellers, auto museums that sell cars, and collector-car sales sites, but still return only individual specific-car pages.

INVENTORY FALLBACK (Dealers/Museums/Collectors source ONLY):
- If you genuinely cannot isolate an individual car page on a dealer/museum/collector site, you MAY instead return that dealer's INVENTORY/listing page — but ONLY if you have confirmed (by fetching it or from clear search-result evidence) that the inventory currently contains one or more cars matching the user's criteria (year/make/model/trim and the mileage cap).
- For such a result set "listingType": "inventory", and in "description" state which matching car(s) the inventory contains (e.g. "Dealer stocks a 1969 Camaro Z/28 matching your search, plus others").
- NEVER return an inventory page that does not contain a matching car, and NEVER return a homepage. This fallback applies only to dealers/museums/collectors — for eBay, BaT, Cars.com, etc. always return individual car pages.
- For individual car results (the normal case) set "listingType": "car".

PRICE STATES:
- For sale with a price -> include, put price in "price".
- For sale, "Call for price"/"Inquire"/"POA" -> include, put "Call for price" in "price".
- Sold / ended / withdrawn -> exclude (per step 3).

RULES: Never invent URLs, prices, listings, or images. Never pad to reach a count. For "image", include a direct image URL only if one appears in results; otherwise null.${mileageRule}

Return ONLY a valid JSON array (no markdown, no commentary). Each object:
{
  "title": "full listing title (or dealer name + matching car for an inventory result)",
  "source": "platform or dealer/museum name",
  "listingType": "car" for an individual car, or "inventory" for a matching dealer inventory page (dealers source only)",
  "price": "asking price string, or 'Call for price'",
  "mileage": "mileage string or null",
  "location": "city/state or null",
  "condition": "one-word condition or null",
  "description": "1-2 sentence highlight of key specs and condition",
  "url": "real INDIVIDUAL listing URL you fetched and confirmed active",
  "image": "direct image URL from results, or null"
}

Aim for up to 30 confirmed-active listings when they genuinely exist (fetch-verified for marketplaces; for dealer sites, presumed active if unfetchable per the rules above). Real ones only. Return [] if none found.`;

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
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-fetch-2025-09-10'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 7000,
            tools: [
              { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
              { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 18 }
            ],
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

    // drop aggregator search/category pages, valuation/info sites, and url-less results
    const BLOCKED_DOMAINS = ['edmunds.com', 'nadaguides.com', 'jdpower.com', 'carfax.com', 'caranddriver.com', 'motortrend.com'];
    const isAllowed = (it) => {
      if (!it || !it.url) return false;
      const s = String(it.url).toLowerCase();
      if (BLOCKED_DOMAINS.some(d => s.includes(d))) return false;            // valuation/info sites
      if (s.includes('kbb.com') && !s.includes('/cars-for-sale/')) return false;
      // always block aggregator SEARCH-results pages (query-driven), regardless of type
      const searchSignals = [
        '/search', '/results', 'shopping/results', '/cars-for-sale/all',
        '?make=', '&make=', '?model=', '&model=', 'keyword=', 'searchradius',
        'zip=', 'sortby=', 'page=', '/auctions/results', '/listings?'
      ];
      if (searchSignals.some(sig => s.includes(sig))) return false;
      // never allow a bare homepage
      let path = null;
      try { path = new URL(s).pathname.replace(/\/+$/, ''); } catch (e) { path = null; }
      if (path === '') return false;
      // bare inventory/browse pages: allowed ONLY when tagged as a matching dealer inventory result
      const bareIndex = [
        '/inventory', '/vehicles', '/cars-for-sale', '/cars', '/listings',
        '/used-cars', '/new-cars', '/preowned', '/pre-owned', '/used',
        '/showroom', '/collection', '/for-sale', '/stock', '/sold'
      ];
      const isBareIndex = (path !== null && bareIndex.includes(path))
        || /\/cars-for-sale\/?$/.test(s) || /\/listings\/?$/.test(s) || /\/inventory\/?$/.test(s);
      if (isBareIndex) return it.listingType === 'inventory';
      return true;
    };
    listings = listings.filter(isAllowed);

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
