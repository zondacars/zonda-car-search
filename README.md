# Zonda Car Search — Deploy Guide

A multi-source rare car finder. Runs on Vercel with a secure backend that keeps
your Anthropic API key hidden from the browser.

## Files
- `index.html`      → the search interface (frontend)
- `api/search.js`   → secure serverless backend (calls Anthropic + web search)

## One-time setup

### 1. Get an Anthropic API key
- Go to console.anthropic.com → sign in
- Add a payment method (Billing) — usage is pay-as-you-go, ~a few cents per search
- Create an API Key → copy it (starts with `sk-ant-...`)

### 2. Put these files in your GitHub repo
Upload BOTH `index.html` and the `api` folder (containing `search.js`)
to your `zonda-car-search` repo, keeping the folder structure.

### 3. Add the key to Vercel
- Vercel → your project → Settings → Environment Variables
- Name:  ANTHROPIC_API_KEY
- Value: (paste your sk-ant-... key)
- Save, then go to Deployments → ⋯ → Redeploy

That's it. Your live link will now search without errors.

## Notes
- The API key lives ONLY in Vercel's environment variables, never in the browser.
- Each search makes one Anthropic API call with web search enabled.
- Always click through to verify listings before acting on price/availability.
