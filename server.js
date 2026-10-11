require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// The Chrome extension popup calls this API from a chrome-extension:// origin,
// which is cross-origin relative to this server and requires CORS headers on
// both the preflight OPTIONS request and the actual response — without this,
// the browser blocks the request before app.js ever sees an HTTP response.
app.use(cors());

app.use(express.json({ limit: '40mb' }));
app.use(express.static(__dirname));

if(!process.env.GEMINI_API_KEY){
  console.warn('[startup] GEMINI_API_KEY is not set — /api/analyze will return an error until it is configured (see .env.example).');
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGES = 6;

function stripDataUrlPrefix(value){
  const match = /^data:[^;]+;base64,(.*)$/s.exec(value || '');
  return match ? match[1] : (value || '');
}

function isAllowedImageType(mimeType){
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

// Gemini's SDK sets err.status from the upstream HTTP status (see
// GoogleGenerativeAIFetchError). 429/503 are transient — spikes in demand or
// rate limits that usually clear within a couple seconds — so retry those
// with backoff instead of failing the request on the first hiccup.
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateContentWithRetry(model, request){
  for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
    try{
      return await model.generateContent(request);
    } catch(err){
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if(!RETRYABLE_STATUSES.has(err.status) || isLastAttempt) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[analyze] Gemini request failed with status ${err.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

function buildPrompt({ title, description, currency, hasImages }){
  return `You are a product-authenticity and pricing analyst helping a shopper evaluate a secondhand marketplace listing before they buy.

Listing details:
- Title: ${title || '(none provided)'}
- Description / notes: ${description || '(none provided)'}
- Listed currency: ${currency}

Task 1 — Retail price (MSRP) estimation:
Estimate the standard retail price (MSRP) for the product described, in ${currency}. Base this on the title, description, and (if provided) the product photos. If the exact model/variant is ambiguous, give your best-effort estimate anyway using a reasonable market baseline for the closest matching product category — do not refuse. Provide a point estimate plus a low/high range and a confidence level.

Task 2 — Image authenticity review${hasImages ? '' : ' (SKIP — no images were provided, set imageAnalysis to null)'}:
${hasImages ? `Examine the attached product photo(s) for common counterfeit red flags, specifically:
- Label/logo font, kerning, or spacing anomalies; spelling errors; misaligned or distorted logos.
- Packaging mismatches: box color/material, cap or closure material, atomizer/nozzle or hardware details inconsistent with the genuine product.
- Signs the photos are reused stock/catalog images rather than the seller's own item: inconsistent lighting, shadows, or backgrounds across photos; identical to typical product-catalog renders; no personal context (hands, real-world surface, etc).
Be calibrated and specific — cite what you actually observe in the images, not generic suspicion. This is a heuristic visual review, not a certified authentication.` : ''}

Respond with ONLY a single JSON object, no markdown fences, matching exactly this shape:
{
  "msrp": { "currency": "${currency}", "estimate": <number>, "low": <number>, "high": <number>, "confidence": "high"|"medium"|"low", "reasoning": "<one short sentence>" },
  "imageAnalysis": ${hasImages ? `{ "verdict": "pass"|"moderate"|"high", "findings": ["<short, specific observation>", "..."] }` : 'null'}
}`;
}

app.post('/api/analyze', async (req, res) => {
  const { title, description, currency, images } = req.body || {};

  if(!process.env.GEMINI_API_KEY){
    return res.status(500).json({ error: 'Vision API key not configured. Set GEMINI_API_KEY as an environment variable (see .env.example) and restart the server.' });
  }
  if(!title && !description && !(Array.isArray(images) && images.length)){
    return res.status(400).json({ error: 'Provide a title, description, or at least one image to analyze.' });
  }

  const imageList = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  for(const img of imageList){
    if(!img || !isAllowedImageType(img.mimeType)){
      return res.status(400).json({ error: `Unsupported or missing image type: ${img && img.mimeType}` });
    }
  }

  const resolvedCurrency = currency || 'USD';
  const hasImages = imageList.length > 0;

  const parts = [{ text: buildPrompt({ title, description, currency: resolvedCurrency, hasImages }) }];
  for(const img of imageList){
    parts.push({ inlineData: { mimeType: img.mimeType, data: stripDataUrlPrefix(img.dataBase64) } });
  }

  let genAI, model, result;
  try{
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });
    result = await generateContentWithRetry(model, { contents: [{ role: 'user', parts }] });
  } catch(err){
    console.error('[analyze] Gemini API call failed:', err.message || err);
    const status = err.status || (err.message && /api key/i.test(err.message) ? 401 : null);
    if(status === 401 || status === 403){
      return res.status(502).json({ error: 'Gemini rejected the API key. Check that GEMINI_API_KEY is valid.' });
    }
    if(status === 429){
      return res.status(502).json({ error: 'Gemini API rate limit or quota exceeded. Try again shortly.' });
    }
    return res.status(502).json({ error: `Vision analysis request failed: ${err.message || 'unknown error'}.` });
  }

  let raw;
  try{
    raw = result.response.text();
  } catch(err){
    console.error('[analyze] Could not read Gemini response text:', err);
    return res.status(502).json({ error: 'Vision model returned an empty or blocked response.' });
  }

  let parsed;
  try{
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch(err){
    console.error('[analyze] Failed to parse Gemini JSON response:', raw);
    return res.status(502).json({ error: 'Vision model returned an unexpected response format.' });
  }

  if(!parsed.msrp || typeof parsed.msrp.estimate !== 'number'){
    console.error('[analyze] Gemini response missing valid msrp.estimate:', parsed);
    return res.status(502).json({ error: 'Vision model did not return a usable MSRP estimate.' });
  }

  res.json({
    msrp: parsed.msrp,
    imageAnalysis: hasImages ? (parsed.imageAnalysis || null) : null,
  });
});

app.listen(PORT, () => {
  console.log(`MarketplaceGuardian running at http://localhost:${PORT}`);
});
