// index.js (versión ciudad + categoría)
// -------------------------------------------------
// IMPORTS Y SETUP BÁSICO
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";

// Cargar variables de entorno desde Render
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// App
const app = express();
app.use(bodyParser.json());
app.use(cors());

// -------------------------------------------------
// GOOGLE SHEETS AUTH
// Vamos a usar la cuenta de servicio para escribir en la hoja
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  if (!SERVICE_ACCOUNT_JSON) {
    throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON en env");
  }

  // SERVICE_ACCOUNT_JSON es un string con JSON adentro.
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// -------------------------------------------------
// HELPER: normalizar teléfono (puede venir undefined)
function safe(v) {
  if (v === undefined || v === null) return "N/A";
  if (v === "") return "N/A";
  return v;
}

// -------------------------------------------------
// RUTA 1: Buscar negocios por CIUDAD COMPLETA
// POST /places/search-city
//
// Body que enviamos:
// {
//   "city": "Bogotá, Colombia",
//   "category": "barberías"
// }
//
// Lo que hace:
// - arma el query: `${category} ${city}`
// - llama a Google Places Text Search (búsqueda por texto)
// - retorna lista con datos limpios
//
app.post("/places/search-city", async (req, res) => {
  try {
    const { city, category } = req.body;

    if (!city || !category) {
      return res.status(400).json({
        error: "Falta 'city' o 'category' en el body. Ej: { city:'Bogotá, Colombia', category:'barberías' }"
      });
    }

    // query tipo: "barberías Bogotá, Colombia"
    const query = `${category} ${city}`;

    // Llamada a Google Places Text Search
    // Importante: agregamos fields tipo "business_status", "geometry", etc.
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&key=${GOOGLE_API_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!data.results) {
      return res.json({
        status: "ok",
        city,
        category,
        count: 0,
        results: []
      });
    }

    // Mapeamos resultados
    const cleaned = data.results.map((place, idx) => {
      return {
        idx: idx + 1,
        name: safe(place.name),
        address: safe(place.formatted_address),
        lat: place.geometry?.location?.lat ?? null,
        lng: place.geometry?.location?.lng ?? null,
        rating: place.rating ?? null,
        user_ratings_total: place.user_ratings_total ?? null,
        place_id: safe(place.place_id),
        source: "Glow Places",
        // teléfono directo no viene en textsearch, se puede pedir luego en /places/details
        phone: "N/A"
      };
    });

    res.json({
      status: "ok",
      city,
      category,
      count: cleaned.length,
      results: cleaned
    });
  } catch (e) {
    console.error("search-city error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------------
// OPCIONAL EXTRA: Obtener detalles de un place_id concreto
// (teléfono, website, horarios, etc.)
// POST /places/details
//
// Body:
// { "place_id": "XXXXX" }
//
app.post("/places/details", async (req, res) => {
  try {
    const { place_id } = req.body;
    if (!place_id) {
      return res.status(400).json({ error: "Falta place_id" });
    }

    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
      place_id
    )}&fields=name,formatted_address,international_phone_number,website,geometry,opening_hours,types&key=${GOOGLE_API_KEY}`;

    const r = await fetch(detailsUrl);
    const d = await r.json();

    res.json({
      status: "ok",
      place_id,
      details: d.result || {}
    });
  } catch (e) {
    console.error("details error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------------
// RUTA 2: Guardar filas en Google Sheets
// POST /sheets/append
//
// Body esperado:
// {
//   "city": "Bogotá, Colombia",
//   "rows": [
//      {
//        "timestamp": "2025-10-31T12:30:00Z",
//        "country": "Colombia",
//        "city": "Bogotá",
//        "category": "barberías",
//        "name": "Barbería Ejemplo",
//        "phone": "+57 123 456",
//        "website": "N/A",
//        "lat": 4.6,
//        "lng": -74.08,
//        "address": "Calle 123 #4-56, Bogotá, Colombia",
//        "place_id": "xxxxx",
//        "source": "Glow Places"
//      },
//      ...
//   ]
// }
//
// Qué hace:
// - construye un array bidimensional [[],[],[]] para Sheets
// - hace append al rango "Hoja 1!A2" (por ahora todos van ahí)
//   (luego más adelante mejoramos para crear hoja por ciudad)
//
// IMPORTANTE:
// Antes de esto la hoja debe tener encabezados en A1, B1, C1...
// Ej:
// timestamp | country | city | category | name | phone | website | lat | lng | address | place_id | source
//
app.post("/sheets/append", async (req, res) => {
  try {
    const { city, rows } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        error:
          "Falta 'rows' o está vacío. Debes mandar un array de objetos con los campos."
      });
    }

    // Convertimos cada fila (obj) en un array ordenado de columnas
    // Este orden debe coincidir con las columnas en tu Google Sheet
    const values = rows.map((obj) => [
      safe(obj.timestamp),
      safe(obj.country),
      safe(obj.city),
      safe(obj.category),
      safe(obj.name),
      safe(obj.phone),
      safe(obj.website),
      obj.lat ?? "",
      obj.lng ?? "",
      safe(obj.address),
      safe(obj.place_id),
      safe(obj.source)
    ]);

    const sheets = getSheetsClient();

    // IMPORTANTE:
    // Por ahora vamos a mandar todo a "Hoja 1", desde la columna A en adelante.
    // range: "Hoja 1!A2" le dice "empezá a meter después del header"
    const range = "Hoja 1!A2";

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values
      }
    });

    res.json({
      status: "ok",
      updates: response.data.updates || null,
      note: `Se agregaron ${values.length} filas a la hoja (ciudad: ${city}).`
    });
  } catch (e) {
    console.error("sheets append error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------------------------------------
// RUTA TEST SIMPLE
app.get("/", (req, res) => {
  res.send("Glow Market Hunter API lista (búsqueda por ciudad activa).");
});

// -------------------------------------------------
// START SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
  console.log("Available at your primary URL (openapi): /openapi.json?");
});
