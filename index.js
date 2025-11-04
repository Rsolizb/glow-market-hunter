// index.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

// El JSON COMPLETO de la service account en la variable
// GOOGLE_SERVICE_ACCOUNT_JSON (todo el blob, no sólo la clave):
const SERVICE_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");

// Validaciones mínimas
if (!GOOGLE_API_KEY) console.warn("⚠️ Falta GOOGLE_API_KEY");
if (!SHEET_ID) console.warn("⚠️ Falta SHEET_ID");
if (!SERVICE_JSON.client_email || !SERVICE_JSON.private_key) {
  console.warn("⚠️ Falta GOOGLE_SERVICE_ACCOUNT_JSON con client_email y private_key");
}

/* =========================
   GOOGLE SHEETS CLIENT
========================= */
const jwtClient = new google.auth.JWT({
  email: SERVICE_JSON.client_email,
  key: SERVICE_JSON.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: jwtClient });

/* =========================
   UTILS
========================= */
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
  "source"
];

// Normaliza “Ciudad, País”, quita acentos y caracteres inválidos para Sheets
function buildSheetTitle(city, country) {
  const norm = (s) => s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")         // quita tildes
    .replace(/[*?:/\\[\]]/g, " ")             // caracteres no permitidos
    .replace(/\s+/g, " ")                     // espacios dobles
    .trim();

  const title = `${norm(city)}, ${norm(country)}`.substring(0, 80);
  return title.length ? title : "Hoja";
}

// Para rangos A1 con título entre comillas si tiene comas/espacios/apóstrofes
function a1Title(title) {
  // Escapar apóstrofes duplicando
  const safe = title.replace(/'/g, "''");
  return `'${safe}'`;
}

// Convierte número de columna a letra A, B, ..., Z, AA, AB...
function colLetter(n) {
  let s = "";
  while (n > 0) {
    let m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Espera simple (para next_page_token de Google Places)
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* =========================
   SHEETS HELPERS
========================= */
async function ensureSheetAndHeaders(spreadsheetId, title) {
  // 1) ¿Existe la hoja?
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets?.find(
    s => (s.properties?.title || "").toLowerCase() === title.toLowerCase()
  );

  if (!found) {
    // Crear la hoja
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }]
      }
    });
  }

  // 2) ¿Tiene headers? si no, escribirlos en la fila 1
  const titleA1 = a1Title(title);
  const lastHeaderCol = colLetter(HEADERS.length);
  const headerRange = `${titleA1}!A1:${lastHeaderCol}1`;

  const getHead = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
    valueRenderOption: "UNFORMATTED_VALUE"
  });

  const row0 = getHead.data.values?.[0] || [];
  const already = row0.length >= HEADERS.length &&
                  HEADERS.every((h, i) => (row0[i] || "").toString().toLowerCase() === h);

  if (!already) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: headerRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [HEADERS] }
    });
  }
}

async function loadExistingPlaceIds(spreadsheetId, title) {
  // Lee toda la hoja para deduplicar por place_id
  const titleA1 = a1Title(title);
  const range = `${titleA1}!A1:Z`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });
  const rows = resp.data.values || [];
  if (!rows.length) return new Set();

  const header = rows[0].map((v) => (v || "").toString().trim().toLowerCase());
  const idx = header.indexOf("place_id");
  if (idx === -1) return new Set();

  const set = new Set();
  for (let i = 1; i < rows.length; i++) {
    const pid = (rows[i][idx] || "").toString().trim();
    if (pid) set.add(pid);
  }
  return set;
}

async function appendRowsDedup(spreadsheetId, title, rows) {
  // Asegurar hoja y headers
  await ensureSheetAndHeaders(spreadsheetId, title);

  // Deduplicar por place_id contra lo existente
  const existing = await loadExistingPlaceIds(spreadsheetId, title);
  const filtered = rows.filter(r => {
    const pid = (r[HEADERS.indexOf("place_id")] || "").toString().trim();
    return pid && !existing.has(pid);
  });

  if (!filtered.length) {
    return { appended: 0 };
  }

  const titleA1 = a1Title(title);
  const range = `${titleA1}!A1`;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: filtered }
  });

  return { appended: filtered.length };
}

/* =========================
   GOOGLE PLACES HELPERS
========================= */
const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

async function textSearchAll(query) {
  const results = [];
  let pagetoken = null;
  do {
    const url = new URL(`${PLACES_BASE}/textsearch/json`);
    url.searchParams.set("query", query);
    url.searchParams.set("key", GOOGLE_API_KEY);
    if (pagetoken) url.searchParams.set("pagetoken", pagetoken);

    const r = await fetch(url.toString());
    const j = await r.json();

    if (j.status !== "OK" && j.status !== "ZERO_RESULTS") {
      console.warn("Places TextSearch status:", j.status, j.error_message);
    }

    (j.results || []).forEach((it) => results.push(it));
    pagetoken = j.next_page_token || null;
    if (pagetoken) await delay(2000); // requerido por Google para next_page_token
  } while (pagetoken);

  return results;
}

async function placeDetails(place_id) {
  const url = new URL(`${PLACES_BASE}/details/json`);
  url.searchParams.set("place_id", place_id);
  url.searchParams.set("fields", "formatted_phone_number,international_phone_number,website,geometry,formatted_address,name,place_id");
  url.searchParams.set("key", GOOGLE_API_KEY);

  const r = await fetch(url.toString());
  const j = await r.json();
  if (j.status !== "OK") {
    return { phone: "N/A", website: "N/A" };
  }
  const d = j.result || {};
  const phone = d.international_phone_number || d.formatted_phone_number || "N/A";
  const website = d.website || "N/A";
  const lat = d.geometry?.location?.lat ?? null;
  const lng = d.geometry?.location?.lng ?? null;
  const address = d.formatted_address || "N/A";
  const name = d.name || "N/A";
  return { phone, website, lat, lng, address, name };
}

/* =========================
   APP
========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Salud
app.get("/", (req, res) => {
  res.send("✅ Glow Market Hunter API activa y funcionando");
});

// Endpoint principal: /run-city
app.post("/run-city", async (req, res) => {
  try {
    let { country, city, categories } = req.body || {};
    if (!country || !city) {
      return res.status(400).json({ error: "Faltan 'country' y/o 'city'." });
    }
    if (!Array.isArray(categories) || !categories.length) {
      categories = ["barberías", "salones de belleza", "spas"];
    }

    const sheetTitle = buildSheetTitle(city, country);
    await ensureSheetAndHeaders(SHEET_ID, sheetTitle);

    const timestamp = new Date().toISOString();
    const perCategory = [];
    const rowsToAppend = [];

    // Buscar por cada categoría
    for (const cat of categories) {
      const query = `${cat} en ${city}, ${country}`;
      const list = await textSearchAll(query);

      let addedCount = 0;
      for (const r of list) {
        const pid = r.place_id || "";
        if (!pid) continue;

        // Detalles para phone/website/lat/lng/address:
        const det = await placeDetails(pid);

        rowsToAppend.push([
          timestamp,
          country,
          city,
          cat,
          det.name || r.name || "N/A",
          det.phone || "N/A",
          det.website || "N/A",
          det.lat ?? r.geometry?.location?.lat ?? "",
          det.lng ?? r.geometry?.location?.lng ?? "",
          det.address || r.formatted_address || "N/A",
          pid,
          "Glow Places"
        ]);
      }

      perCategory.push({
        category: cat,
        found: rowsToAppend.filter(rr => rr[3] === cat).length,
        added: 0 // se setea luego de deduplicar
      });
    }

    // Append con deduplicado por place_id
    const { appended } = await appendRowsDedup(SHEET_ID, sheetTitle, rowsToAppend);

    // Recalcular “added” por categoría con los que entraron
    const addedByCat = {};
    for (const rr of rowsToAppend.slice(-appended)) {
      const c = rr[3];
      addedByCat[c] = (addedByCat[c] || 0) + 1;
    }
    perCategory.forEach(pc => { pc.added = addedByCat[pc.category] || 0; });

    return res.json({
      status: "ok",
      sheetName: sheetTitle,
      total_appended: appended,
      per_category: perCategory,
      note: "Pestaña creada/actualizada. Headers garantizados y deduplicación por place_id."
    });
  } catch (e) {
    console.error("run-city error:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
});

// Endpoint simple para ver el OpenAPI mínimo (opcional)
app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.0",
    info: { title: "Glow Market Hunter API", version: "1.0.0" },
    servers: [{ url: process.env.PUBLIC_URL || "https://glow-market-hunter.onrender.com" }],
    paths: {
      "/run-city": {
        post: {
          summary: "Busca negocios por ciudad/país, crea la hoja y pega datos.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    country: { type: "string" },
                    city: { type: "string" },
                    categories: { type: "array", items: { type: "string" } }
                  },
                  required: ["country", "city"]
                }
              }
            }
          },
          responses: { "200": { description: "OK" } }
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
  console.log("➡️  Tu servicio está vivo 🎉");
});
