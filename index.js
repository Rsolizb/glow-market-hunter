import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// Clave de Google Places
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Buscar lugares (por texto o zona)
app.post("/places/search", async (req, res) => {
  try {
    const { query, lat, lng, radius } = req.body;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&location=${lat},${lng}&radius=${radius || 5000}&key=${GOOGLE_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    const results = data.results.map((x) => ({
      place_id: x.place_id,
      name: x.name,
      address: x.formatted_address,
    }));
    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Obtener detalles de cada negocio
app.post("/places/details", async (req, res) => {
  try {
    const { place_ids } = req.body;
    const results = [];

    for (const id of place_ids) {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&fields=name,formatted_address,international_phone_number,website,geometry&key=${GOOGLE_API_KEY}`;
      const r = await fetch(url);
      const d = await r.json();
      const x = d.result;

      results.push({
        name: x.name,
        address: x.formatted_address,
        phone: x.international_phone_number || "",
        website: x.website || "",
        lat: x.geometry?.location?.lat,
        lng: x.geometry?.location?.lng,
        place_id: id,
      });
    }

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("✅ Glow Market Hunter API activa y funcionando");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor activo en puerto", PORT));
