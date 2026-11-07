# Hosting

The backend (API, database, router sync, Paystack webhooks) is a Cloudflare Worker + D1 and must stay on Cloudflare.

## Option A - everything on Cloudflare (simplest)
`npx wrangler deploy`, or connect the GitHub repo under Workers & Pages -> cesspro-wifi -> Settings -> Builds.

## Option B - pages on Vercel
`vercel.json` serves `public/` and forwards `/api` to the Worker.
- Vercel project settings: Framework Preset "Other", Build Command empty, Output Directory `public`.
- Keep the Worker deployed on Cloudflare; the router, Paystack webhooks and the database all point at it.
- If your WiFi sign-in pages are served over https, add their origin to the `PORTAL_ORIGINS` variable
  (comma-separated) so they are not asked to sign in. Plain http portals need nothing.
- If you change the Worker address, change it in `vercel.json` too.
