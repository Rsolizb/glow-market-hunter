import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.json()); // soporta JSON en body

// -------------------- Config desde env --------------------
const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || ""; // Places API key
const SHEET_ID = process.env.SHEET_ID || ""; // ID de tu Google Sheet
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ""; // JSON de la service account (string)

// -------------------- Helpers --------------------
function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// -------------------- Endpoint: places/search --------------------
app.post("/places/search", async (req, res) => {
  try {
    const { query, lat, lng, radius } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });

    let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&key=${GOOGLE_API_KEY}`;

    const latN = safeNumber(lat);
    const lngN = safeNumber(lng);
    if (latN !== null && lngN !== null) {
      url += `&location=${latN},${lngN}&radius=${radius || 5000}`;
    }

    const r = await fetch(url);
    const data = await r.json();

    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.warn("Places API returned status:", data.status, data.error_message);
      return res.status(500).json({ status: data.status, error_message: data.error_message || null });
    }

    const results = (data.results || []).map((x) => ({
      place_id: x.place_id,
      name: x.name,
      address: x.formatted_address || x.vicinity || "",
    }));

    res.json(results);
  } catch (e) {
    console.error("Error /places/search:", e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------- Endpoint: places/details --------------------
app.post("/places/details", async (req, res) => {
  try {
    const { place_ids } = req.body || {};
    if (!place_ids || !Array.isArray(place_ids) || place_ids.length === 0) {
      return res.status(400).json({ error: "place_ids must be a non-empty array" });
    }

    const results = [];
    for (const id of place_ids) {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
          id
        )}&fields=name,formatted_address,international_phone_number,website,geometry&key=${GOOGLE_API_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        const x = d.result || {};
        results.push({
          place_id: id,
          name: x.name || "",
          address: x.formatted_address || "",
          phone: x.international_phone_number || "",
          website: x.website || "",
          lat: x.geometry?.location?.lat || null,
          lng: x.geometry?.location?.lng || null,
        });
      } catch (innerErr) {
        console.warn("Error fetching details for", id, innerErr);
        results.push({ place_id: id, error: innerErr.message });
      }
    }

    res.json(results);
  } catch (e) {
    console.error("Error /places/details:", e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------- OpenAPI discovery + health endpoints ---------------------
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.0",
    info: { title: "Glow Market Hunter API", version: "1.0.0" },
    servers: [{ url: process.env.PUBLIC_URL || `https://glow-market-hunter.onrender.com` }],
    paths: {
      "/places/search": {
        post: {
          summary: "Search businesses",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    lat: { type: "number" },
                    lng: { type: "number" },
                    radius: { type: "integer" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/places/details": {
        post: {
          summary: "Get place details",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    place_ids: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/sheets/append": {
        post: {
          summary: "Append rows to Google Sheet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    rows: {
                      type: "array",
                      items: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });
});

app.get("/mcp/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// --------------------- Sheets integration ---------------------
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!SA_JSON) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  const sa = typeof SA_JSON === "string" ? JSON.parse(SA_JSON) : SA_JSON;
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  await auth.authorize();
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

app.post("/sheets/append", async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ error: "rows must be an array of arrays" });
    }
    if (!SHEET_ID) return res.status(500).json({ error: "SHEET_ID not configured" });

    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "A1",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });

    res.json({ status: "ok", updates: response.data.updates || null });
  } catch (e) {
    console.error("sheets append error:", e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------- Root / test ---------------------
app.get("/", (req, res) => {
  res.send("✅ Glow Market Hunter API activa y funcionando");
});

// --------------------- Start server ---------------------
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
  console.log("Available at your primary URL (openapi): /openapi.json");
});
