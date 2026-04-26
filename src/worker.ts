/**
 * robworks-contact — Cloudflare Worker that receives contact-form submissions
 * from code.robworks.info and forwards them via Resend.
 *
 * POST /api/contact   { name, email, project_type, message, website }
 *   → 200 { ok: true, id }
 *   → 400 { ok: false, error: "validation"|"honeypot" }
 *   → 405 { ok: false, error: "method" }
 *   → 429 { ok: false, error: "rate_limit" }
 *   → 502 { ok: false, error: "upstream" }
 */

interface Env {
  RESEND_API_KEY: string;
  CONTACT_RATELIMIT: KVNamespace;
}

const ALLOWED_ORIGIN = "https://code.robworks.info";
const FROM = "Robworks Code <contact@robworks.info>";
const TO = "ringo380@gmail.com";
const RATE_LIMIT_PER_HOUR = 5;

const PROJECT_TYPES = new Set([
  "product-engineering",
  "ai-integrations",
  "technical-consulting",
  "maintenance-retainers",
  "other",
]);

const PROJECT_LABELS: Record<string, string> = {
  "product-engineering": "Product engineering",
  "ai-integrations": "AI integrations",
  "technical-consulting": "Technical consulting",
  "maintenance-retainers": "Maintenance & retainers",
  "other": "Other / not sure",
};

function corsHeaders(origin: string | null): Record<string, string> {
  // Echo only our allow-listed origin; never reflect arbitrary origins.
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

interface ContactBody {
  name: unknown;
  email: unknown;
  project_type: unknown;
  message: unknown;
  website: unknown;
}

interface ContactData {
  name: string;
  email: string;
  project_type: string;
  message: string;
}

function validate(body: ContactBody): { ok: true; data: ContactData } | { ok: false; reason: string } {
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: false, reason: "honeypot" };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const project_type = typeof body.project_type === "string" ? body.project_type : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (name.length < 1 || name.length > 120) return { ok: false, reason: "name" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { ok: false, reason: "email" };
  if (!PROJECT_TYPES.has(project_type)) return { ok: false, reason: "project_type" };
  if (message.length < 10 || message.length > 4000) return { ok: false, reason: "message" };

  return { ok: true, data: { name, email, project_type, message } };
}

async function rateLimitExceeded(env: Env, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
  const raw = await env.CONTACT_RATELIMIT.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_PER_HOUR) return true;
  // 1-hour rolling counter; refresh TTL on each write so a burst extends the window.
  await env.CONTACT_RATELIMIT.put(key, String(count + 1), { expirationTtl: 3600 });
  return false;
}

function buildEmail(d: ContactData) {
  const projectLabel = PROJECT_LABELS[d.project_type] ?? d.project_type;
  const subject = `[robworks/code] ${projectLabel}: ${d.name}`;
  const text = [
    `New contact form submission from code.robworks.info`,
    ``,
    `Name:         ${d.name}`,
    `Email:        ${d.email}`,
    `Project type: ${projectLabel}`,
    ``,
    `--- Message ---`,
    ``,
    d.message,
    ``,
    `---`,
    `Reply directly to this email to respond.`,
  ].join("\n");
  return { subject, text };
}

async function sendViaResend(env: Env, d: ContactData): Promise<{ ok: true; id: string } | { ok: false; status: number; detail: string }> {
  const { subject, text } = buildEmail(d);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      reply_to: d.email,
      subject,
      text,
      tags: [{ name: "source", value: "code-robworks-info-contact" }],
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, detail: bodyText.slice(0, 200) };
  }
  let parsed: { id?: string } = {};
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* ignore — Resend should always return JSON on 200 */
  }
  return { ok: true, id: parsed.id ?? "unknown" };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/api/contact") {
      return json({ ok: false, error: "not_found" }, 404, origin);
    }

    if (req.method !== "POST") {
      return json({ ok: false, error: "method" }, 405, origin);
    }

    let body: ContactBody;
    try {
      body = (await req.json()) as ContactBody;
    } catch {
      return json({ ok: false, error: "json" }, 400, origin);
    }

    const validation = validate(body);
    if (!validation.ok) {
      // Honeypot returns 200 to avoid signaling bots that we caught them.
      if (validation.reason === "honeypot") {
        return json({ ok: true, id: "noop" }, 200, origin);
      }
      return json({ ok: false, error: "validation", field: validation.reason }, 400, origin);
    }

    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (await rateLimitExceeded(env, ip)) {
      return json({ ok: false, error: "rate_limit" }, 429, origin);
    }

    const result = await sendViaResend(env, validation.data);
    if (!result.ok) {
      console.error(`Resend upstream error ${result.status}: ${result.detail}`);
      return json({ ok: false, error: "upstream" }, 502, origin);
    }

    return json({ ok: true, id: result.id }, 200, origin);
  },
};
