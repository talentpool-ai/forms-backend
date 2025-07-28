const fetch = require("node-fetch");

// Allow only your frontend origin
const allowedOrigin = "https://dev.thetalentpool.ai";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    // Handle preflight
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
      const respData = await talentpoolResp.json();
      const
