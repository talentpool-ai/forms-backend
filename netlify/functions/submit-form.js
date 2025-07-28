const fetch = require("node-fetch");

// Allowed frontend domains
const allowedOrigins = [
  "https://dev.thetalentpool.ai",
  "https://www.thetalentpool.ai",
];

exports.handler = async (event) => {
  const requestOrigin = event.headers.origin;
  const corsOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : "null";

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
    const { full_name, phone, email, company, size, utmParams } = data;

    const personalDomains = ["gmail", "yahoo", "hotmail", "aol", "mail", "rediff", "facebook", "yandex", "gmx"];
    const emailDomain = email.split('@')[1]?.split('.')[0]?.toLowerCase();
    if (personalDomains.includes(emailDomain)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
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
            "Access-Control-Allow-Origin": corsOrigin,
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
            "Access-Control-Allow-Origin": corsOrigin,
          },
          body: JSON.stringify({
            error: "Your organization is already registered, contact your administrator!",
            redirect: "/email-verification",
          }),
        };
      }

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
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
