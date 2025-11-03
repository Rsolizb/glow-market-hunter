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
const SHEET_ID       = process.env.SHEET_ID;
const SERVICE_JSON   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;

if (!GOOGLE_API_KEY || !SHEET_ID || !SERVICE_JSON) {
  console.error("Faltan variables de entorno: GOOGLE_API_KEY, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON");
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
   APP
   ========================= */
const app = express();
app.use(cors());
app.use(bodyParser.json());

/* =========================
   HELPERS
   ========================= */

// 1) Text Search con paginación (trae TODO)
async function fetchAllTextSearch(query) {
  const base = "https://maps.googleapis.com/maps/api/place/textsearch/json";
  let url = `${base}?query=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
  let all = [];
  let pages = 0;

  while (url && pages < 10) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Places TextSearch error: ${r.status} ${await r.text()}`);
    const data = await r.json();

    // estados aceptables
    if (
      data.status &&
      !["OK", "ZERO_RESULTS", "OVER_QUERY_LIMIT"].includes(data.status)
    ) {
      throw new Error(`Places TextSearch status: ${data.status} / ${data.error_message || ""}`);
    }

    if (Array.isArray(data.results)) {
      all = all.concat(
        data.results.map(x => ({
          place_id: x.place_id || null,
          name: x.name || "",
          address: x.formatted_address || "",
          lat: x.geometry?.location?.lat ?? "",
          lng: x.geometry?.location?.lng ?? "",
          rating: x.rating ?? "",
          source: "Glow Places",
        }))
      );
    }

    if (data.next_page_token) {
      await new Promise(res => setTimeout(res, 2000)); // regla de Google
      url = `${base}?pagetoken=${data.next_page_token}&key=${GOOGLE_API_KEY}`;
      pages += 1;
    } else {
      url = null;
    }
  }
  return all;
}

// 2) Place Details por place_id (para phone / website)
async function fetchPlaceDetails(placeId) {
  const fields = [
    "formatted_phone_number",
    "international_phone_number",
    "website"
  ].join(",");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=${fields}&key=${GOOGLE_API_KEY}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Place Details error: ${r.status} ${await r.text()}`);
  const data = await r.json();

  if (data.status && !["OK", "ZERO_RESULTS"].includes(data.status)) {
    // Si rate limit u otro, devolvemos vacío y seguimos
    return { phone: "", website: "" };
  }

  const d = data.result || {};
  const phone =
    d.international_phone_number ||
    d.formatted_phone_number ||
    "";

  const website = d.website || "";
  return { phone, website };
}

// 3) Enriquecer con details con un pequeño control de concurrencia
async function enrichWithDetails(rows, concurrency = 5) {
  const out = [];
  let i = 0;

  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const item = rows[idx];
      if (!item.place_id) {
        out[idx] = { ...item, phone: "", website: "" };
        continue;
      }
      try {
        const det = await fetchPlaceDetails(item.place_id);
        out[idx] = { ...item, phone: det.phone, website: det.website };
      } catch {
        out[idx] = { ...item, phone: "", website: "" };
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return out;
}

// 4) Escribir a Sheets (headers fijos)
async function appendRows(sheetName, rows) {
  const headers = [
    "timestamp", "country", "city", "zone", "query",
    "name", "phone", "website", "lat", "lng", "address", "place_id", "source"
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A1:M1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });

  if (!rows.length) return;

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

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A2`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/* =========================
   ENDPOINTS
   ========================= */

// Health
app.get("/", (_req, res) => res.send("Glow Market Hunter API activa 🚀"));

// Corre una ciudad, deduplica por place_id, enriquece con phone & website y guarda
app.post("/run-city", async (req, res) => {
  try {
    const { country, city, categories } = req.body || {};
    if (!country || !city) {
      return res.status(400).json({ error: "Faltan 'country' y/o 'city'." });
    }

    const cats = Array.isArray(categories) && categories.length
      ? categories
      : ["barberías", "salones de belleza", "spas"];

    const sheetName = city;
    const perCategory = [];
    const map = new Map(); // place_id => row base
    let totalFound = 0;

    for (const cat of cats) {
      const query = `${cat} ${city} ${country}`;
      const list = await fetchAllTextSearch(query);
      totalFound += list.length;

      for (const it of list) {
        if (it.place_id && !map.has(it.place_id)) {
          map.set(it.place_id, {
            country,
            city,
            zone: "",
            query,
            name: it.name,
            phone: "",
            website: "",
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

    // base sin duplicados
    const uniqueRows = Array.from(map.values());

    // Enriquecer con phone + website (Place Details)
    const enriched = await enrichWithDetails(uniqueRows, 5);

    // Guardar a Sheets
    await appendRows(sheetName, enriched);

    // Vista previa para el agente (hasta 100 filas)
    const preview = enriched.slice(0, 100).map(r => ({
      name: r.name,
      address: r.address,
      place_id: r.place_id,
      phone: r.phone,
      website: r.website
    }));

    return res.json({
      status: "ok",
      sheetName,
      total_found: totalFound,
      total_unique: uniqueRows.length,
      total_appended: enriched.length,
      per_category: perCategory,
      results_count: preview.length,
      results: preview,
      note: "Se guardó todo en la pestaña de la ciudad y se devolvió una vista previa de hasta 100 filas con phone y website."
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
