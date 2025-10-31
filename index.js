// index.js
// Glow Market Hunter - versión ciudad
// ------------------------------------------------------------
// Hace 3 cosas principales:
// 1. /places/city-search      -> busca negocios en una ciudad completa
// 2. /sheets/append           -> guarda filas en la pestaña de esa ciudad en Google Sheets
// 3. /openapi.json            -> describe esta API para que el agente la entienda
//
// IMPORTANTE:
// Environment variables necesarias en Render:
//   GOOGLE_API_KEY
//   GOOGLE_SERVICE_ACCOUNT_JSON   (JSON del service account, en una sola línea)
//   SHEET_ID
//   PUBLIC_URL (por ejemplo "https://glow-market-hunter.onrender.com")
//
// También asegurate que en el Google Sheet exista una pestaña con el NOMBRE EXACTO de la ciudad
// (por ejemplo "Bogotá") y que la fila 1 tenga estas columnas:
//
// timestamp | country | city | category | business_name | phone | address | lat | lng | rating | place_id | source
//
// El orden TIENE que coincidir con el orden que mandamos en rows.
//

import express from "express";
import cors from "cors";
import { google } from "googleapis";

// ------------------------------------------------------------
// Setup básico de Express
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json()); // para leer JSON en POST

const PORT = process.env.PORT || 10000;

// ------------------------------------------------------------
// Configuración de Google Sheets (Service Account)
// ------------------------------------------------------------

// Esta variable viene de Render > Environment > GOOGLE_SERVICE_ACCOUNT_JSON
// Ejemplo de valor (todo en una sola línea):
// {
//   "type": "...",
//   "project_id": "...",
//   "private_key_id": "...",
//   "private_key": "-----BEGIN PRIVATE KEY-----\n...",
//   "client_email": "...",
//   "client_id": "...",
//   "auth_uri": "...",
//   "token_uri": "...",
//   "auth_provider_x509_cert_url": "...",
//   "client_x509_cert_url": "..."
// }
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido o no está seteado.");
  serviceAccount = null;
}

// Creamos el cliente JWT para acceder a Sheets
const sheetsAuth = serviceAccount
  ? new google.auth.JWT(
      serviceAccount.client_email,
      null,
      serviceAccount.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    )
  : null;

// Creamos el cliente de Google Sheets
const sheetsClient = sheetsAuth
  ? google.sheets({ version: "v4", auth: sheetsAuth })
  : null;

// ------------------------------------------------------------
// Helper: construir fila lista para ir al Sheet
// ------------------------------------------------------------
//
// Orden de columnas que vamos a mandar a Google Sheets:
//   A: timestamp
//   B: country
//   C: city
//   D: category
//   E: business_name
//   F: phone
//   G: address
//   H: lat
//   I: lng
//   J: rating
//   K: place_id
//   L: source
//
// IMPORTANTE: este orden TIENE que coincidir con la fila 1 de cada pestaña ciudad.
//

function mapPlaceToRow(place, opts) {
  // opts = { timestamp, country, city, category }
  return [
    opts.timestamp,                                   // timestamp
    opts.country,                                     // country
    opts.city,                                        // city
    opts.category,                                    // category
    place.name || "",                                 // business_name
    place.formatted_phone_number || "",               // phone (puede venir vacío en textsearch)
    place.formatted_address || place.vicinity || "",  // address
    place.geometry?.location?.lat || "",              // lat
    place.geometry?.location?.lng || "",              // lng
    place.rating || "",                               // rating
    place.place_id || "",                             // place_id
    "Glow Places",                                    // source
  ];
}

// ------------------------------------------------------------
// ENDPOINT: /places/city-search
// ------------------------------------------------------------
// Busca en Google Places usando "category city country"
// Ejemplo de body:
// {
//   "city": "Bogotá",
//   "country": "Colombia",
//   "category": "barberías"
// }
//
// Respuesta:
// {
//   "status": "success",
//   "tab_name": "Bogotá",
//   "rows": [
//      ["2025-10-31T16:40:00Z","Colombia","Bogotá","barberías","Barber Shop Titan","+57 ...","Cra 13 # 88-20, Bogotá","4.5","4.676","-74.058","ChIJxxxxID","Glow Places"],
//      ...
//   ]
// }
//
app.post("/places/city-search", async (req, res) => {
  try {
    const { city, country, category } = req.body;

    if (!city || !country || !category) {
      return res
        .status(400)
        .json({ error: "city, country y category son requeridos" });
    }

    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) {
      return res
        .status(500)
        .json({ error: "Falta GOOGLE_API_KEY en environment variables" });
    }

    // Ejemplo de query: "barberías Bogotá Colombia"
    const query = `${category} ${city} ${country}`;

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&key=${GOOGLE_API_KEY}`;

    // Node 22+ ya trae fetch global
    const r = await fetch(url);
    const data = await r.json();

    const timestamp = new Date().toISOString();

    // Mapear cada resultado de Google Places a la fila esperada por Sheets
    const rows = (data.results || []).map((place) =>
      mapPlaceToRow(place, {
        timestamp,
        country,
        city,
        category,
      })
    );

    return res.json({
      status: "success",
      tab_name: city, // nombre de la pestaña del Sheet donde van estas filas
      rows,
      raw_count: rows.length,
    });
  } catch (err) {
    console.error("city-search error:", err);
    return res.status(500).json({
      error: err.message || "Error interno en /places/city-search",
    });
  }
});

// ------------------------------------------------------------
// ENDPOINT: /sheets/append
// ------------------------------------------------------------
// Inserta filas en una pestaña específica del Google Sheet.
// Body esperado:
// {
//   "tab_name": "Bogotá",
//   "rows": [
//      ["2025-10-31T16:40:00Z","Colombia","Bogotá","barberías","Barber Shop Titan","+57 ...","Cra 13 # 88-20, Bogotá","4.5","4.676","-74.058","ChIJxxxxID","Glow Places"],
//      ...
//   ]
// }
//
// IMPORTANTE: la pestaña (sheet/tab) "Bogotá" DEBE existir ya, y la fila 1 de esa pestaña
// debe tener exactamente estas columnas:
//
// timestamp | country | city | category | business_name | phone | address | lat | lng | rating | place_id | source
//
app.post("/sheets/append", async (req, res) => {
  try {
    if (!sheetsClient || !sheetsAuth) {
      return res.status(500).json({
        error:
          "Google Sheets client no inicializado. Revisa GOOGLE_SERVICE_ACCOUNT_JSON.",
      });
    }

    const { tab_name, rows } = req.body;
    if (!tab_name || !rows || !Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({ error: "tab_name y rows son requeridos, rows no puede ser vacío" });
    }

    const SHEET_ID = process.env.SHEET_ID;
    if (!SHEET_ID) {
      return res
        .status(500)
        .json({ error: "Falta SHEET_ID en environment variables" });
    }

    // Ejemplo: "Bogotá!A1:L1" porque tenemos 12 columnas (A..L)
    const range = `${tab_name}!A1:L1`;

    // Append en la pestaña
    const response = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: rows,
      },
    });

    return res.json({
      status: "ok",
      updates: response.data.updates || null,
    });
  } catch (err) {
    console.error("sheets append error:", err);
    return res.status(500).json({
      error: err.message || "Error interno en /sheets/append",
    });
  }
});

// ------------------------------------------------------------
// ENDPOINT OPCIONAL: /places/details (enriquecer datos)
// ------------------------------------------------------------
// Esto es opcional. Lo dejamos vivo por si más adelante querés
// pedir más info (teléfono, horario, etc.) place por place_id.
// Sigue el mismo patrón que tu versión anterior.
//
// Espera body:
// { "place_ids": ["abc123", "xyz999", ...] }
//
// Devuelve un array con detalles básicos.
//
app.post("/places/details", async (req, res) => {
  try {
    const { place_ids } = req.body;
    if (!Array.isArray(place_ids) || place_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "place_ids debe ser un array con al menos 1 id" });
    }

    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) {
      return res
        .status(500)
        .json({ error: "Falta GOOGLE_API_KEY en environment variables" });
    }

    const detailsResults = [];

    for (const pid of place_ids) {
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(
        pid
      )}&fields=name,formatted_phone_number,formatted_address,geometry,website,rating,international_phone_number,opening_hours&key=${GOOGLE_API_KEY}`;

      const r = await fetch(detailsUrl);
      const data = await r.json();

      detailsResults.push({
        place_id: pid,
        result: data.result || {},
        status: data.status || "",
      });
    }

    return res.json({
      status: "success",
      results: detailsResults,
    });
  } catch (err) {
    console.error("places details error:", err);
    return res.status(500).json({
      error: err.message || "Error interno en /places/details",
    });
  }
});

// ------------------------------------------------------------
// ENDPOINT: /openapi.json
// ------------------------------------------------------------
// Esto le dice al agente (MCP / custom tool) qué endpoints existen
// y qué body debe mandar.
//
// MUY IMPORTANTE: Acá describimos /places/city-search y /sheets/append
// con la nueva lógica.
//
app.get("/openapi.json", (req, res) => {
  const publicUrl = process.env.PUBLIC_URL || "https://glow-market-hunter.onrender.com";

  const spec = {
    openapi: "3.0.0",
    info: {
      title: "Glow Market Hunter API",
      version: "2.0.0",
      description:
        "API interna para buscar negocios por ciudad y guardar leads en Google Sheets por pestaña de ciudad.",
    },
    servers: [
      {
        url: publicUrl,
      },
    ],
    paths: {
      "/places/city-search": {
        post: {
          summary:
            "Buscar negocios en una ciudad completa usando Google Places (por categoría + ciudad + país).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    city: {
                      type: "string",
                      description: "Nombre de la ciudad. Ej: 'Bogotá'",
                    },
                    country: {
                      type: "string",
                      description: "Nombre del país. Ej: 'Colombia'",
                    },
                    category: {
                      type: "string",
                      description:
                        "Tipo de negocio a buscar. Ej: 'barberías', 'spas', 'salones de belleza'.",
                    },
                  },
                  required: ["city", "country", "category"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "OK. Devuelve tab_name (igual al nombre de la ciudad) y rows (listas listas para Google Sheets).",
            },
          },
        },
      },

      "/sheets/append": {
        post: {
          summary:
            "Insertar filas en la pestaña de ciudad correspondiente en Google Sheets.",
          description:
            "tab_name debe ser EXACTAMENTE el nombre de la pestaña en el Spreadsheet (ej: 'Bogotá'). rows debe ser un array de arrays alineado con las columnas.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tab_name: {
                      type: "string",
                      description:
                        "Nombre de la pestaña del Sheet donde se van a insertar las filas. Ej: 'Bogotá'",
                    },
                    rows: {
                      type: "array",
                      items: {
                        type: "array",
                        items: {
                          type: "string",
                        },
                      },
                      description:
                        "Cada fila debe seguir el orden: [timestamp, country, city, category, business_name, phone, address, lat, lng, rating, place_id, source]",
                    },
                  },
                  required: ["tab_name", "rows"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "OK. Devuelve updates de Google Sheets con info de inserción.",
            },
          },
        },
      },

      "/places/details": {
        post: {
          summary:
            "Obtener detalles extra de un place_id (teléfono, horario, etc.).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    place_ids: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Lista de place_ids de Google Places para enriquecer datos (teléfono, horario, etc.).",
                    },
                  },
                  required: ["place_ids"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "OK. Devuelve un array con detalles para cada place_id solicitado.",
            },
          },
        },
      },
    },
  };

  res.json(spec);
});

// ------------------------------------------------------------
// ENDPOINT raíz "/" -> healthcheck rápido
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ Glow Market Hunter API activa y funcionando (versión ciudad)");
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  console.log("Your service is live 🎉");
  console.log(`Available at your primary URL (openapi): ${process.env.PUBLIC_URL || "https://glow-market-hunter.onrender.com"}/openapi.json`);
});
