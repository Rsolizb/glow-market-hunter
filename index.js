import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =========================
   Configuración base
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SERVICE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.SHEET_ID;

// Headers estándar que usaremos en TODAS las pestañas
const SHEET_HEADERS = [
  "timestamp",
  "country",
  "city",
  "category",
  "name",
  "phone",
  "website",
  "lat",
  "lng",
  "address",
  "place_id",
  "source",
];

/* =========================
   Google Sheets helpers
========================= */
function getSheetsClient() {
  if (!SERVICE_JSON) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!SHEET_ID) throw new Error("Falta SHEET_ID");

  const creds = JSON.parse(SERVICE_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth: jwt });
  return sheets;
}

async function ensureCitySheet(sheets, spreadsheetId, cityTitle) {
  // Lista las hojas para ver si existe la pestaña
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === cityTitle
  );

  // Si no existe, la creamos
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: cityTitle } } }],
      },
    });
  }

  // Escribimos headers (idempotente: simplemente los “pinta” arriba)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${cityTitle}'!A1:${columnLetter(SHEET_HEADERS.length)}1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [SHEET_HEADERS] },
  });
}

async function appendRowsToSheet(sheets, spreadsheetId, cityTitle, rows) {
  const values = rows.map((r) => SHEET_HEADERS.map((h) => r[h] ?? ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${cityTitle}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

// Utils para rangos tipo “A”, “B”… “M”
function columnLetter(n) {
  // 1 -> A, 2 -> B...
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

/* =========================
   Google Places helpers
========================= */
async function textSearchPlaces(city, category) {
  if (!GOOGLE_API_KEY) throw new Error("Falta GOOGLE_API_KEY");

  const query = `${category} ${city}`;
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  url.searchParams.set("key", GOOGLE_API_KEY);

  const r = await fetch(url.toString());
  const data = await r.json();

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    console.error("TextSearch error:", data);
    throw new Error(`Places TextSearch: ${data.status}`);
  }

  // devolvemos máximo 20 resultados (una página) para mantenerlo simple/rápido
  return data.results || [];
}

async function fetchPlaceDetails(placeId) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set(
    "fields",
    [
      "name",
      "formatted_address",
      "formatted_phone_number",
      "website",
      "geometry/location",
      "place_id",
    ].join(",")
  );
  url.searchParams.set("key", GOOGLE_API_KEY);

  const r = await fetch(url.toString());
  const data = await r.json();
  if (data.status !== "OK") {
    // Si falla detalles, devolvemos null y seguimos
    return null;
  }
  return data.result;
}

function splitCityCountry(cityString) {
  // "Bogotá, Colombia" => ["Bogotá", "Colombia"]
  const parts = cityString.split(",").map((x) => x.trim());
  if (parts.length === 1) return { city: parts[0], country: "" };
  return { city: parts[0], country: parts[parts.length - 1] };
}

/* =========================
   Endpoint: salud
========================= */
app.get("/", (req, res) => {
  res.send("Glow Market Hunter API activa ✅");
});

/* ==========================================================
   NUEVO Endpoint: /search-and-append  (AUTOMÁTICO)
   Body:
   {
     "city": "Bogotá, Colombia",
     "category": "barberías"
     // O
     "categories": ["barberías", "salones de belleza", "spas"]
   }
========================================================== */
app.post("/search-and-append", async (req, res) => {
  try {
    const { city, category, categories } = req.body || {};
    if (!city) {
      return res.status(400).json({ error: "Falta 'city'." });
    }

    const cats = Array.isArray(categories)
      ? categories
      : category
      ? [category]
      : null;

    if (!cats || cats.length === 0) {
      return res
        .status(400)
        .json({ error: "Envía 'category' o 'categories'." });
    }

    const sheets = getSheetsClient();
    // Pestaña = ciudad exacta como llega
    const tabTitle = city.trim();
    await ensureCitySheet(sheets, SHEET_ID, tabTitle);

    const { city: cityOnly, country } = splitCityCountry(city);
    const timestamp = new Date().toISOString();

    let allRows = [];
    let summary = [];

    for (const cat of cats) {
      // 1) Buscamos lugares por categoría + ciudad
      const baseResults = await textSearchPlaces(city, cat);

      // 2) Detalles (teléfono/web). Lo hacemos con Promise.all en paralelo.
      const withDetails = await Promise.all(
        baseResults.map(async (item) => {
          const details = await fetchPlaceDetails(item.place_id).catch(() => null);
          // Data preferente: details; fallback: item
          const name =
            details?.name ?? item.name ?? "N/A";
          const address =
            details?.formatted_address ??
            item.formatted_address ??
            "N/A";
          const lat =
            details?.geometry?.location?.lat ??
            item.geometry?.location?.lat ??
            null;
          const lng =
            details?.geometry?.location?.lng ??
            item.geometry?.location?.lng ??
            null;
          const phone =
            details?.formatted_phone_number ?? "N/A";
          const website =
            details?.website ?? "N/A";
          const place_id =
            details?.place_id ?? item.place_id ?? "N/A";

          return {
            name,
            address,
            lat,
            lng,
            phone,
            website,
            place_id,
          };
        })
      );

      // 3) Mapeamos a filas con headers acordados
      const rows = withDetails.map((p) => ({
        timestamp,
        country,
        city: cityOnly,
        category: cat,
        name: p.name || "N/A",
        phone: p.phone || "N/A",
        website: p.website || "N/A",
        lat: p.lat ?? "",
        lng: p.lng ?? "",
        address: p.address || "N/A",
        place_id: p.place_id || "N/A",
        source: "Glow Places",
      }));

      // 4) Append a la hoja (si hay algo)
      if (rows.length > 0) {
        await appendRowsToSheet(sheets, SHEET_ID, tabTitle, rows);
      }

      allRows = allRows.concat(rows);
      summary.push({ category: cat, found: rows.length });
    }

    return res.json({
      status: "ok",
      city: tabTitle,
      total_inserted: allRows.length,
      by_category: summary,
      note:
        "Pestaña creada/actualizada con nombre de la ciudad. Filas agregadas con headers fijos.",
    });
  } catch (e) {
    console.error("search-and-append error:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
});

/* =========================
   OpenAPI mínimo (opcional)
========================= */
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.0",
    info: { title: "Glow Market Hunter API", version: "1.0.0" },
    servers: [{ url: process.env.PUBLIC_URL || "http://localhost:" + PORT }],
    paths: {
      "/search-and-append": {
        post: {
          summary:
            "Busca por ciudad+categoría(s) y guarda los resultados en Google Sheet (pestaña = ciudad).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                    category: { type: "string" },
                    categories: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["city"],
                },
              },
            },
          },
          responses: {
            "200": { description: "OK" },
          },
        },
      },
    },
  });
});

/* =========================
   Start server
========================= */
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log(`Your service is live 🎉`);
  console.log(
    `Available at your primary URL (openapi): /openapi.json`
  );
});
