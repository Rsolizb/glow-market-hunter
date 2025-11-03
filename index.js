// index.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";

// ============================
// Config básica
// ============================
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

// Servicio Google (account JSON en env var)
function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON en variables de entorno.");
  }
  const svc = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = new google.auth.JWT(
    svc.client_email,
    null,
    svc.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth: jwt });
}

// Encabezados fijos
const HEADERS = [
  "timestamp",
  "country",
  "city",
  "query",
  "category",
  "name",
  "phone",
  "website",
  "lat",
  "lng",
  "address",
  "place_id",
  "source"
];
// Índice (1-based) de place_id para lecturas
const PLACE_ID_COL_A1 = "L"; // Columna 12 (A=1 ... L=12)

// ============================
// Utilidades Sheets
// ============================
async function ensureSheetAndHeader(sheets, sheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === sheetName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    });
    // Poner headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1:${String.fromCharCode(64 + HEADERS.length)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] }
    });
  } else {
    // Asegurar headers en A1 si están vacíos
    const hdr = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1:${String.fromCharCode(64 + HEADERS.length)}1`
    });
    const row0 = hdr.data.values?.[0] || [];
    if (row0.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${sheetName}!A1:${String.fromCharCode(64 + HEADERS.length)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [HEADERS] }
      });
    }
  }
}

async function readExistingPlaceIds(sheets, sheetId, sheetName) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!${PLACE_ID_COL_A1}2:${PLACE_ID_COL_A1}`
    });
    const rows = resp.data.values || [];
    const set = new Set(rows.map(r => (r[0] || "").trim()).filter(Boolean));
    return set;
  } catch {
    return new Set();
  }
}

async function appendRows(sheets, sheetId, sheetName, rows) {
  if (!rows.length) return { appended: 0 };
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows }
  });
  return { appended: rows.length };
}

// ============================
// Utilidades Places API
// ============================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Text Search con paginación sin límite
async function textSearchAll(query, language = "es") {
  const base = "https://maps.googleapis.com/maps/api/place/textsearch/json";
  const params = new URLSearchParams({
    query,
    key: GOOGLE_API_KEY,
    language
  });

  let url = `${base}?${params.toString()}`;
  const all = [];

  while (true) {
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("TextSearch status:", data.status, data.error_message);
    }
    all.push(...(data.results || []));
    if (!data.next_page_token) break;
    // política de Google: esperar ~2s antes de usar next_page_token
    await sleep(2200);
    url = `${base}?pagetoken=${data.next_page_token}&key=${GOOGLE_API_KEY}`;
  }
  return all;
}

// Place Details para enriquecer
async function getPlaceDetails(place_id) {
  const base = "https://maps.googleapis.com/maps/api/place/details/json";
  const fields = [
    "place_id",
    "name",
    "formatted_address",
    "formatted_phone_number",
    "website",
    "geometry/location"
  ].join(",");
  const params = new URLSearchParams({
    place_id,
    key: GOOGLE_API_KEY,
    fields
  });
  const r = await fetch(`${base}?${params.toString()}`);
  const data = await r.json();
  if (data.status !== "OK") return null;
  return data.result;
}

// ============================
// Endpoint raíz sanity
// ============================
app.get("/", (req, res) => {
  res.send("Your service is live 🎉");
});

// ============================
// ORQUESTADOR: /run-city
// ============================
// Body esperado:
// {
//   "country": "Bolivia",
//   "city": "Santa Cruz de la Sierra",
//   "categories": ["barberías","salones de belleza","spas"],          // opcional (default)
//   "sheetId": "SHEET_ID"                                            // opcional (si no, usa env)
//   "language": "es"                                                 // opcional
// }
app.post("/run-city", async (req, res) => {
  try {
    const {
      country = "",
      city = "",
      categories = ["barberías", "salones de belleza", "spas"],
      sheetId,
      language = "es"
    } = req.body || {};

    if (!GOOGLE_API_KEY) {
      return res.status(400).json({ error: "Falta GOOGLE_API_KEY." });
    }
    const targetSheetId = sheetId || SHEET_ID;
    if (!targetSheetId) {
      return res.status(400).json({ error: "Falta sheetId en body o SHEET_ID en env." });
    }
    if (!country || !city) {
      return res.status(400).json({ error: "Debes enviar country y city." });
    }

    const sheets = getSheetsClient();
    const sheetName = city.trim(); // cada ciudad en su pestaña
    await ensureSheetAndHeader(sheets, targetSheetId, sheetName);
    const existingIds = await readExistingPlaceIds(sheets, targetSheetId, sheetName);

    const nowISO = new Date().toISOString();
    const source = "Glow Places";

    const summary = [];
    const appendedRows = [];

    for (const category of categories) {
      const query = `${category} ${city} ${country}`;
      const results = await textSearchAll(query, language);
      let added = 0;

      for (const r of results) {
        const pid = r.place_id;
        if (!pid || existingIds.has(pid)) continue;

        // details
        const det = await getPlaceDetails(pid);
        const phone = det?.formatted_phone_number || "";
        const website = det?.website || "";
        const lat = det?.geometry?.location?.lat ?? r.geometry?.location?.lat ?? "";
        const lng = det?.geometry?.location?.lng ?? r.geometry?.location?.lng ?? "";
        const address = det?.formatted_address || r.formatted_address || "";
        const name = det?.name || r.name || "";

        const row = [
          nowISO,
          country,
          city,
          query,
          category,
          name,
          phone,
          website,
          lat,
          lng,
          address,
          pid,
          source
        ];
        appendedRows.push(row);
        existingIds.add(pid); // evitar duplicar dentro de la misma corrida
        added++;
      }

      summary.push({
        category,
        found: results.length,
        added
      });
    }

    if (appendedRows.length) {
      await appendRows(sheets, targetSheetId, sheetName, appendedRows);
    }

    return res.json({
      status: "ok",
      sheetId: targetSheetId,
      sheetName,
      total_appended: appendedRows.length,
      per_category: summary,
      note:
        "Pestaña creada/actualizada con nombre de la ciudad. Filas agregadas con headers fijos. Deduplicado por place_id."
    });
  } catch (e) {
    console.error("run-city error:", e);
    return res.status(500).json({ error: e.message || "Error interno" });
  }
});

// ============================
// (Opcional) Endpoints previos
// ============================
// Los dejamos por compatibilidad con tus pruebas antiguas:
app.post("/places/search-city", async (req, res) => {
  try {
    const { country = "", city = "", category = "", language = "es" } = req.body || {};
    if (!country || !city || !category) {
      return res.status(400).json({ error: "Debes enviar country, city y category." });
    }
    const query = `${category} ${city} ${country}`;
    const results = await textSearchAll(query, language);
    return res.json({ count: results.length, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en search-city" });
  }
});

app.post("/sheets/append", async (req, res) => {
  try {
    const { sheetId, sheetName, rows } = req.body || {};
    if (!sheetId || !sheetName) {
      return res.status(400).json({ error: "Falta sheetId o sheetName." });
    }
    const sheets = getSheetsClient();
    await ensureSheetAndHeader(sheets, sheetId, sheetName);
    const existingIds = await readExistingPlaceIds(sheets, sheetId, sheetName);

    // rows esperadas como array de objetos con las keys de HEADERS (o array de arrays ya ordenado)
    let values = [];
    if (Array.isArray(rows) && rows.length && !Array.isArray(rows[0])) {
      // objetos -> a arrays (y dedup por place_id)
      for (const o of rows) {
        const pid = (o.place_id || "").trim();
        if (!pid || existingIds.has(pid)) continue;
        values.push(HEADERS.map(h => o[h] ?? ""));
        existingIds.add(pid);
      }
    } else if (Array.isArray(rows) && rows.length) {
      // ya son arrays -> opcionalmente podrías deduplicar aquí si conoces la columna L
      values = rows;
    }

    const out = await appendRows(getSheetsClient(), sheetId, sheetName, values);
    res.json({ status: "ok", appended: out.appended });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en sheets/append" });
  }
});

// ============================
// Start
// ============================
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
});
