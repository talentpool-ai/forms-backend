const fetch = require("node-fetch");
const { PostHog } = require('posthog-node');

// ✅ Allowed frontend domains
const allowedOrigins = [
  "https://dev.thetalentpool.ai",
  "https://www.thetalentpool.ai",
  "https://thetalentpool.ai",
  "http://dev-ui.thetalentpool.ai",
];

// Initialize PostHog (requires POSTHOG_API_KEY env var)
// NOTE: US cloud project — ingestion host MUST be us.i.posthog.com to match the frontend.
const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: 'https://us.i.posthog.com',
  flushAt: 1,
  flushInterval: 0
});

posthog.on('error', (error) => {
  console.error('PostHog error:', error);
});

// Helper: current date & time in IST as separate columns
function getISTDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  const time = now.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false, // HH:MM:SS
  });
  return { date, time };
}

// Helper: derive an organization name from the work email domain.
// john@acme.com -> "acme.com". Used in place of the removed Company field.
function getEmailDomain(email) {
  return (email || "").split("@")[1]?.trim().toLowerCase() || "";
}

// Helper: build redirect URL with UTM params
function buildRedirectWithUTM(path, utmParams = {}) {
  const params = new URLSearchParams();

  if (utmParams && typeof utmParams === "object") {
    Object.entries(utmParams).forEach(([key, value]) => {
      if (
        key &&
        key.startsWith("utm_") &&
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
      ) {
        params.set(key, String(value));
      }
    });
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

// Power Automate endpoint
const FLOW_URL = process.env.POWER_AUTOMATE_FLOW_URL; // store your flow URL in Netlify env vars
if (!FLOW_URL) {
  console.error("❌ Missing POWER_AUTOMATE_FLOW_URL");
}

async function forwardToPowerAutomate(submission) {
  const { date, time } = getISTDateTime();
  const payload = {
    full_name: submission.full_name,
    email: submission.email,
    phone: submission.phone,
    hiring_type: submission.hiring_type,
    size: submission.size,
    timezone: submission.timezone,
    whitepaper_title: submission.whitepaper_title || "",
    utm: submission.utmParams || {},
    date,
    time
  };

  const res = await fetch(FLOW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ Flow failed: ${res.status} ${text}`);
    throw new Error(`Flow failed: ${res.status}`);
  }

  console.log("✅ Logged to Power Automate successfully");
}

exports.handler = async (event) => {
  const requestOrigin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : "null";

  console.log(corsOrigin);

  if (corsOrigin === "null") {
    console.warn("Blocked origin:", requestOrigin);
  }

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "OK",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
      },
      body: "Method Not Allowed",
    };
  }

  try {
    const data = JSON.parse(event.body);
    const {
      full_name,
      phone,
      email,
      hiring_type,
      size,
      timezone,
      utmParams
    } = data;

    // Org identity now comes from the work email domain (Company field removed).
    const emailDomain = getEmailDomain(email);

    console.log("Talentpool API called");

    const talentpoolResp = await fetch("https://demo.thetalentpool.co.in/onboard/tenant/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: process.env.TALENTPOOL_AUTH_HEADER,
      },
      body: JSON.stringify({
        businessEmail: email,
        timeZone: timezone
      }),
    });

    const raw = await talentpoolResp.text();
    console.log(raw);

    let msg;
    try {
      const parsed = JSON.parse(raw);
      msg = parsed?.message || raw;
    } catch (err) {
      msg = raw;
    }

    if (size === "lessthan5") {
      if (msg.includes("Duplicate business email")) {
        return {
          statusCode: 200,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
          },
          body: JSON.stringify({
            error: "You are an existing user, please consider logging in!",
          }),
        };
      }

      if (msg.includes("Duplicate tenant code")) {
        return {
          statusCode: 200,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
          },
          body: JSON.stringify({
            error: "Your organization is already registered, contact your administrator!",
          }),
        };
      }

      await forwardToPowerAutomate({
        full_name,
        email,
        phone,
        hiring_type,
        size,
        timezone,
        whitepaper_title: "",
        utmParams
      });

      // PostHog tracking ONLY for small leads (size === "lessthan5")
      await posthog.identify({
        distinctId: email,
        properties: {
          email: email,
          full_name: full_name,
          phone: phone,
          company: emailDomain,        // derived from email domain
          hiring_type: hiring_type,
          size: size,
          timezone: timezone,
          lead_source: utmParams?.utm_source || 'direct',
          lead_status: 'new',
          created_at: new Date().toISOString()
        }
      });

      await posthog.capture({
        distinctId: email,
        event: 'lead_submitted',
        properties: {
          lead_id: `lead_${email}_${Date.now()}`,
          form_name: 'main_lead_form',
          size: size,
          company: emailDomain,        // derived from email domain
          hiring_type: hiring_type,
          utm_source: utmParams?.utm_source || null,
          utm_medium: utmParams?.utm_medium || null,
          utm_campaign: utmParams?.utm_campaign || null
        }
      });

      await posthog.flush();

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
        },
        body: JSON.stringify({
          redirect: buildRedirectWithUTM("/email-verification/", utmParams),
        }),
      };
    }

    // 🔁 Pipedrive Flow (no PostHog here) — organization keyed off the email domain
    const apiToken = process.env.PIPEDRIVE_API_TOKEN;
    console.log("Pipedrive API called");

    // 1. Get or create organization (by email domain)
    let orgId = null;
    const searchOrg = await fetch(
      `https://talentpool.pipedrive.com/v1/organizations/search?term=${encodeURIComponent(emailDomain)}&api_token=${apiToken}`
    );
    const orgRes = await searchOrg.json();

    if (orgRes?.data?.items?.length > 0) {
      orgId = orgRes.data.items[0].item.id;
    } else {
      const createOrg = await fetch(
        `https://talentpool.pipedrive.com/v1/organizations?api_token=${apiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: emailDomain }),
        }
      );
      const orgData = await createOrg.json();
      orgId = orgData?.data?.id;
    }

    // 2. Get or create person
    let personId = null;
    const searchPerson = await fetch(
      `https://talentpool.pipedrive.com/v1/persons/search?term=${encodeURIComponent(email)}&api_token=${apiToken}`
    );
    const personRes = await searchPerson.json();

    if (personRes?.data?.items?.length > 0) {
      personId = personRes.data.items[0].item.id;
    } else {
      const createPerson = await fetch(
        `https://talentpool.pipedrive.com/v1/persons?api_token=${apiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: full_name,
            email: [{ value: email, primary: true, label: "work" }],
            phone: [{ value: phone, primary: true, label: "work" }],
          }),
        }
      );
      const personData = await createPerson.json();
      personId = personData?.data?.id;
    }

    // 3. Create lead (title = email domain, hiring type appended for quick context)
    await fetch(`https://talentpool.pipedrive.com/v1/leads?api_token=${apiToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: hiring_type ? `${emailDomain} (${hiring_type})` : emailDomain,
        person_id: personId,
        organization_id: orgId,
      }),
    });

    // 4. Send EmailJS
    await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_TEMPLATE_ID,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        template_params: {
          email,
          phone,
        },
      }),
    });

    await forwardToPowerAutomate({
      full_name,
      email,
      phone,
      hiring_type,
      size,
      timezone,
      whitepaper_title: "",
      utmParams
    });

    // ❌ No PostHog here for non-small leads

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
      },
      body: JSON.stringify({
        redirect: buildRedirectWithUTM("/thank-you-2/", utmParams),
      }),
    };
  } catch (err) {
    console.error("Error in Netlify Function:", err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
      },
      body: JSON.stringify({ error: "Something went wrong" }),
    };
  }
};
