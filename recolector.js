/**
 * Recolector de mercado de soya — ALEN+PRO
 * --------------------------------------------------
 * Corre en GitHub Actions 2 veces al día. Usa SOLO fuentes públicas y
 * gratuitas (sin API de pago): Yahoo Finance para CBOT y un feed RSS
 * para noticias. Arma un único snapshot JSON y lo escribe en Firebase
 * usando el Admin SDK (cuenta de servicio). El visor solo LEE ese snapshot.
 *
 * Argentina, Brasil, el balance quincenal (análisis en prosa) y el WASDE
 * quedan sin implementar por ahora: no hay API pública gratuita para
 * Rosario/CEPEA, y el dominio usda.gov bloquea tráfico automatizado
 * (403) en las URLs de datos históricos de WASDE. El visor ya maneja
 * estas secciones como "sin datos" sin romperse.
 *
 * Secrets del repositorio:
 *   FIREBASE_DB_URL           -> https://TU-PROYECTO-default-rtdb.firebaseio.com
 *   FIREBASE_SERVICE_ACCOUNT  -> contenido COMPLETO del JSON de la cuenta de servicio
 *
 * Requiere Node 18+ y el paquete firebase-admin (ver package.json).
 */

const admin = require("firebase-admin");

const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

if (!FIREBASE_DB_URL)     { console.error("Falta FIREBASE_DB_URL"); process.exit(1); }
if (!SERVICE_ACCOUNT_RAW) { console.error("Falta FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }

/* ---------- inicializar Firebase Admin ---------- */
let serviceAccount;
try { serviceAccount = JSON.parse(SERVICE_ACCOUNT_RAW); }
catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT no es un JSON válido:", e.message); process.exit(1); }

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});
const db = admin.database();

/* corre una sección con manejo de error: nunca tumba el resto */
async function safe(label, fn) {
  try { const v = await fn(); console.log(`✓ ${label}`); return v; }
  catch (e) { console.error(`✗ ${label}: ${e.message}`); return { error: e.message }; }
}

/* ---------- CBOT vía Yahoo Finance (gratis, sin clave) ---------- */
const MES_ES = { Jan:"Ene", Feb:"Feb", Mar:"Mar", Apr:"Abr", May:"May", Jun:"Jun",
                  Jul:"Jul", Aug:"Ago", Sep:"Sep", Oct:"Oct", Nov:"Nov", Dec:"Dic" };

function mesContrato(shortName) {
  const m = (shortName || "").match(/,(\w{3})-(\d{4})/);
  if (!m) return "";
  return `${MES_ES[m[1]] || m[1]} ${m[2].slice(2)}`;
}

async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) throw new Error(`Yahoo ${ticker}: respuesta vacía`);
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  if (price == null || prevClose == null) throw new Error(`Yahoo ${ticker}: sin precio`);
  const change = price - prevClose;
  const pct = prevClose ? (change / prevClose) * 100 : null;
  return { month: mesContrato(meta.shortName), price, change, pct };
}

async function fetchCBOT() {
  const [soybean, meal, oil] = await Promise.all([
    fetchYahoo("ZS=F"),
    fetchYahoo("ZM=F"),
    fetchYahoo("ZL=F"),
  ]);
  return {
    soybean, meal, oil,
    comment: "Datos en vivo de Yahoo Finance (fuente automática, sin comentario editorial)."
  };
}

/* ---------- Noticias vía RSS (gratis, sin clave) ---------- */
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
           .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function stripCdata(s) {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : s;
}
function stripTags(s) { return s.replace(/<[^>]+>/g, "").trim(); }
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(stripTags(stripCdata(m[1].trim()))) : "";
}
function formatRssDate(raw) {
  const d = new Date(raw);
  if (isNaN(d)) return raw;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

async function fetchNews() {
  const url = "https://www.agri-pulse.com/rss/topic/106-international";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items = blocks.slice(0, 5).map(block => ({
    source: "Agri-Pulse",
    date: formatRssDate(extractTag(block, "pubDate")),
    headline: extractTag(block, "title"),
    body: extractTag(block, "description").slice(0, 220)
  })).filter(n => n.headline);
  if (!items.length) throw new Error("RSS sin items");
  return { items };
}

/* ---------- main ---------- */
(async () => {
  console.log("Recolectando snapshot de mercado de soya (fuentes gratuitas)…");

  const [cbot, news] = await Promise.all([
    safe("CBOT",     fetchCBOT),
    safe("Noticias", fetchNews),
  ]);

  // Secciones aún sin fuente gratuita confiable: quedan fuera del snapshot.
  // El visor las muestra como "sin datos" sin romperse.
  const snapshot = { actualizado: new Date().toISOString(), cbot, news };

  await db.ref("mercado-soya/latest").set(snapshot);
  const key = snapshot.actualizado.replace(/[.:]/g, "-");
  await db.ref("mercado-soya/historico/" + key).set(snapshot);

  console.log("✓ Snapshot escrito en Firebase:", snapshot.actualizado);
  process.exit(0);
})().catch(e => { console.error("ERROR FATAL:", e.message); process.exit(1); });
