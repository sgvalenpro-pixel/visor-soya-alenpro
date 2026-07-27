/**
 * Recolector de mercado de soya — ALEN+PRO
 * --------------------------------------------------
 * Corre en GitHub Actions 2 veces al día. Consulta el API de Anthropic
 * (con web_search) para CBOT, Argentina, Brasil, noticias y el balance
 * quincenal, arma un único snapshot JSON y lo escribe en Firebase usando
 * el Admin SDK (cuenta de servicio). El visor solo LEE ese snapshot.
 *
 * Secrets del repositorio:
 *   ANTHROPIC_API_KEY         -> clave del API de Anthropic
 *   FIREBASE_DB_URL           -> https://TU-PROYECTO-default-rtdb.firebaseio.com
 *   FIREBASE_SERVICE_ACCOUNT  -> contenido COMPLETO del JSON de la cuenta de servicio
 *
 * Requiere Node 18+ y el paquete firebase-admin (ver package.json).
 */

const admin = require("firebase-admin");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
const MODEL = "claude-sonnet-4-6";

if (!ANTHROPIC_API_KEY)   { console.error("Falta ANTHROPIC_API_KEY"); process.exit(1); }
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

/* ---------- helper: pregunta a Claude y devuelve JSON ---------- */
async function askClaude(prompt, maxTokens = 1200) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === "text").map(b => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("Respuesta sin JSON:\n" + text.slice(0, 300));
  return JSON.parse(clean.slice(a, b + 1));
}

/* corre una sección con manejo de error: nunca tumba el resto */
async function safe(label, fn) {
  try { const v = await fn(); console.log(`✓ ${label}`); return v; }
  catch (e) { console.error(`✗ ${label}: ${e.message}`); return { error: e.message }; }
}

/* ---------- prompts (idénticos al visor; "torta de soya" siempre) ---------- */
const P = {
  cbot: `Busca en la web los precios MÁS RECIENTES (hoy o último cierre) de los futuros de soya en CBOT/CME (barchart.com, cmegroup.com, investing.com). Necesito:
1. Frijol soya (ZS) contrato más cercano: centavos USD por bushel, cambio del día y %
2. Torta de soya / Soybean Meal SBM (ZM) contrato más cercano: USD por tonelada corta, cambio, %
3. Aceite de soya (ZL) contrato más cercano: centavos USD por libra, cambio, %
4. Comentario breve (máx 2 frases, español) sobre qué movió el mercado. Usa siempre "torta de soya" para el SBM, nunca "harina de soya".
Responde ÚNICAMENTE JSON válido sin markdown:
{"soybean":{"month":"Jul 26","price":1050.25,"change":-3.5,"pct":-0.33},"meal":{"month":"Jul 26","price":295.4,"change":1.2,"pct":0.41},"oil":{"month":"Jul 26","price":47.85,"change":-0.4,"pct":-0.83},"comment":"..."}`,

  arg: `Busca en la web la información MÁS RECIENTE del mercado de soya en ARGENTINA (Bolsa de Comercio de Rosario bcr.com.ar, MATBA-ROFEX, agrofy, infocampo, Reuters). Necesito:
1. Pizarra/cámara de soya disponible en Rosario en ARS por tonelada (y equivalente USD/ton si está)
2. Futuro de soya MATBA-ROFEX posición más operada en USD/ton si está
3. Estado de cosecha/campaña y comercialización (1-2 frases español)
4. Novedad de política (retenciones/derechos de exportación, tipo de cambio) si la hay (1 frase o null)
Responde ÚNICAMENTE JSON válido sin markdown:
{"pizarra_ars":350000,"pizarra_usd":290,"matba":{"position":"Jul 26","price_usd":292.5},"campo":"...","politica":"..."}
Usa null si un valor no está disponible.`,

  bra: `Busca en la web la información MÁS RECIENTE del mercado de soya en BRASIL (CEPEA/ESALQ cepea.esalq.usp.br, Notícias Agrícolas, Canal Rural, Reuters). Necesito:
1. Indicador CEPEA/ESALQ soya Paranaguá en BRL por saca de 60 kg, con variación diaria si está
2. Premio/basis FOB Paranaguá sobre Chicago si hay dato reciente, o null
3. Estado de cosecha/siembra y comercialización de la campaña (1-2 frases español)
4. Tipo de cambio USD/BRL actual
Responde ÚNICAMENTE JSON válido sin markdown:
{"cepea_brl_saca":131.5,"cepea_var_pct":-0.4,"premio":"+45 ¢/bu Ago","campo":"...","usdbrl":5.42}
Usa null si un valor no está disponible.`,

  news: `Busca en la web las noticias MÁS RECIENTES (últimos 3-4 días) sobre el mercado mundial del frijol soya y su complejo (torta de soya/SBM, aceite). Prioriza: USDA (WASDE, ventas de exportación), demanda de China, clima en EE.UU./Brasil/Argentina, logística, biocombustibles, USSEC/U.S. Soy. Dame 5 noticias. Usa siempre "torta de soya" para el SBM, nunca "harina de soya".
Responde ÚNICAMENTE JSON válido sin markdown:
{"items":[{"source":"Reuters","date":"10 jun","headline":"titular en español","body":"resumen de 1 frase en español"}]}`,

  balance: `Actúa como analista senior del mercado de soya (estilo de los balances quincenales que presentan analistas de USSEC / U.S. Soy a compradores latinoamericanos). Busca en la web información de las ÚLTIMAS DOS SEMANAS del complejo soya: último WASDE del USDA, ventas semanales de exportación de EE.UU., avance de campaña y clima en Brasil y Argentina, demanda de China, márgenes de molienda (crush), aceite y biocombustibles.
Escribe en ESPAÑOL para un comprador industrial de soya en Colombia. Sé concreto con cifras. Usa siempre "torta de soya" para el SBM, nunca "harina de soya".
Responde ÚNICAMENTE JSON válido sin markdown:
{"sesgo":"alcista|bajista|neutral","resumen":"3-4 frases lectura general","eeuu":"2-3 frases: WASDE, exportaciones, crush, clima","brasil":"2-3 frases: campaña, logística, premios","argentina":"2-3 frases: campaña, comercialización, política","demanda":"2 frases: China, aceites, biocombustible","implicacion":"2-3 frases: qué significa para un comprador en Colombia","factores":[{"texto":"factor clave corto","tipo":"alcista|bajista|neutral"}]}`,

  wasde: `Busca en la web el reporte WASDE (World Agricultural Supply and Demand Estimates) MÁS RECIENTE del USDA (usda.gov, fas.usda.gov, o coberturas de Reuters/DTN/Farmdoc sobre el reporte). Necesito, para SOYA en EE.UU.:
1. Nombre/fecha del reporte y fecha del PRÓXIMO reporte WASDE
2. Sesgo general para soya del reporte (alcista/bajista/neutral/moderadamente alcista/moderadamente bajista, con 1-2 palabras de motivo)
3. Producción de soya (millones de bushels, con variación interanual o vs. mes previo si está)
4. Rinde promedio (bu/acre), con nota de si cambió o no vs. el reporte anterior
5. Stocks finales (ending stocks) de soya en millones de bushels, con nota de si cambió o no
6. Cambio en la proyección de exportaciones de soya (millones de bushels, motivo breve)
7. Resumen de 2-4 frases en español sobre qué significó el reporte para soya
8. 1-2 frases en español sobre maíz y trigo (stocks, cosecha) si compiten por área/demanda con la soya, o null
Responde ÚNICAMENTE JSON válido sin markdown:
{"reporte":"WASDE de julio 2026 (10 jul)","proximo":"12 de agosto de 2026","sesgo":"moderadamente alcista","soya_prod":"4.475 M bu — récord potencial (+5% interanual, 85,4 M acres)","soya_yield":"53,0 bu/acre (sin cambios)","soya_stocks":"310 M bu (sin cambios; más oferta compensada con más uso)","soya_export":"subidas 30 M bu por mayor demanda global","resumen":"...","otros_granos":"..."}
Usa null si un valor no está disponible.`,

  exports: `Busca en la web el reporte semanal MÁS RECIENTE de ventas de exportación de EE.UU. (USDA FAS Export Sales, fas.usda.gov/data/export-sales, o coberturas de Reuters/DTN/Brownfield sobre el reporte). Necesito, para la semana reportada:
1. Rango de fechas de la semana y fecha de publicación del reporte
2. Frijol soya (soybeans): volumen vendido (toneladas o miles de toneladas, distinguiendo ciclo viejo/nuevo si aplica), principal país comprador con su volumen, y tendencia (fuerte/débil/en línea, vs. semana previa o promedio)
3. Torta de soya (soybean meal): mismo detalle (volumen, principal comprador, tendencia). Usa siempre "torta de soya", nunca "harina de soya".
4. Aceite de soya (soybean oil): mismo detalle (volumen, principal comprador, tendencia)
5. Comentario breve (2-3 frases, español) sobre qué implica la semana para el mercado, priorizando cualquier mención de Colombia como comprador
Responde ÚNICAMENTE JSON válido sin markdown:
{"semana":"Semana al 9 jul (reporte del 16 jul)","sb":{"vol":"1,77 M t (nueva cosecha 2026/27) · vieja 188.300 t","destino":"China (1,06 M t)","tendencia":"fuerte en nueva cosecha"},"sbm":{"vol":"177.000 t","destino":"Colombia (151.900 t)","tendencia":"-22% sem / -22% vs 4 sem"},"sbo":{"vol":"reducción neta de 300 t","destino":"México (700 t)","tendencia":"muy débil"},"comment":"..."}
Usa null si un valor no está disponible.`
};

/* ---------- main ---------- */
(async () => {
  console.log("Recolectando snapshot de mercado de soya…");

  const [cbot, arg, bra, news, balance, wasde, exports_] = await Promise.all([
    safe("CBOT",         () => askClaude(P.cbot)),
    safe("Argentina",    () => askClaude(P.arg)),
    safe("Brasil",       () => askClaude(P.bra)),
    safe("Noticias",     () => askClaude(P.news)),
    safe("Balance",      () => askClaude(P.balance, 1600)),
    safe("WASDE",        () => askClaude(P.wasde)),
    safe("Exportaciones",() => askClaude(P.exports)),
  ]);

  const snapshot = { actualizado: new Date().toISOString(), cbot, arg, bra, news, balance, wasde, exports: exports_ };

  await db.ref("mercado-soya/latest").set(snapshot);
  const key = snapshot.actualizado.replace(/[.:]/g, "-");
  await db.ref("mercado-soya/historico/" + key).set(snapshot);

  console.log("✓ Snapshot escrito en Firebase:", snapshot.actualizado);
  process.exit(0);
})().catch(e => { console.error("ERROR FATAL:", e.message); process.exit(1); });
