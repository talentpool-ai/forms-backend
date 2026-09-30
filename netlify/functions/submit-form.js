const fetch = require("node-fetch");
const { PostHog } = require('posthog-node');
const OpenAI = require('openai');

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

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_URL ? { baseURL: process.env.OPENAI_URL } : {}),
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

// Helper: derive company insights (hiring_type, size, industry) from email domain via OpenAI client
// Retries up to 3 total attempts if the response is missing or in an invalid format
async function getCompanyInsightsFromDomain(domain) {
  if (!process.env.OPENAI_API_KEY || !domain) {
    console.warn("⚠️ Skipping AI insights: Missing OPENAI_API_KEY or domain");
    return { hiring_type: "", size: null, industry: "" };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const prompt = `Based on the company email domain "${domain}", determine:
1. "hiring_type": Company's primary hiring focus. Strictly choose either "Tech" or "Non-Tech".
2. "size": Estimated total number of employees in the company. Strictly return a single number (integer) representing headcount.
3. "industry": The industry/sector the company operates in (e.g., "Information Technology", "Financial Services", "Healthcare", "E-commerce", "Manufacturing", etc.).

If no information is found about the company/domain, or if it is ambiguous/unknown even after evaluation, default to:
{
  "hiring_type": "Non-Tech",
  "size": 0,
  "industry": "Unknown"
}

Respond strictly with a JSON object in this format, with no markdown or other text:
{
  "hiring_type": "Tech",
  "size": 50,
  "industry": "Information Technology"
}`;

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a business intelligence assistant that analyzes company domains and returns structured JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response content from OpenAI");
      }

      const parsed = JSON.parse(content);

      // Validate required format:
      // hiring_type must be "Tech" or "Non-Tech"
      // size must be a valid number
      const hiringTypeValid = parsed.hiring_type === "Tech" || parsed.hiring_type === "Non-Tech";
      const parsedSize = typeof parsed.size === "number" ? parsed.size : parseInt(parsed.size, 10);
      const sizeValid = typeof parsedSize === "number" && !Number.isNaN(parsedSize);

      if (!hiringTypeValid || !sizeValid) {
        throw new Error(
          `Invalid format received from AI (attempt ${attempt}/${MAX_RETRIES}): hiring_type=${parsed.hiring_type}, size=${parsed.size}`
        );
      }

      return {
        hiring_type: parsed.hiring_type,
        size: parsedSize,
        industry: parsed.industry || "",
      };
    } catch (err) {
      console.warn(`⚠️ AI insights attempt ${attempt}/${MAX_RETRIES} failed:`, err.message || err);
      if (attempt === MAX_RETRIES) {
        console.error(`❌ Failed to get valid company insights after ${MAX_RETRIES} attempts.`);
        return { hiring_type: "", size: null, industry: "" };
      }
      // Brief pause before next retry
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  return { hiring_type: "", size: null, industry: "" };
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
    company_size: submission.companySize !== undefined ? submission.companySize : (submission.company_size || null),
    industry: submission.industry || "",
    timezone: submission.timezone,
    whitepaper_title: submission.whitepaper_title || "",
    utm: submission.utmParams || {},
    date,
    time,
    gclid: submission.gclid || "",
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

// Update role + hiring challenge (pain point) on the onboard signup record when they change.
async function updateSurveyDetailsOnTalentpool({ email, role, hiringChallenge }) {
  if (!email || (!role && !hiringChallenge)) {
    return;
  }

  const payload = { businessEmail: email };
  if (role) payload.role = role;
  if (hiringChallenge) payload.hiringChallenge = hiringChallenge;

  console.log("Talentpool survey-details API called", payload);

  const resp = await fetch("https://demo.thetalentpool.co.in/onboard/tenant/survey-details", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.TALENTPOOL_AUTH_HEADER,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  console.log("Talentpool survey-details response:", resp.status, text);

  if (!resp.ok) {
    throw new Error(`Survey details update failed: ${resp.status} ${text}`);
  }
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
      size,
      timezone,
      utmParams,
      form_type,
      role,
      reason,
      hiring_challenge,
      hiringChallenge,
      gclid
    } = data;

    // Survey update path: persist role + hiring challenge whenever they change/are submitted.
    const painPoint = hiringChallenge || hiring_challenge || reason || "";
    const isSurveyUpdate =
      form_type === "onboarding_survey" ||
      Boolean(role || painPoint);

    if (isSurveyUpdate && email && (role || painPoint) && !full_name && !size) {
      try {
        await updateSurveyDetailsOnTalentpool({
          email,
          role,
          hiringChallenge: painPoint,
        });
      } catch (surveyErr) {
        console.error("Failed to update survey details on Talentpool:", surveyErr);
        return {
          statusCode: 500,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
          },
          body: JSON.stringify({ error: "Failed to update survey details" }),
        };
      }

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
        },
        body: JSON.stringify({ updated: true }),
      };
    }


    // Org identity comes from the work email domain (Company field removed).
    const emailDomain = getEmailDomain(email);

    // Derive company insights (hiring_type, companySize, industry) from domain via AI
    let resolvedHiringType = null;
    let resolvedCompanySize = null;
    let resolvedIndustry = "";

    const insights = await getCompanyInsightsFromDomain(emailDomain);
    resolvedHiringType = insights.hiring_type || "";
    resolvedCompanySize = insights.size;
    resolvedIndustry = insights.industry || "";

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
        hiring_type: resolvedHiringType,
        size,
        companySize: resolvedCompanySize,
        industry: resolvedIndustry,
        timezone,
        whitepaper_title: "",
        utmParams,
        gclid
      });

      // PostHog tracking ONLY for small leads
      await posthog.identify({
        distinctId: email,
        properties: {
          email: email,
          full_name: full_name,
          phone: phone,
          company: emailDomain,        // derived from email domain
          industry: resolvedIndustry,
          hiring_type: resolvedHiringType,
          size,
          companySize: resolvedCompanySize,
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
          companySize: resolvedCompanySize,
          hiring_type: resolvedHiringType,
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
        title: resolvedHiringType ? `${emailDomain} (${resolvedHiringType})` : emailDomain,
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
      hiring_type: resolvedHiringType,
      size,
      companySize: resolvedCompanySize,
      industry: resolvedIndustry,
      timezone,
      whitepaper_title: "",
      utmParams,
      gclid
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
