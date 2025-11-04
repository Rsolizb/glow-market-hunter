/**
 * Glow Market Hunter API — city search + Google Sheets append (dedupe by place_id)
 * - Busca por categorías en (Ciudad, País) usando Google Places
 * - Obtiene detalles (phone, website, lat/lng, address, place_id)
 * - Crea/usa la pestaña "Ciudad, País" en Google Sheets con headers fijos
 * - Deduplica por place_id
 * - Escribe en modo RAW y fuerza phone como texto para evitar #ERROR en Sheets
 */

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

// ------------ ENV ------------
const {
  GOOGLE_API_KEY,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  PORT = 10000,
} = process.env;

if (!GOOGLE_API_KEY) throw new Error("Falta GOOGLE_API_KEY");
if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");
if (!SHEET_ID) throw new Error("Falta SHEET_ID");

// ------------ CONSTANTES ------------
const HEADERS = [
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
const DEFAULT_CATEGORIES = ["barberías", "salones de belleza", "spas"];
const SOURCE = "Glow Places";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ------------ GOOGLE SHEETS AUTH ------------
function getSheetsClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  return sheets;
}

// ------------ HELPERS: Sheets ------------
function sanitizeSheetTitle(title) {
  // Sheets no permite: : \ / ? * [ ]
  return title.replace(/[:\\/?*\[\]]/g, "-").substring(0, 90).trim();
}

async function getOrCreateSheetByTitle(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
  });
  const sheet = res.data.sheets?.find((s) => s.properties.title === title);
  if (sheet) return sheet.properties.sheetId;

  // Crear pestaña
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title },
          },
        },
      ],
    },
  });
  const newSheetId =
    addRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;

  // Escribir headers en A1
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1:${String.fromCharCode(65 + HEADERS.length - 1)}1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [HEADERS],
    },
  });

  return newSheetId;
}

async function ensureSheetAndHeaders(sheets, spreadsheetId, title) {
  // Crea pestaña si no existe y se asegura de que tenga headers
  const sheetId = await getOrCreateSheetByTitle(sheets, spreadsheetId, title);

  // Verificar si A1 ya tiene headers, si no, escribirlos
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A1:A1`,
  });

  const a1 = check.data.values?.[0]?.[0] ?? "";
  if (a1 !== HEADERS[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${String.fromCharCode(65 + HEADERS.length - 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }

  return sheetId;
}

// ------------ HELPERS: Sanitizado ------------
function sanitizePhone(p) {
  if (!p || p === "N/A") return "N/A";
  let s = String(p)
    // elimina caracteres de control/direccionalidad que causan errores
    .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // IMPORTANTÍSIMO: prefijo ' para forzar texto en Sheets
  if (!s.startsWith("'")) s = `'${s}`;
  return s;
}

// ------------ Google Places ------------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function textSearchAllPages({ query }) {
  const out = [];
  let nextPageToken = null;

  do {
    const url =
      nextPageToken == null
        ? `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
            query
          )}&key=${GOOGLE_API_KEY}`
        : `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${nextPageToken}&key=${GOOGLE_API_KEY}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("TextSearch status:", data.status, data.error_message);
      break;
    }
    if (data.results?.length) out.push(...data.results);
    nextPageToken = data.next_page_token ?? null;

    if (nextPageToken) await sleep(2000); // esperar 2s por token
  } while (nextPageToken);

  return out;
}

async function placeDetails(place_id) {
  const fields =
    "place_id,name,formatted_address,international_phone_number,formatted_phone_number,geometry,website";
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    place_id
  )}&fields=${fields}&key=${GOOGLE_API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== "OK") {
    return {
      place_id,
      name: "N/A",
      address: "N/A",
      phone: "N/A",
      website: "N/A",
      lat: "",
      lng: "",
    };
  }

  const d = data.result || {};
  const rawPhone =
    d.international_phone_number || d.formatted_phone_number || "N/A";

  return {
    place_id: d.place_id || place_id || "N/A",
    name: d.name || "N/A",
    address: d.formatted_address || "N/A",
    phone: sanitizePhone(rawPhone), // <<<<< clave
    website: d.website || "N/A",
    lat: d.geometry?.location?.lat ?? "",
    lng: d.geometry?.location?.lng ?? "",
  };
}

// ------------ Construcción de filas ------------
function rowFromDetail({
  country,
  city,
  category,
  detail,
  timestamp = new Date().toISOString(),
}) {
  return [
    timestamp,
    country,
    city,
    category,
    detail.name,
    detail.phone,
    detail.website,
    detail.lat,
    detail.lng,
    detail.address,
    detail.place_id,
    SOURCE,
  ];
}

// ------------ Deduplicación + Append RAW ------------
async function appendRowsDedup({ title, rows }) {
  if (!rows || rows.length === 0) {
    return { added: 0, skipped: 0 };
  }

  const sheets = getSheetsClient();
  await ensureSheetAndHeaders(sheets, SHEET_ID, title);

  // Leer toda la pestaña para identificar place_id existentes
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${title}!A1:Z`,
  });

  let existing = new Set();
  const values = read.data.values || [];
  const header = values[0] || [];
  const pidIdx = header.findIndex((h) => h === "place_id");

  if (pidIdx >= 0) {
    for (let i = 1; i < values.length; i++) {
      const pid = values[i][pidIdx];
      if (pid) existing.add(pid);
    }
  }

  const filtered = rows.filter((r) => {
    const pid = r[HEADERS.indexOf("place_id")];
    return pid && !existing.has(pid);
  });

  if (filtered.length === 0) {
    return { added: 0, skipped: rows.length };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${title}!A1`,
    valueInputOption: "RAW", // <<<<< clave para evitar #ERROR!
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: filtered },
  });

  return { added: filtered.length, skipped: rows.length - filtered.length };
}

// ------------ BUSCADOR PRINCIPAL ------------
async function searchCityAndBuildRows({ country, city, categories }) {
  const timestamp = new Date().toISOString();
  const safeCity = city.trim();
  const safeCountry = country.trim();

  const rows = [];
  const perCategory = [];

  for (const category of categories) {
    const query = `${category} ${safeCity} ${safeCountry}`;
    const results = await textSearchAllPages({ query });

    // Obtener detalles por cada place_id
    const details = [];
    for (const r of results) {
      if (!r.place_id) continue;
      const d = await placeDetails(r.place_id);
      details.push(d);
    }

    // Convertir a filas
    for (const d of details) {
      rows.push(
        rowFromDetail({
          country: safeCountry,
          city: safeCity,
          category,
          detail: d,
          timestamp,
        })
      );
    }

    perCategory.push({
      category,
      found: details.length,
    });
  }

  return { rows, perCategory, timestamp };
}

// ------------ ENDPOINTS ------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Glow Market Hunter",
    message: "API viva",
  });
});

/**
 * POST /places/search-city
 * body: { country, city, categories? }
 * -> Devuelve lista “plana” de resultados (no guarda en Sheets)
 */
app.post("/places/search-city", async (req, res) => {
  try {
    const country = (req.body.country || "").trim();
    const city = (req.body.city || "").trim();
    let categories = req.body.categories;
    if (!country || !city) {
      return res.status(400).json({ error: "country y city son requeridos" });
    }
    if (!Array.isArray(categories) || categories.length === 0) {
      categories = DEFAULT_CATEGORIES;
    }

    const { rows, perCategory } = await searchCityAndBuildRows({
      country,
      city,
      categories,
    });

    res.json({
      status: "OK",
      found: rows.length,
      per_category: perCategory,
      sample: rows.slice(0, 5),
    });
  } catch (e) {
    console.error("places/search-city", e);
    res.status(500).json({ error: e.message || "error" });
  }
});

/**
 * POST /run-city
 * body: { country, city, categories? }
 * -> Busca TODO y guarda en Google Sheet en pestaña "Ciudad, País"
 */
app.post("/run-city", async (req, res) => {
  try {
    const country = (req.body.country || "").trim();
    const city = (req.body.city || "").trim();
    let categories = req.body.categories;
    if (!country || !city) {
      return res.status(400).json({ error: "country y city son requeridos" });
    }
    if (!Array.isArray(categories) || categories.length === 0) {
      categories = DEFAULT_CATEGORIES;
    }

    const { rows, perCategory } = await searchCityAndBuildRows({
      country,
      city,
      categories,
    });

    // Crear/usar pestaña "Ciudad, País"
    const sheetTitle = sanitizeSheetTitle(`${city}, ${country}`);
    const { added, skipped } = await appendRowsDedup({
      title: sheetTitle,
      rows,
    });

    res.json({
      status: "OK",
      sheetName: sheetTitle,
      total_found: rows.length,
      per_category: perCategory.map((p) => ({
        category: p.category,
        found: p.found,
      })),
      added,
      skipped,
      note:
        "Pestaña creada/actualizada; filas agregadas en modo RAW; deduplicación por place_id; phone forzado a texto.",
    });
  } catch (e) {
    console.error("run-city", e);
    res.status(500).json({ error: e.message || "error" });
  }
});

/**
 * POST /sheets/append
 * Acepta:
 *  - { title, rows: [ [..], [..] ] }   // filas ya en el orden HEADERS
 *  - { title, rows: [ {timestamp,country,...}, {...} ] }  // objetos
 */
app.post("/sheets/append", async (req, res) => {
  try {
    const sheets = getSheetsClient();

    let { title, rows } = req.body;
    if (!title) return res.status(400).json({ error: "title es requerido" });
    if (!Array.isArray(rows) || rows.length === 0)
      return res
        .status(400)
        .json({ error: "Falta 'rows' o está vacío. Envía un array con filas." });

    // Si vienen como objetos, mapear al orden de HEADERS
    if (!Array.isArray(rows[0])) {
      rows = rows.map((o) => HEADERS.map((h) => (h === "phone" ? sanitizePhone(o[h]) : o[h])));
    }

    const sheetTitle = sanitizeSheetTitle(title);
    await ensureSheetAndHeaders(sheets, SHEET_ID, sheetTitle);

    const resp = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetTitle}!A1`,
      valueInputOption: "RAW", // clave
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });

    res.json({
      status: "ok",
      updates: resp.data.updates || null,
      note: "Escritura RAW; teléfono forzado a texto si vino como objeto.",
    });
  } catch (e) {
    console.error("sheets/append", e);
    res.status(500).json({ error: e.message || "error" });
  }
});

// ------------ START ------------
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
  console.log("Available at your primary URL (openapi): /openapi.json");
});
