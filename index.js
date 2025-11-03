import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =========================
   Config
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SERVICE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.SHEET_ID;

// Paginación de Text Search: Google pide ~2s entre páginas
const NEXT_PAGE_DELAY_MS = 2000;

// Concurrencia de Place Details para no saturar la cuota
const DETAILS_CONCURRENCY = 5;

// Tamaño de bloque al escribir en Sheets (filas por append)
const SHEETS_APPEND_CHUNK = 300;

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
   Helpers: Sheets
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
  return google.sheets({ version: "v4", auth: jwt });
}

async function ensureCitySheet(sheets, spreadsheetId, cityTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties?.title === cityTitle
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: cityTitle } } }] },
    });
  }

  // Escribimos headers siempre en A1 (idempotente)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${cityTitle}'!A1:${columnLetter(SHEET_HEADERS.length)}1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [SHEET_HEADERS] },
  });
}

async function appendRowsToSheet(sheets, spreadsheetId, cityTitle, rows) {
  // Google acepta matrices grandes, pero mejor trocear para estabilidad
  for (let i = 0; i < rows.length; i += SHEETS_APPEND_CHUNK) {
    const chunk = rows.slice(i, i + SHEETS_APPEND_CHUNK);
    const values = chunk.map((r) => SHEET_HEADERS.map((h) => r[h] ?? ""));
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${cityTitle}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }
}

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

/* =========================
   Helpers: Places (paginado)
========================= */
async function textSearchAllPages(query) {
  if (!GOOGLE_API_KEY) throw new Error("Falta GOOGLE_API_KEY");

  let url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  url.searchParams.set("key", GOOGLE_API_KEY);

  let all = [];
  let page = 1;

  while (true) {
    const r = await fetch(url.toString());
    const data = await r.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("TextSearch error:", data);
      throw new Error(`Places TextSearch: ${data.status}`);
    }

    const results = data.results || [];
    all = all.concat(results);

    const token = data.next_page_token;
    if (!token) break;

    // Esperar para que el token sea válido
    await waitMs(NEXT_PAGE_DELAY_MS);

    // Siguiente página
    url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("pagetoken", token);
    url.searchParams.set("key", GOOGLE_API_KEY);

    page++;
  }

  return all;
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
  if (data.status !== "OK") return null;
  return data.result;
}

function splitCityCountry(cityString) {
  const parts = cityString.split(",").map((x) => x.trim());
  if (parts.length === 1) return { city: parts[0], country: "" };
  return { city: parts[0], country: parts[parts.length - 1] };
}

function waitMs(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const myIndex = idx++;
      try {
        results[myIndex] = await mapper(items[myIndex], myIndex);
      } catch (e) {
        results[myIndex] = null;
      }
    }
  }

  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

/* =========================
   Endpoints
========================= */
app.get("/", (req, res) => {
  res.send("Glow Market Hunter API activa ✅");
});

/**
 * POST /search-and-append
 * Body:
 *  { "city": "Bogotá, Colombia", "category": "barberías" }
 *  o
 *  { "city": "Bogotá, Colombia", "categories": ["barberías", "salones de belleza", "spas"] }
 */
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
      return res.status(400).json({ error: "Envía 'category' o 'categories'." });
    }

    const sheets = getSheetsClient();
    const tabTitle = city.trim();
    await ensureCitySheet(sheets, SHEET_ID, tabTitle);

    const { city: cityOnly, country } = splitCityCountry(city);
    const timestamp = new Date().toISOString();

    let total = 0;
    const perCategory = [];

    for (const cat of cats) {
      // 1) Traer TODAS las páginas de resultados para (cat + city)
      const query = `${cat} ${city}`;
      const allBase = await textSearchAllPages(query);

      // 2) Traer detalles con concurrencia limitada
      const detailed = await mapWithConcurrency(
        allBase,
        DETAILS_CONCURRENCY,
        async (item) => {
          const details = await fetchPlaceDetails(item.place_id).catch(() => null);
          const name = details?.name ?? item?.name ?? "N/A";
          const address =
            details?.formatted_address ?? item?.formatted_address ?? "N/A";
          const lat =
            details?.geometry?.location?.lat ?? item?.geometry?.location?.lat ?? "";
          const lng =
            details?.geometry?.location?.lng ?? item?.geometry?.location?.lng ?? "";
          const phone = details?.formatted_phone_number ?? "N/A";
          const website = details?.website ?? "N/A";
          const place_id = details?.place_id ?? item?.place_id ?? "N/A";

          return { name, address, lat, lng, phone, website, place_id };
        }
      );

      // 3) Mapear a filas
      const rows = detailed.map((p) => ({
        timestamp,
        country,
        city: cityOnly,
        category: cat,
        name: p?.name || "N/A",
        phone: p?.phone || "N/A",
        website: p?.website || "N/A",
        lat: p?.lat ?? "",
        lng: p?.lng ?? "",
        address: p?.address || "N/A",
        place_id: p?.place_id || "N/A",
        source: "Glow Places",
      }));

      // 4) Guardar en Sheets por bloques
      if (rows.length > 0) {
        await appendRowsToSheet(sheets, SHEET_ID, tabTitle, rows);
      }

      perCategory.push({ category: cat, found: rows.length });
      total += rows.length;
    }

    return res.json({
      status: "ok",
      city: tabTitle,
      total_inserted: total,
      by_category: perCategory,
      note:
        "Paginación completa de Text Search. Pestaña = ciudad. Headers en A1. Append en bloques.",
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
    info: { title: "Glow Market Hunter API", version: "1.1.0" },
    servers: [{ url: process.env.PUBLIC_URL || "http://localhost:" + PORT }],
    paths: {
      "/search-and-append": {
        post: {
          summary:
            "Busca TODAS las páginas por ciudad+categoría(s) (Text Search) y guarda en Sheets (pestaña=ciudad).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    city: { type: "string" },
                    category: { type: "string" },
                    categories: { type: "array", items: { type: "string" } },
                  },
                  required: ["city"],
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

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log(`Your service is live 🎉`);
  console.log(`OpenAPI: /openapi.json`);
});
