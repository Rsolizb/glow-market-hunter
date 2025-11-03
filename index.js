// index.js — Glow Market Hunter (ciudad, país, crea pestaña y header por defecto)
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fetch from 'node-fetch';
import { google } from 'googleapis';

// ------------------ Config ------------------
const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

// Service Account
const SA = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
const auth = new google.auth.JWT(
  SA.client_email,
  null,
  SA.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// Encabezados estándar (12 columnas)
const HEADER_ROW = [
  'timestamp', 'country', 'city', 'category',
  'name', 'phone', 'website', 'lat', 'lng',
  'address', 'place_id', 'source'
];

// ------------------ Utilidades ------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeTitle(city, country) {
  // Capitaliza primera letra de cada palabra
  const cap = s => s
    .trim()
    .toLowerCase()
    .split(' ')
    .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
    .join(' ');
  return `${cap(city)}, ${cap(country)}`; // p.ej. "Lima, Perú"
}

async function ensureSheetExists(spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(sh => sh.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  }
}

async function ensureHeaderRow(spreadsheetId, title) {
  // Lee A1 hasta el largo de headers; si está vacío, escribe headers
  const headerRange = `'${title}'!A1:${String.fromCharCode(64 + HEADER_ROW.length)}1`;
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange
  });

  const needHeader =
    !read.data.values || !read.data.values.length || !read.data.values[0]?.length;

  if (needHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: headerRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER_ROW] }
    });
  }
}

async function getExistingPlaceIds(spreadsheetId, title) {
  // place_id es la columna 11 (1-based) → columna K si hay 12 headers
  // Como escribimos 12 columnas, usamos rango A2:L (hasta la 12)
  const dataRange = `'${title}'!A2:${String.fromCharCode(64 + HEADER_ROW.length)}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dataRange
  });
  const rows = res.data.values || [];
  const idx = HEADER_ROW.indexOf('place_id'); // 10 (cero-based)
  const set = new Set();
  for (const row of rows) {
    const pid = row[idx] || '';
    if (pid) set.add(pid);
  }
  return set;
}

async function appendRows(spreadsheetId, title, rows) {
  if (!rows.length) return { updated: 0 };
  const dataRange = `'${title}'!A2:${String.fromCharCode(64 + HEADER_ROW.length)}`;
  const payload = {
    values: rows
  };
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: dataRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: payload
  });
  const updates = res.data.updates || {};
  return { updated: updates.updatedRows || rows.length };
}

// ------------------ Google Places ------------------
async function textSearchAllPages(query) {
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
  const results = [];

  while (true) {
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.results?.length) {
      results.push(...json.results);
    }

    if (json.next_page_token) {
      // Google pide ~2s antes de usar next_page_token
      await sleep(2000);
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${json.next_page_token}&key=${GOOGLE_API_KEY}`;
    } else {
      break;
    }
  }
  return results;
}

async function getPlaceDetails(place_id) {
  const fields = [
    'name', 'formatted_address', 'formatted_phone_number',
    'website', 'geometry/location'
  ].join(',');
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&key=${GOOGLE_API_KEY}`;
  const resp = await fetch(url);
  const json = await resp.json();
  return json.result || {};
}

// ------------------ Express ------------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Endpoint de salud
app.get('/', (req, res) => {
  res.send('Glow Market Hunter API activa ✅');
});

// POST /run-city
// body: { country, city, categories?: string[] }
app.post('/run-city', async (req, res) => {
  const { country, city, categories = ['barberías', 'salones de belleza', 'spas'] } = req.body || {};

  if (!country || !city) {
    return res.status(400).json({ error: "Faltan 'country' o 'city'." });
  }

  const sheetTitle = normalizeTitle(city, country); // <-- "Ciudad, País"
  try {
    // 1) Garantiza pestaña + encabezado
    await ensureSheetExists(SHEET_ID, sheetTitle);
    await ensureHeaderRow(SHEET_ID, sheetTitle);

    // 2) place_ids ya existentes (para deduplicar)
    const existing = await getExistingPlaceIds(SHEET_ID, sheetTitle);

    // 3) Buscar y preparar filas
    const perCategorySummary = [];
    const rowsToAppend = [];

    for (const category of categories) {
      const q = `${category} ${city} ${country}`;
      const found = await textSearchAllPages(q);

      let added = 0;
      for (const r of found) {
        const pid = r.place_id || '';
        if (!pid || existing.has(pid)) continue; // dedupe + ignora vacíos

        // details
        const details = await getPlaceDetails(pid);
        const name = details.name || r.name || 'N/A';
        const address = details.formatted_address || r.formatted_address || 'N/A';
        const phone = details.formatted_phone_number || 'N/A';
        const website = details.website || 'N/A';
        const lat = details.geometry?.location?.lat ?? r.geometry?.location?.lat ?? '';
        const lng = details.geometry?.location?.lng ?? r.geometry?.location?.lng ?? '';

        const row = [
          new Date().toISOString(),
          country,
          city,
          category,
          name,
          phone,
          website,
          lat,
          lng,
          address,
          pid,
          'Glow Places'
        ];
        rowsToAppend.push(row);
        existing.add(pid);
        added++;
      }

      perCategorySummary.push({ category, found: found.length, added });
    }

    // 4) Append
    const { updated } = await appendRows(SHEET_ID, sheetTitle, rowsToAppend);

    return res.json({
      status: 'ok',
      sheetName: sheetTitle,
      total_found: perCategorySummary.reduce((a, c) => a + c.found, 0),
      total_added: updated,
      per_category: perCategorySummary,
      note: `Pestaña creada/actualizada con nombre de la ciudad. Encabezado garantizado.`
    });
  } catch (e) {
    console.error('run-city error:', e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
});

// Arranque
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log(`Your service is live 🎉`);
});
