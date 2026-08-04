/**
 * Recolector de mercado de soya — ALEN+PRO
 * --------------------------------------------------
 * Corre en GitHub Actions 2 veces al día. Usa SOLO fuentes públicas y
 * gratuitas (sin API de pago):
 *   - CBOT: Yahoo Finance
 *   - Noticias: RSS de Agri-Pulse
 *   - Argentina: precios de pizarra de la Bolsa de Comercio de Rosario (BCR)
 *   - Brasil: indicador CEPEA/ESALQ Paranaguá republicado por Notícias Agrícolas,
 *     + USD/BRL de Yahoo Finance
 * Arma un único snapshot JSON y lo escribe en Firebase usando el Admin SDK
 * (cuenta de servicio). El visor solo LEE ese snapshot.
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
/* Agri-Pulse publica en inglés; el visor debe mostrar todo en español,
   así que cada titular/cuerpo se traduce vía MyMemory (API gratuita,
   sin clave, límite ~5000 palabras/día anónimo — de sobra para 5 noticias
   2 veces al día). Si la traducción falla, se deja el texto original en
   inglés antes que romper la sección. */
async function translateToEs(text) {
  if (!text) return text;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|es`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const translated = data && data.responseData && data.responseData.translatedText;
    return translated ? decodeEntities(translated) : text;
  } catch (e) {
    console.error("Traducción falló:", e.message);
    return text;
  }
}
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
  const rawItems = blocks.slice(0, 5).map(block => ({
    source: "Agri-Pulse",
    date: formatRssDate(extractTag(block, "pubDate")),
    headline: extractTag(block, "title"),
    body: extractTag(block, "description").slice(0, 220)
  })).filter(n => n.headline);
  if (!rawItems.length) throw new Error("RSS sin items");

  const items = await Promise.all(rawItems.map(async n => ({
    ...n,
    headline: await translateToEs(n.headline),
    body: await translateToEs(n.body)
  })));
  return { items };
}

/* ---------- Argentina vía BCR (gratis, sin clave) ---------- */
function parseArNumber(s) {
  // Formato argentino/brasileño: "515.000,00" -> 515000.00
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
}

async function fetchArgentina() {
  const url = "https://www.cac.bcr.com.ar/es/precios-de-pizarra";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`BCR HTTP ${res.status}`);
  const html = await res.text();
  const startIdx = html.indexOf("board board-soja");
  if (startIdx === -1) throw new Error("BCR: no se encontró el bloque de soja");
  const block = html.slice(startIdx, startIdx + 700);
  const priceM = block.match(/<div class="price">\s*\$([\d.,]+)\s*<\/div>/);
  const usdM = block.match(/US\$<\/strong>\s*([\d.,]+)/);
  if (!priceM) throw new Error("BCR: no se encontró el precio de pizarra");
  return {
    pizarra_ars: parseArNumber(priceM[1]),
    pizarra_usd: usdM ? parseArNumber(usdM[1]) : null,
    matba: null,
    campo: null,
    politica: null
  };
}

/* ---------- Brasil vía Notícias Agrícolas (indicador CEPEA/ESALQ, gratis) ---------- */
/* El indicador diario puede venir sin signo cuando la variación es 0,00%, y la
   maquetación de la página (ads, espacios) varía de una carga a otra, así que
   la fila se busca en la tabla completa (hasta </table>) en vez de un recorte
   fijo, y el signo +/- del porcentaje se trata como opcional. */
async function fetchBrasilOnce() {
  const url = "https://www.noticiasagricolas.com.br/cotacoes/soja/soja-indicador-cepea-esalq-porto-paranagua";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Notícias Agrícolas HTTP ${res.status}`);
  const html = await res.text();
  const tblIdx = html.indexOf('class="cot-fisicas"');
  if (tblIdx === -1) throw new Error("CEPEA: no se encontró la tabla");
  const endIdx = html.indexOf("</table>", tblIdx);
  const block = html.slice(tblIdx, endIdx === -1 ? tblIdx + 2000 : endIdx + 9);
  const rowM = block.match(/<td>\s*([\d/]+)\s*<\/td>\s*<td>\s*([\d,]+)\s*<\/td>\s*<td>\s*([+-]?[\d,]+)\s*<\/td>/);
  if (!rowM) throw new Error("CEPEA: no se pudo parsear la fila de datos");

  let usdbrl = null;
  try { usdbrl = (await fetchYahoo("BRL=X")).price; }
  catch (e) { console.error("USD/BRL fetch falló:", e.message); }

  return {
    cepea_brl_saca: parseArNumber(rowM[2]),
    cepea_var_pct: parseArNumber(rowM[3]),
    premio: null,
    campo: null,
    usdbrl
  };
}

async function fetchBrasil() {
  try {
    return await fetchBrasilOnce();
  } catch (e) {
    console.error("Brasil (1er intento) falló:", e.message, "— reintentando…");
    return await fetchBrasilOnce();
  }
}

/* ---------- main ---------- */
(async () => {
  console.log("Recolectando snapshot de mercado de soya (fuentes gratuitas)…");

  const [cbot, news, arg, bra] = await Promise.all([
    safe("CBOT",      fetchCBOT),
    safe("Noticias",  fetchNews),
    safe("Argentina", fetchArgentina),
    safe("Brasil",    fetchBrasil),
  ]);

  // WASDE y balance quincenal siguen sin fuente gratuita confiable: quedan
  // fuera del snapshot. El visor las muestra como "sin datos" sin romperse.
  const snapshot = { actualizado: new Date().toISOString(), cbot, news, arg, bra };

  await db.ref("mercado-soya/latest").set(snapshot);
  const key = snapshot.actualizado.replace(/[.:]/g, "-");
  await db.ref("mercado-soya/historico/" + key).set(snapshot);

  console.log("✓ Snapshot escrito en Firebase:", snapshot.actualizado);
  process.exit(0);
})().catch(e => { console.error("ERROR FATAL:", e.message); process.exit(1); });
