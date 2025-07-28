const fetch = require("node-fetch");

// Allow only your frontend origin
const allowedOrigin = [
  "https://dev.thetalentpool.ai",
  "https://www.thetalentpool.ai",
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
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
        "Access-Control-Allow-Origin": allowedOrigin,
      },
      body: "Method Not Allowed",
    };
  }

  try {
    const data = JSON.parse(event.body);
    const { full_name, phone, email, company, size, utmParams } = data;

    const personalDomains = ["gmail", "yahoo", "hotmail", "aol", "mail", "rediff", "facebook", "yandex", "gmx"];
    const emailDomain = email.split('@')[1]?.split('.')[0]?.toLowerCase();
    if (personalDomains.includes(emailDomain)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
        },
        body: JSON.stringify({ error: "Please enter a corporate email address." }),
      };
    }

    if (size === "lessthan5") {
      console.log("Talentpool API called");

      const talentpoolResp = await fetch("https://demo.thetalentpool.co.in/onboard/tenant/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: process.env.TALENTPOOL_AUTH_HEADER,
        },
        body: JSON.stringify({ businessEmail: email }),
      });

      const raw = await talentpoolResp.text();
      let msg;
      try {
        const parsed = JSON.parse(raw);
        msg = parsed?.message || raw;
      } catch (err) {
        msg = raw;
      }

      if (msg.includes("Duplicate business email")) {
        return {
          statusCode: 200,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigin,
          },
          body: JSON.stringify({
            error: "You are an existing user, please consider logging in!",
            redirect: "/email-verification",
          }),
        };
      }

      if (msg.includes("Duplicate tenant code")) {
        return {
          statusCode: 200,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigin,
          },
          body: JSON.stringify({
            error: "Your organization is already registered, contact your administrator!",
            redirect: "/email-verification",
          }),
        };
      }

      // Success - new tenant
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
        },
        body: JSON.stringify({ redirect: "/email-verification" }),
      };
    }

    // 🔁 Pipedrive Flow
    const apiToken = process.env.PIPEDRIVE_API_TOKEN;
    console.log("Pipedrive API called");

    // 1. Get or create organization
    let orgId = null;
    const searchOrg = await fetch(`https://talentpool.pipedrive.com/v1/organizations/search?term=${encodeURIComponent(company)}&api_token=${apiToken}`);
    const orgRes = await searchOrg.json();
    if (orgRes?.data?.items?.length > 0) {
      orgId = orgRes.data.items[0].item.id;
    } else {
      const createOrg = await fetch(`https://talentpool.pipedrive.com/v1/organizations?api_token=${apiToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: company }),
      });
      const orgData = await createOrg.json();
      orgId = orgData?.data?.id;
    }

    // 2. Get or create person
    let personId = null;
    const searchPerson = await fetch(`https://talentpool.pipedrive.com/v1/persons/search?term=${encodeURIComponent(email)}&api_token=${apiToken}`);
    const personRes = await searchPerson.json();
    if (personRes?.data?.items?.length > 0) {
      personId = personRes.data.items[0].item.id;
    } else {
      const createPerson = await fetch(`https://talentpool.pipedrive.com/v1/persons?api_token=${apiToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: full_name,
          email: [{ value: email, primary: true, label: "work" }],
          phone: [{ value: phone, primary: true, label: "work" }],
        }),
      });
      const personData = await createPerson.json();
      personId = personData?.data?.id;
    }

    // 3. Create lead
    await fetch(`https://talentpool.pipedrive.com/v1/leads?api_token=${apiToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: company,
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

    // 5. Done
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
      },
      body: JSON.stringify({ redirect: "/thank-you-2/" }),
    };

  } catch (err) {
    console.error("Error in Netlify Function:", err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
      },
      body: JSON.stringify({ error: "Something went wrong" }),
    };
  }
};
