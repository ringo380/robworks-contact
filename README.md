# robworks-contact

Cloudflare Worker that receives contact-form submissions from [code.robworks.info](https://code.robworks.info/#contact) and forwards them to ringo380@gmail.com via [Resend](https://resend.com).

Endpoint (production): `https://contact.robworks.info/api/contact`

## API

### `POST /api/contact`

```json
{
  "name": "...",
  "email": "...",
  "project_type": "product-engineering | ai-integrations | technical-consulting | maintenance-retainers | other",
  "message": "...",
  "website": ""
}
```

`website` is a honeypot — must be empty. Bots fill it; humans never see it.

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ ok: true, id }` | Sent (or silently dropped honeypot) |
| 400 | `{ ok: false, error: "validation", field }` | Bad input |
| 405 | `{ ok: false, error: "method" }` | Wrong method on `/api/contact` |
| 429 | `{ ok: false, error: "rate_limit" }` | More than 5 submits per hour from this IP |
| 502 | `{ ok: false, error: "upstream" }` | Resend error |

CORS is locked to `Origin: https://code.robworks.info`.

## Setup

```bash
npm install
wrangler login

# Create the rate-limit KV namespace, paste the returned id into wrangler.jsonc
wrangler kv namespace create CONTACT_RATELIMIT

# Set the production secret
wrangler secret put RESEND_API_KEY
```

For local dev:

```bash
cp .dev.vars.example .dev.vars
# fill in a real RESEND_API_KEY
npm run dev
```

## Deploy

```bash
npm run deploy
```

The first deploy lands at `robworks-contact.<account>.workers.dev`. After the
custom-domain CNAME (`contact.robworks.info → robworks-contact.<account>.workers.dev`)
resolves on the Namecheap zone, uncomment the `routes` entry in `wrangler.jsonc`
and re-run `npm run deploy` to bind the custom domain.

## Logs

```bash
npm run tail
```

## Environment

- `RESEND_API_KEY` — Resend API key with sending access scoped to `robworks.info` (set via `wrangler secret put`, NOT in `wrangler.jsonc`).
- `CONTACT_RATELIMIT` — KV namespace binding declared in `wrangler.jsonc`.

## Email

- **From:** `Robworks Code <contact@robworks.info>` — domain must be verified in Resend.
- **To:** `ringo380@gmail.com`
- **Reply-To:** the submitter's email (so replying from your inbox replies to them).
- **Subject:** `[robworks/code] <project type>: <name>`
- **Body:** plain-text only.
