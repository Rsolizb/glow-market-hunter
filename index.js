import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =========================
   CONFIG
   ========================= */
const PORT = process.env.PORT || 10000;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // <- ya lo tenías en Render
const SHEET_ID       = process.env.SHEET_ID;       // <- ya lo tenías en Render
const SERVICE_JSON   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;

if (!GOOGLE_API_KEY || !SHEET_ID || !SERVICE_JSON) {
  console.error("Faltan variables de entorno requeridas: GOOGLE_API_KEY, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}

/* =========================
   GOOGLE SHEETS AUTH
   ========================= */
const auth = new google.auth.JWT({
  email: SERVICE_JSON.client_email,
  key: SERVICE_JSON.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =========================
   HELPERS
   ========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Google Places Text Search con paginación (fetch ALL)
async function fetchAllTextSearch(query) {
  const base = "https://maps.googleapis.com/maps/api/place/textsearch/json";
  let url = `${base}?query=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
  let out = [];
  let pageCount = 0;

  while (url && pageCount < 10) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Places error: ${r.status} ${await r.text()}`);
    const data = await r.json();

    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS" && data.status !== "OVER_QUERY_LIMIT") {
      throw new Error(`Places status: ${data.status} / ${data.error_message || ""}`);
    }

    if (Array.isArray(data.results)) {
      out = out.concat(
        data.results.map(x => ({
          place_id: x.place_id || null,
          name: x.name || "",
          address: x.formatted_address || "",
          lat: x.geometry?.location?.lat ?? "",
          lng: x.geometry?.location?.lng ?? "",
          rating: x.rating ?? "",
          website: "", // opcional (se puede ampliar con Place Details si lo necesitas)
          source: "Glow Places",
        }))
      );
    }

    // paginación
    if (data.next_page_token) {
      // Google pide ~2s antes de usar el next_page_token
      await new Promise(res => setTimeout(res, 2000));
      url = `${base}?pagetoken=${data.next_page_token}&key=${GOOGLE_API_KEY}`;
      pageCount += 1;
    } else {
      url = null;
    }
  }
  return out;
}

// Escribe filas a una pestaña (crea encabezados fijos si no existen)
async function appendRows(sheetName, rows) {
  // Encabezados fijos
  const headers = [
    "timestamp", "country", "city", "zone", "query",
    "name", "phone", "website", "lat", "lng", "address", "place_id", "source"
  ];

  // Asegurar fila de headers
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A1:M1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });

  if (!rows.length) return { updates: null };

  const values = rows.map(r => ([
    new Date().toISOString(),
    r.country || "",
    r.city || "",
    r.zone || "",
    r.query || "",
    r.name || "",
    r.phone || "",
    r.website || "",
    r.lat || "",
    r.lng || "",
    r.address || "",
    r.place_id || "",
    r.source || ""
  ]));

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A2`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return res.data;
}

/* =========================
   ENDPOINTS
   ========================= */

// Health
app.get("/", (_req, res) => res.send("Glow Market Hunter API activa 🚀"));

// Busca por ciudad y categorías, deduplica, guarda y DEVUELVE la lista
app.post("/run-city", async (req, res) => {
  try {
    const { country, city, categories } = req.body || {};

    if (!country || !city) {
      return res.status(400).json({ error: "Faltan 'country' y/o 'city'." });
    }

    const cats = Array.isArray(categories) && categories.length
      ? categories
      : ["barberías", "salones de belleza", "spas"];

    const sheetName = city; // una pestaña por ciudad

    let totalFound = 0;
    let totalAdded = 0;
    const perCategory = [];
    const map = new Map(); // place_id -> row

    for (const cat of cats) {
      const query = `${cat} ${city} ${country}`;
      const list = await fetchAllTextSearch(query);
      totalFound += list.length;

      // dedupe por place_id global de la corrida
      for (const it of list) {
        if (it.place_id && !map.has(it.place_id)) {
          map.set(it.place_id, {
            country,
            city,
            zone: "",      // lo dejamos vacío por ahora
            query,         // guardo el query exacto
            name: it.name,
            phone: "",     // se puede ampliar con Place Details
            website: it.website || "",
            lat: it.lat,
            lng: it.lng,
            address: it.address,
            place_id: it.place_id,
            source: it.source,
          });
        }
      }

      perCategory.push({ category: cat, found: list.length });
    }

    const uniqueRows = Array.from(map.values());

    // Append a Sheets
    const result = await appendRows(sheetName, uniqueRows);
    const added = uniqueRows.length;
    totalAdded += added;

    // Para que el agente pueda MOSTRAR en chat:
    // entregamos una lista liviana (máx. 100 para no saturar tokens)
    const results = uniqueRows
      .slice(0, 100)
      .map(r => ({ name: r.name, address: r.address, place_id: r.place_id }));

    return res.json({
      status: "ok",
      sheetName,
      total_found: totalFound,
      total_unique: uniqueRows.length,
      total_appended: added,
      per_category: perCategory.map(c => ({ ...c, added })), // nota: agregado global; puedes refinar por cat si prefieres
      results_count: results.length,
      results, // <-- el agente mostrará esto en tabla (name, address, place_id)
      note: "Pestaña creada/actualizada con nombre de la ciudad. Se devuelven hasta 100 resultados para vista previa."
    });
  } catch (e) {
    console.error("run-city error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
});
