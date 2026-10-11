// Extension popups load from a chrome-extension:// origin, so a relative
// '/api/analyze' would resolve against the extension itself, not the backend.
// The website (served by server.js) keeps using a same-origin relative path.
const IS_EXTENSION_POPUP = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
const API_BASE = IS_EXTENSION_POPUP ? 'http://localhost:3000' : '';
if(IS_EXTENSION_POPUP){
  document.documentElement.classList.add('mg-ext-popup');
}

// Keyword patterns run against the entered listing text (title + description).
const SUSPICIOUS_PATTERNS = [
  { re: /no\s+returns?/i, key: 'patNoReturns' },
  { re: /no\s+refunds?/i, key: 'patNoRefunds' },
  { re: /cash\s*app|cash[\s-]?only/i, key: 'patCashOnly' },
  { re: /zelle/i, key: 'patZelle' },
  { re: /as[\s-]?is\b/i, key: 'patAsIs' },
  { re: /must\s+sell/i, key: 'patMustSell' },
  { re: /final\s+price/i, key: 'patFinalPrice' },
  { re: /100%\s*authentic/i, key: 'pat100Authentic' },
  { re: /trust\s+me/i, key: 'patTrustMe' },
  { re: /no\s+questions/i, key: 'patNoQuestions' },
  { re: /moving\s+out\s+of\s+state|selling\s+for\s+a\s+friend/i, key: 'patMovingOut' },
  { re: /no\s+inspection/i, key: 'patNoInspection' },
  { re: /firm\s+price/i, key: 'patFirmPrice' },
];

function detectSuspiciousPhrases(text){
  if(!text) return [];
  const hits = [];
  for(const p of SUSPICIOUS_PATTERNS){
    const m = text.match(p.re);
    if(m) hits.push({ key: p.key, matched: m[0] });
  }
  return hits;
}

const CURRENCY_SYMBOLS = { USD: '$', CAD: 'C$', AUD: 'A$', GBP: '£', EUR: '€' };
function formatMoney(amount, currency){
  const sym = CURRENCY_SYMBOLS[currency];
  return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency || ''}`.trim();
}

function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${t('errCouldNotReadFilePrefix')} ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function analyzeListing({ title, description, currency, images }){
  let resp;
  try{
    resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, currency, images })
    });
  } catch(networkErr){
    console.error('Network error reaching /api/analyze:', networkErr);
    throw new Error(t('errNetworkUnreachable'));
  }
  const data = await resp.json().catch(() => ({}));
  if(!resp.ok){
    throw new Error(data.error || `${t('errAnalysisRequestFailedPrefix')} ${resp.status}).`);
  }
  return data;
}

function buildImageBlockFromAnalysis(imageAnalysis, images){
  if(!images || !images.length){
    return { verdict: 'unknown', kind: 'noImages' };
  }
  if(!imageAnalysis || !imageAnalysis.verdict){
    return { verdict: 'unknown', kind: 'analysisUnavailable', images };
  }
  const verdict = ['pass', 'moderate', 'high'].includes(imageAnalysis.verdict) ? imageAnalysis.verdict : 'unknown';
  return {
    verdict, kind: 'analyzed',
    rawFindings: Array.isArray(imageAnalysis.findings) ? imageAnalysis.findings : [],
    images
  };
}

async function buildManualReport({ title, seller, description, listedAmount, listedCurrency, images, listingUrl }){
  const resolvedTitle = title || null;
  const scanText = `${resolvedTitle || ''} ${description || ''}`;
  const phraseHits = detectSuspiciousPhrases(scanText);

  const textVerdict = phraseHits.length >= 3 ? 'high' : phraseHits.length >= 1 ? 'moderate' : 'pass';
  const textBlock = {
    verdict: textVerdict,
    hasDescription: !!description,
    flagKeys: phraseHits.map(h => h.key),
    flagMatches: phraseHits.map(h => h.matched),
  };

  const cur = listedCurrency || 'USD';
  const analysis = await analyzeListing({
    title: resolvedTitle || '', description, currency: cur,
    images: (images || []).map(img => ({ name: img.name, mimeType: img.mimeType, dataBase64: img.dataBase64 }))
  });

  let priceBlock;
  if(listedAmount == null){
    priceBlock = { verdict: 'unknown', kind: 'noPrice' };
  } else {
    const msrp = analysis.msrp;
    const diffPct = Math.round(((listedAmount - msrp.estimate) / msrp.estimate) * 100);
    const verdict = diffPct <= -50 ? 'high' : diffPct <= -20 ? 'moderate' : 'pass';
    priceBlock = {
      verdict, kind: 'priced',
      listed: listedAmount, msrp: msrp.estimate, diffPct, listedCurrency: cur,
      rangeLow: typeof msrp.low === 'number' ? msrp.low : null,
      rangeHigh: typeof msrp.high === 'number' ? msrp.high : null,
      confidence: msrp.confidence || 'medium',
    };
  }

  const imageBlock = buildImageBlockFromAnalysis(analysis.imageAnalysis, images && images.length ? images : null);

  let score = 10;
  if(typeof priceBlock.diffPct === 'number' && priceBlock.diffPct < 0){
    score += Math.min(40, Math.round(Math.abs(priceBlock.diffPct) * 0.7));
  }
  score += Math.min(30, phraseHits.length * 10);
  if(imageBlock.verdict === 'high') score += 30;
  else if(imageBlock.verdict === 'moderate') score += 15;
  score = Math.min(97, score);
  const status = score >= 70 ? 'high' : score >= 35 ? 'moderate' : 'legit';

  return {
    key: 'manual', title: resolvedTitle,
    sellerRaw: seller || '', listingUrl: listingUrl || '', description: description || '',
    riskScore: score, status,
    image: imageBlock, text: textBlock, price: priceBlock,
  };
}

const VERDICT_STYLES = {
  pass:     { pill: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', ring: 'border-emerald-500/20' },
  moderate: { pill: 'bg-amber-500/10 text-amber-400 border-amber-500/30', ring: 'border-amber-500/20' },
  high:     { pill: 'bg-red-500/10 text-red-400 border-red-500/30', ring: 'border-red-500/20' },
  unknown:  { pill: 'bg-slate-500/10 text-slate-400 border-slate-500/30', ring: 'border-slate-600/30' },
};
const VERDICT_WORD_KEYS = { pass: 'verdictPass', moderate: 'verdictFlag', high: 'verdictHighFlag', unknown: 'verdictNA' };
function verdictWord(verdict){ return t(VERDICT_WORD_KEYS[verdict] || 'verdictNA'); }

const STATUS_STYLES = {
  legit:    { pill: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', gauge: '#34d399', cardGlow: 'glow-emerald' },
  moderate: { pill: 'bg-amber-500/10 text-amber-400 border-amber-500/30', gauge: '#fbbf24', cardGlow: 'glow-amber' },
  high:     { pill: 'bg-red-500/10 text-red-400 border-red-500/30', gauge: '#f87171', cardGlow: 'glow-red' },
};
const STATUS_LABEL_KEYS = { legit: 'statusLegit', moderate: 'statusModerate', high: 'statusHigh' };
function statusLabel(status){ return t(STATUS_LABEL_KEYS[status] || 'statusModerate'); }

let currentReport = null;
let currentBatchResult = null;

/* ---------------------------------------------------------
   Batch / Serial code inspector
--------------------------------------------------------- */
const KNOWN_DUPLICATE_CODES = new Set(['AA100000','BB123456','FR000001','ZZ999999','AB111111']);
const KNOWN_INVALID_PREFIXES = new Set(['XX','00','QQ']);

function validateBatchCode(raw){
  const code = raw.trim().toUpperCase();
  if(!code) return null;

  const formatRe = /^[A-Z]{2}\d{6}$/;
  const formatOk = formatRe.test(code);

  if(!formatOk){
    return { code, valid: false, severity: 'high', reasonKind: 'invalidFormat' };
  }
  const prefix = code.slice(0,2);
  if(KNOWN_DUPLICATE_CODES.has(code)){
    return { code, valid: false, severity: 'high', reasonKind: 'duplicate' };
  }
  if(KNOWN_INVALID_PREFIXES.has(prefix)){
    return { code, valid: false, severity: 'moderate', reasonKind: 'invalidPrefix', prefix };
  }
  return { code, valid: true, severity: 'pass', reasonKind: 'validReason' };
}

function batchReasonText(result){
  if(result.reasonKind === 'invalidFormat') return t('batchInvalidFormat');
  if(result.reasonKind === 'duplicate') return t('batchDuplicate');
  if(result.reasonKind === 'invalidPrefix') return `${t('batchInvalidPrefixPrefix')}${result.prefix}${t('batchInvalidPrefixSuffix')}`;
  return t('batchValidReason');
}

/* ---------------------------------------------------------
   Scanning animation
--------------------------------------------------------- */
const SCAN_STEPS = [
  { icon: 'image', textKey: 'scanStepImage' },
  { icon: 'text',  textKey: 'scanStepText' },
  { icon: 'price', textKey: 'scanStepPrice' },
  { icon: 'code',  textKey: 'scanStepCode' },
];

function stepIconSvg(kind){
  const icons = {
    image: '<path d="M3 5h18v14H3z"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 15l-5-5L5 19"/>',
    text: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/>',
    price: '<path d="M3 12l9-9 9 9-9 9z"/><circle cx="9" cy="9" r="1.3"/>',
    code: '<rect x="3" y="7" width="2" height="10"/><rect x="7" y="7" width="1" height="10"/><rect x="10" y="7" width="3" height="10"/><rect x="15" y="7" width="1" height="10"/><rect x="18" y="7" width="2" height="10"/>'
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[kind]}</svg>`;
}

function runScanAnimation(hasBatch, onComplete){
  const container = document.getElementById('scanSteps');
  container.innerHTML = '';
  const steps = hasBatch ? SCAN_STEPS : SCAN_STEPS.slice(0,3);
  steps.forEach((s,i) => {
    const row = document.createElement('div');
    row.className = 'scan-step flex items-center gap-3 text-sm text-slate-400';
    row.id = `scanstep-${i}`;
    row.innerHTML = `
      <span class="step-icon flex items-center justify-center w-6 h-6 rounded-full border border-slate-700 text-slate-500">${stepIconSvg(s.icon)}</span>
      <span>${t(s.textKey)}</span>
    `;
    container.appendChild(row);
  });

  const bar = document.getElementById('scanBar');
  bar.style.width = '0%';

  let i = 0;
  function nextStep(){
    if(i > 0){
      const prev = document.getElementById(`scanstep-${i-1}`);
      prev.classList.remove('active');
      prev.classList.add('done');
      prev.querySelector('.step-icon').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
      prev.querySelector('.step-icon').className = 'step-icon flex items-center justify-center w-6 h-6 rounded-full border border-emerald-500/50 text-emerald-400 bg-emerald-500/10';
    }
    if(i >= steps.length){
      bar.style.width = '100%';
      setTimeout(onComplete, 350);
      return;
    }
    const row = document.getElementById(`scanstep-${i}`);
    row.classList.add('active');
    bar.style.width = `${Math.round(((i+1)/steps.length)*100)}%`;
    i++;
    setTimeout(nextStep, 550 + Math.random()*300);
  }
  setTimeout(nextStep, 250);
}

/* ---------------------------------------------------------
   Results rendering
--------------------------------------------------------- */
function textBlockDisplay(block){
  return {
    verdict: block.verdict,
    label: block.verdict === 'high' ? t('textVerdictHighLabel') : block.verdict === 'moderate' ? t('textVerdictModerateLabel') : t('textVerdictPassLabel'),
    detail: block.hasDescription ? t('textDetailWithDescription') : t('textDetailNoDescription'),
    flags: (block.flagKeys || []).map((key, i) => `"${block.flagMatches[i]}" — ${t(key)}`),
  };
}

function confidenceWord(c){
  return c === 'high' ? t('confidenceWordHigh') : c === 'low' ? t('confidenceWordLow') : t('confidenceWordMedium');
}

function priceBlockDisplay(block){
  if(block.kind === 'noPrice'){
    return { verdict: 'unknown', label: t('priceNoListedLabel'), detail: t('priceNoListedDetail') };
  }
  const cur = block.listedCurrency || 'USD';
  const rangeStr = (typeof block.rangeLow === 'number' && typeof block.rangeHigh === 'number')
    ? ` (${t('priceRangeConnector')} ${formatMoney(block.rangeLow, cur)}–${formatMoney(block.rangeHigh, cur)}, ${confidenceWord(block.confidence)} ${t('confidenceSuffix')})`
    : '';
  const label = block.verdict === 'high' ? t('priceHighLabel') : block.verdict === 'moderate' ? t('priceModerateLabel') : t('pricePassLabel');
  let detail;
  if(block.diffPct < 0){
    const suffix = block.verdict === 'high' ? t('priceBelowSuffixHigh') : block.verdict === 'moderate' ? t('priceBelowSuffixModerate') : t('priceBelowSuffixPass');
    detail = `${t('priceDetailBelowPrefix')} ${Math.abs(block.diffPct)}${t('priceDetailBelowMid')}${rangeStr} — ${suffix}.`;
  } else {
    detail = `${t('priceDetailAbovePrefix')}${rangeStr}.`;
  }
  return { verdict: block.verdict, label, detail, listed: block.listed, msrp: block.msrp, diffPct: block.diffPct, listedCurrency: cur };
}

function imageBlockDisplay(block){
  if(block.kind === 'noImages'){
    return { verdict: 'unknown', label: t('imageNotVerifiedLabel'), detail: t('imageNoUploadDetail') };
  }
  if(block.kind === 'analysisUnavailable'){
    return { verdict: 'unknown', label: t('imageAnalysisUnavailableLabel'), detail: t('imageAnalysisUnavailableDetail'), images: block.images };
  }
  const label = block.verdict === 'high' ? t('imageHighLabel') : block.verdict === 'moderate' ? t('imageModerateLabel') : t('imagePassLabel');
  return { verdict: block.verdict, label, detail: t('imageAnalyzedDetail'), flags: block.rawFindings, images: block.images };
}

function summaryForStatus(status){
  return status === 'high' ? t('summaryHigh') : status === 'moderate' ? t('summaryModerate') : t('summaryLegit');
}

function breakdownCard(iconKind, title, block){
  const vs = VERDICT_STYLES[block.verdict];
  const parts = [];
  if(block.flags && block.flags.length){
    parts.push(`<div class="mt-3 space-y-1.5">${block.flags.map(f => `<div class="text-xs text-slate-400 mono flex gap-2"><span class="text-red-400">›</span>${f}</div>`).join('')}</div>`);
  }
  if(block.listed !== undefined){
    const listedStr = formatMoney(block.listed, block.listedCurrency || 'USD');
    const msrpStr = block.msrp !== undefined ? formatMoney(block.msrp, block.listedCurrency || 'USD') : null;
    parts.push(`
      <div class="mt-3 grid ${msrpStr ? 'grid-cols-2' : 'grid-cols-1'} gap-2 text-xs">
        <div class="bg-slate-950/60 rounded-lg p-2">
          <div class="text-slate-500">${t('listedPriceLabel')}</div>
          <div class="mono text-slate-200 font-semibold">${listedStr}</div>
        </div>
        ${msrpStr ? `
        <div class="bg-slate-950/60 rounded-lg p-2">
          <div class="text-slate-500">${t('estRetailLabel')}</div>
          <div class="mono text-slate-200 font-semibold">${msrpStr}</div>
        </div>` : ''}
      </div>
      ${typeof block.diffPct === 'number' ? `
      <div class="mt-2 text-xs ${block.diffPct <= -50 ? 'text-red-400' : block.diffPct <= -20 ? 'text-amber-400' : 'text-emerald-400'} font-semibold">
        ${block.diffPct}% ${t('vsEstRetailSuffix')}
      </div>` : ''}`);
  }
  if(block.images && block.images.length){
    parts.push(`<div class="mt-3 grid grid-cols-4 gap-2">${block.images.map(img => `<img src="${img.dataBase64 || img.previewUrl}" class="w-full h-14 object-cover rounded-md border border-slate-700" alt="${img.name}">`).join('')}</div>`);
  }
  const extra = parts.join('');
  return `
    <div class="rounded-2xl border ${vs.ring} bg-slate-900/50 p-5">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2 text-slate-200">
          ${stepIconSvg(iconKind)}
          <span class="text-sm font-semibold">${title}</span>
        </div>
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${vs.pill}">${verdictWord(block.verdict).toUpperCase()}</span>
      </div>
      <p class="text-sm text-slate-200 font-medium">${block.label}</p>
      <p class="text-xs text-slate-400 mt-2 leading-relaxed">${block.detail}</p>
      ${extra}
    </div>`;
}

function renderResults(report, batchResult){
  currentReport = report;
  currentBatchResult = batchResult;

  const ss = STATUS_STYLES[report.status];

  document.getElementById('statusBadge').className = `inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border ${ss.pill}`;
  document.getElementById('statusBadge').textContent = statusLabel(report.status);
  document.getElementById('listingTitle').textContent = report.title || t('untitledEntry');
  document.getElementById('listingSubtitle').textContent = `${t('sellerPrefixLabel')} ${report.sellerRaw || t('notProvided')}`;
  document.getElementById('listingSummary').textContent = summaryForStatus(report.status);
  document.getElementById('simulatedNoteText').textContent = t('reportNoteText');
  document.getElementById('simulatedNote').classList.remove('hidden');

  document.getElementById('gaugeValue').textContent = `${report.riskScore}%`;
  document.getElementById('gaugeValue').style.color = ss.gauge;
  const circumference = 377;
  const offset = circumference - (circumference * report.riskScore/100);
  const gaugeEl = document.getElementById('gaugeProgress');
  gaugeEl.setAttribute('stroke', ss.gauge);
  gaugeEl.style.strokeDashoffset = circumference;
  requestAnimationFrame(() => { gaugeEl.style.strokeDashoffset = offset; });

  document.getElementById('breakdownGrid').innerHTML =
    breakdownCard('image', t('imageIntegrityTitle'), imageBlockDisplay(report.image)) +
    breakdownCard('text', t('textDescriptionTitle'), textBlockDisplay(report.text)) +
    breakdownCard('price', t('priceVarianceTitle'), priceBlockDisplay(report.price));

  const serialCard = document.getElementById('serialCard');
  if(batchResult){
    const sevStyle = batchResult.valid ? VERDICT_STYLES.pass : batchResult.severity === 'high' ? VERDICT_STYLES.high : VERDICT_STYLES.moderate;
    serialCard.classList.remove('hidden');
    serialCard.className = `rounded-2xl border ${sevStyle.ring} bg-slate-900/50 p-5`;
    serialCard.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2 text-slate-200">
          ${stepIconSvg('code')}
          <span class="text-sm font-semibold">${t('batchCodeCheckTitle')}</span>
        </div>
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${sevStyle.pill}">${batchResult.valid ? t('validLabel') : t('flaggedLabel')}</span>
      </div>
      <p class="text-sm text-slate-200 font-medium mono">${batchResult.code}</p>
      <p class="text-xs text-slate-400 mt-2 leading-relaxed">${batchReasonText(batchResult)}</p>
    `;
  } else {
    serialCard.classList.add('hidden');
    serialCard.innerHTML = '';
  }

  document.getElementById('complaintBtn').classList.toggle('hidden', report.status !== 'high');

  document.getElementById('resultsSection').classList.remove('hidden');
  document.getElementById('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------------------------------------------------
   Verification history (localStorage)
--------------------------------------------------------- */
const HISTORY_STORAGE_KEY = 'marketplaceguardian_history_v1';
const MAX_HISTORY_ENTRIES = 20;

function escapeHtml(str){
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch(err){
    console.warn('Could not read verification history:', err);
    return [];
  }
}

function persistHistory(list){
  try{
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch(err){
    // Likely quota exceeded (image data URLs can be large) — retry without images.
    try{
      const stripped = list.map(entry => ({
        ...entry,
        report: { ...entry.report, image: { ...entry.report.image, images: undefined } }
      }));
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(stripped));
      return true;
    } catch(err2){
      console.warn('Could not persist verification history (storage full):', err2);
      return false;
    }
  }
}

function saveToHistory(report, batchResult){
  const entry = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    title: report.title,
    riskScore: report.riskScore,
    status: report.status,
    timestamp: Date.now(),
    report,
    batchResult: batchResult || null,
  };
  let list = loadHistory();
  list.unshift(entry);
  if(list.length > MAX_HISTORY_ENTRIES) list = list.slice(0, MAX_HISTORY_ENTRIES);
  persistHistory(list);
  renderHistoryList();
}

function clearHistory(){
  localStorage.removeItem(HISTORY_STORAGE_KEY);
  renderHistoryList();
}

function loadHistoryEntry(id){
  const entry = loadHistory().find(e => e.id === id);
  if(!entry) return;
  renderResults(entry.report, entry.batchResult);
  closeHistoryDrawer();
}

function renderHistoryList(){
  const container = document.getElementById('historyList');
  const list = loadHistory();
  if(!list.length){
    container.innerHTML = `<p class="text-xs text-slate-600 text-center mt-8">${escapeHtml(t('historyEmptyState'))}</p>`;
    return;
  }
  container.innerHTML = list.map(entry => {
    const ss = STATUS_STYLES[entry.status] || STATUS_STYLES.moderate;
    const when = new Date(entry.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <button data-history-id="${entry.id}" class="history-item w-full text-left rounded-lg border border-slate-800 hover:border-cyan-500/40 hover:bg-slate-900/60 p-3 transition">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-slate-200 truncate">${escapeHtml(entry.title || t('untitledEntry'))}</span>
          <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${ss.pill}">${entry.riskScore}%</span>
        </div>
        <p class="text-[11px] text-slate-500 mt-1">${when}</p>
      </button>`;
  }).join('');
  container.querySelectorAll('.history-item').forEach(btn => {
    btn.addEventListener('click', () => loadHistoryEntry(btn.dataset.historyId));
  });
}

function openHistoryDrawer(){
  document.getElementById('historyDrawer').classList.remove('-translate-x-full');
  document.getElementById('historyOverlay').classList.remove('hidden');
}
function closeHistoryDrawer(){
  document.getElementById('historyDrawer').classList.add('-translate-x-full');
  document.getElementById('historyOverlay').classList.add('hidden');
}

document.getElementById('historyToggleBtn').addEventListener('click', openHistoryDrawer);
document.getElementById('historyCloseBtn').addEventListener('click', closeHistoryDrawer);
document.getElementById('historyOverlay').addEventListener('click', closeHistoryDrawer);
document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  if(confirm(t('historyClearConfirm'))) clearHistory();
});

/* ---------------------------------------------------------
   Top-level section navigation
--------------------------------------------------------- */
let activeSection = 'detection';

function setActiveSection(section){
  activeSection = section;
  const isDetection = section === 'detection';
  document.getElementById('section-detection').classList.toggle('hidden', !isDetection);
  document.getElementById('section-resources').classList.toggle('hidden', isDetection);
  document.getElementById('headerSubtitle').textContent = isDetection ? t('subtitleDetection') : t('subtitleResources');
  document.getElementById('historyToggleBtn').classList.toggle('hidden', !isDetection);
  document.getElementById('notifBtn').classList.toggle('hidden', isDetection);
  if(isDetection) closeNotifPanel();
  document.querySelectorAll('.section-tab-btn').forEach(btn => {
    btn.classList.toggle('active-tab', btn.dataset.section === section);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('.section-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setActiveSection(btn.dataset.section));
});

/* ---------------------------------------------------------
   Settings — language preference
--------------------------------------------------------- */
const LANGUAGE_STORAGE_KEY = 'marketplaceguardian_language_v1';

const LANGUAGES = [
  { code: 'en', native: 'English', english: 'English' },
  { code: 'es', native: 'Español', english: 'Spanish' },
  { code: 'zh', native: '中文', english: 'Mandarin' },
  { code: 'tl', native: 'Tagalog', english: 'Tagalog' },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'ar', native: 'العربية', english: 'Arabic' },
  { code: 'fr', native: 'Français', english: 'French' },
  { code: 'ko', native: '한국어', english: 'Korean' },
  { code: 'ru', native: 'Русский', english: 'Russian' },
  { code: 'de', native: 'Deutsch', english: 'German' },
];

const TRANSLATIONS = {
  // ---------- Header / nav ----------
  settingsLabel: { en:'Settings', es:'Configuración', zh:'设置', tl:'Mga Setting', vi:'Cài Đặt', ar:'الإعدادات', fr:'Paramètres', ko:'설정', ru:'Настройки', de:'Einstellungen' },
  historyLabel: { en:'History', es:'Historial', zh:'历史记录', tl:'Kasaysayan', vi:'Lịch Sử', ar:'السجل', fr:'Historique', ko:'기록', ru:'История', de:'Verlauf' },
  engineOnline: { en:'Engine Online', es:'Motor en Línea', zh:'引擎在线', tl:'Online ang Sistema', vi:'Hệ Thống Đang Hoạt Động', ar:'المحرك متصل', fr:'Moteur en Ligne', ko:'엔진 온라인', ru:'Система Работает', de:'System Online' },
  notifBtnTitle: { en:'Federal Alerts & Notifications', es:'Alertas y Notificaciones Federales', zh:'联邦警报和通知', tl:'Mga Alerto at Abiso ng Pederal', vi:'Cảnh Báo & Thông Báo Liên Bang', ar:'التنبيهات والإشعارات الفيدرالية', fr:'Alertes et Notifications Fédérales', ko:'연방 경고 및 알림', ru:'Федеральные Оповещения', de:'Bundesweite Warnungen & Benachrichtigungen' },
  notifPanelTitle: { en:'Federal Alerts', es:'Alertas Federales', zh:'联邦警报', tl:'Mga Alerto ng Pederal', vi:'Cảnh Báo Liên Bang', ar:'التنبيهات الفيدرالية', fr:'Alertes Fédérales', ko:'연방 경고', ru:'Федеральные Оповещения', de:'Bundesweite Warnungen' },
  notifPanelDisclaimer: { en:'Illustrative demo feed — not a live government data source.', es:'Feed de demostración ilustrativo — no es una fuente de datos gubernamental en vivo.', zh:'示例演示信息流——并非实时政府数据源。', tl:'Halimbawang demo feed lamang — hindi ito live na pinagmumulan ng datos ng gobyerno.', vi:'Nguồn cấp dữ liệu minh họa — không phải nguồn dữ liệu chính phủ trực tiếp.', ar:'موجز توضيحي تجريبي — ليس مصدر بيانات حكومي مباشر.', fr:'Flux de démonstration illustratif — pas une source de données gouvernementale en direct.', ko:'예시용 데모 피드입니다 — 실시간 정부 데이터가 아닙니다.', ru:'Демонстрационная лента — не является источником данных в реальном времени от государства.', de:'Illustrativer Demo-Feed — keine Live-Datenquelle der Regierung.' },
  tabDetection: { en:'Counterfeit Detection', es:'Detección de Falsificaciones', zh:'假货检测', tl:'Pagtukoy ng Peke', vi:'Phát Hiện Hàng Giả', ar:'كشف التزييف', fr:'Détection de Contrefaçon', ko:'위조품 탐지', ru:'Обнаружение Подделок', de:'Fälschungserkennung' },
  tabResources: { en:'Helpful Information', es:'Información Útil', zh:'实用信息', tl:'Kapaki-pakinabang na Impormasyon', vi:'Thông Tin Hữu Ích', ar:'معلومات مفيدة', fr:'Informations Utiles', ko:'유용한 정보', ru:'Полезная Информация', de:'Hilfreiche Informationen' },
  subtitleResources: { en:'Valuable Information', es:'Información Valiosa', zh:'有价值的信息', tl:'Mahalagang Impormasyon', vi:'Thông Tin Giá Trị', ar:'معلومات قيمة', fr:'Informations Précieuses', ko:'귀중한 정보', ru:'Ценная Информация', de:'Wertvolle Informationen' },

  // ---------- History drawer ----------
  historyDrawerTitle: { en:'Verification History', es:'Historial de Verificaciones', zh:'验证历史记录', tl:'Kasaysayan ng Pagpapatunay', vi:'Lịch Sử Xác Minh', ar:'سجل التحقق', fr:'Historique des Vérifications', ko:'검증 기록', ru:'История Проверок', de:'Verlauf der Überprüfungen' },
  clearHistoryBtn: { en:'Clear History', es:'Borrar Historial', zh:'清除历史记录', tl:'I-clear ang Kasaysayan', vi:'Xóa Lịch Sử', ar:'مسح السجل', fr:'Effacer l’Historique', ko:'기록 삭제', ru:'Очистить Историю', de:'Verlauf Löschen' },
  historyEmptyState: { en:'No past verifications yet.', es:'Aún no hay verificaciones anteriores.', zh:'尚无历史验证记录。', tl:'Wala pang naunang pagpapatunay.', vi:'Chưa có lần xác minh nào trước đây.', ar:'لا توجد عمليات تحقق سابقة بعد.', fr:'Aucune vérification antérieure pour le moment.', ko:'이전 검증 기록이 없습니다.', ru:'Пока нет предыдущих проверок.', de:'Noch keine früheren Überprüfungen.' },
  historyClearConfirm: { en:'Clear all saved verification history? This cannot be undone.', es:'¿Borrar todo el historial de verificaciones guardado? Esta acción no se puede deshacer.', zh:'确定要清除所有已保存的验证历史记录吗？此操作无法撤销。', tl:'I-clear ang lahat ng naka-save na kasaysayan ng pagpapatunay? Hindi na ito maibabalik.', vi:'Xóa toàn bộ lịch sử xác minh đã lưu? Không thể hoàn tác thao tác này.', ar:'هل تريد مسح كل سجل التحقق المحفوظ؟ لا يمكن التراجع عن هذا الإجراء.', fr:'Effacer tout l’historique des vérifications enregistré ? Cette action est irréversible.', ko:'저장된 모든 검증 기록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.', ru:'Очистить всю сохранённую историю проверок? Это действие необратимо.', de:'Gesamten gespeicherten Überprüfungsverlauf löschen? Dies kann nicht rückgängig gemacht werden.' },

  // ---------- Settings modal ----------
  settingsModalTitle: { en:'Settings', es:'Configuración', zh:'设置', tl:'Mga Setting', vi:'Cài Đặt', ar:'الإعدادات', fr:'Paramètres', ko:'설정', ru:'Настройки', de:'Einstellungen' },
  languageSectionTitle: { en:'Language', es:'Idioma', zh:'语言', tl:'Wika', vi:'Ngôn Ngữ', ar:'اللغة', fr:'Langue', ko:'언어', ru:'Язык', de:'Sprache' },
  languageDescription: { en:'Choose your preferred language. This translates the app’s interface — labels, buttons, and guidance text. Text you type yourself and AI-generated analysis results stay as written.', es:'Elige tu idioma preferido. Esto traduce la interfaz de la aplicación: etiquetas, botones y textos de orientación. El texto que escribes tú mismo y los resultados del análisis generados por IA permanecen como se escribieron.', zh:'选择您的首选语言。此设置会翻译应用界面——标签、按钮和指导文字。您自己输入的文本以及人工智能生成的分析结果将保持原样。', tl:'Piliin ang gusto mong wika. Isinasalin nito ang interface ng app — mga label, buton, at gabay na teksto. Ang tekstong ikaw mismo ang nagtype at ang resulta ng pagsusuri na gawa ng AI ay mananatiling hindi isinasalin.', vi:'Chọn ngôn ngữ bạn muốn. Thao tác này sẽ dịch giao diện ứng dụng — nhãn, nút và văn bản hướng dẫn. Văn bản do chính bạn nhập và kết quả phân tích do AI tạo ra sẽ giữ nguyên như đã viết.', ar:'اختر لغتك المفضلة. سيؤدي ذلك إلى ترجمة واجهة التطبيق — التسميات والأزرار والنصوص الإرشادية. يبقى النص الذي تكتبه بنفسك ونتائج التحليل التي ينشئها الذكاء الاصطناعي كما هي مكتوبة.', fr:'Choisissez votre langue préférée. Cela traduit l’interface de l’application : libellés, boutons et textes d’orientation. Le texte que vous saisissez vous-même et les résultats d’analyse générés par l’IA restent tels quels.', ko:'원하는 언어를 선택하세요. 앱의 인터페이스(레이블, 버튼, 안내 문구)가 번역됩니다. 직접 입력한 텍스트와 AI가 생성한 분석 결과는 그대로 유지됩니다.', ru:'Выберите предпочитаемый язык. Это переведёт интерфейс приложения — надписи, кнопки и пояснительный текст. Введённый вами текст и результаты анализа, созданные ИИ, останутся без изменений.', de:'Wählen Sie Ihre bevorzugte Sprache. Dadurch wird die App-Oberfläche übersetzt — Beschriftungen, Schaltflächen und Hinweistexte. Von Ihnen eingegebener Text und KI-generierte Analyseergebnisse bleiben unverändert.' },

  // ---------- Manual Detection form ----------
  manualDetectionTitle: { en:'Manual Detection', es:'Detección Manual', zh:'手动检测', tl:'Manual na Pagsusuri', vi:'Kiểm Tra Thủ Công', ar:'الكشف اليدوي', fr:'Détection Manuelle', ko:'수동 감지', ru:'Ручная Проверка', de:'Manuelle Erkennung' },
  manualDetectionIntro: { en:'Enter the item’s details below to run it through the counterfeit risk-scoring engine.', es:'Ingresa los detalles del artículo a continuación para procesarlo a través del motor de puntuación de riesgo de falsificación.', zh:'请在下方输入商品详情，系统将通过假货风险评分引擎进行分析。', tl:'Ilagay ang mga detalye ng item sa ibaba upang masuri ito gamit ang counterfeit risk-scoring engine.', vi:'Nhập thông tin sản phẩm bên dưới để chạy qua công cụ chấm điểm rủi ro hàng giả.', ar:'أدخل تفاصيل المنتج أدناه لتحليله عبر محرك تقييم مخاطر التزييف.', fr:'Saisissez les détails de l’article ci-dessous pour le soumettre au moteur d’évaluation du risque de contrefaçon.', ko:'아래에 상품 정보를 입력하면 위조 위험 점수 엔진을 통해 분석됩니다.', ru:'Введите данные товара ниже, чтобы проверить его с помощью системы оценки риска подделки.', de:'Geben Sie unten die Artikeldetails ein, um sie durch die Fälschungsrisiko-Bewertungs-Engine laufen zu lassen.' },
  itemTitleLabel: { en:'Item Title', es:'Título del Artículo', zh:'商品标题', tl:'Pamagat ng Item', vi:'Tên Sản Phẩm', ar:'عنوان المنتج', fr:'Titre de l’Article', ko:'상품명', ru:'Название Товара', de:'Artikeltitel' },
  sellerLabel: { en:'Seller Username', es:'Nombre de Usuario del Vendedor', zh:'卖家用户名', tl:'Username ng Nagbebenta', vi:'Tên Người Bán', ar:'اسم مستخدم البائع', fr:'Nom d’Utilisateur du Vendeur', ko:'판매자 사용자명', ru:'Имя Пользователя Продавца', de:'Verkäufer-Benutzername' },
  itemTitlePlaceholder: { en:'e.g. Nike Air Jordan 1 Retro High OG "Chicago", Size 10', es:'p. ej., Nike Air Jordan 1 Retro High OG "Chicago", talla 10', zh:'例如：Nike Air Jordan 1 Retro High OG "Chicago"，10码', tl:'hal. Nike Air Jordan 1 Retro High OG "Chicago", Size 10', vi:'VD: Nike Air Jordan 1 Retro High OG "Chicago", cỡ 10', ar:'مثال: Nike Air Jordan 1 Retro High OG "Chicago"، مقاس 10', fr:'ex. Nike Air Jordan 1 Retro High OG « Chicago », taille 10', ko:'예: Nike Air Jordan 1 Retro High OG "Chicago", 사이즈 10', ru:'например, Nike Air Jordan 1 Retro High OG "Chicago", размер 10', de:'z. B. Nike Air Jordan 1 Retro High OG „Chicago", Größe 10' },
  sellerPlaceholder: { en:'e.g. sneaker.deals_99', es:'p. ej., sneaker.deals_99', zh:'例如：sneaker.deals_99', tl:'hal. sneaker.deals_99', vi:'VD: sneaker.deals_99', ar:'مثال: sneaker.deals_99', fr:'ex. sneaker.deals_99', ko:'예: sneaker.deals_99', ru:'например, sneaker.deals_99', de:'z. B. sneaker.deals_99' },
  listingUrlLabel: { en:'Listing URL', es:'URL del Anuncio', zh:'商品链接', tl:'URL ng Listahan', vi:'Đường Dẫn Sản Phẩm', ar:'رابط الإعلان', fr:'URL de l’Annonce', ko:'상품 링크', ru:'Ссылка на Объявление', de:'Angebots-URL' },
  optionalTag: { en:'(optional)', es:'(opcional)', zh:'（可选）', tl:'(opsyonal)', vi:'(tùy chọn)', ar:'(اختياري)', fr:'(facultatif)', ko:'(선택 사항)', ru:'(необязательно)', de:'(optional)' },
  listingUrlPlaceholder: { en:'Link to the marketplace listing, if you have one', es:'Enlace al anuncio del mercado, si tienes uno', zh:'如有商品链接，请在此粘贴', tl:'Link sa listahan sa marketplace, kung mayroon', vi:'Liên kết đến sản phẩm trên chợ trực tuyến, nếu có', ar:'رابط الإعلان في السوق، إن وجد', fr:'Lien vers l’annonce sur la plateforme, le cas échéant', ko:'마켓플레이스 상품 링크(있는 경우)', ru:'Ссылка на объявление на площадке, если есть', de:'Link zum Marktplatz-Angebot, falls vorhanden' },
  listingUrlHelper: { en:'Included in the Official Complaint Template if the listing is later flagged high-risk.', es:'Se incluirá en la Plantilla de Queja Oficial si el anuncio se marca posteriormente como de alto riesgo.', zh:'如该商品之后被标记为高风险，此信息将包含在官方投诉模板中。', tl:'Isasama ito sa Opisyal na Template ng Reklamo kung ma-flag ang listahan bilang high-risk.', vi:'Sẽ được đưa vào Mẫu Khiếu Nại Chính Thức nếu sản phẩm sau đó bị đánh dấu rủi ro cao.', ar:'سيتم تضمينه في نموذج الشكوى الرسمي إذا تم لاحقًا تصنيف الإعلان على أنه عالي الخطورة.', fr:'Sera inclus dans le modèle de plainte officielle si l’annonce est ensuite signalée comme à haut risque.', ko:'해당 상품이 이후 고위험으로 표시되면 공식 신고 양식에 포함됩니다.', ru:'Будет включено в официальный шаблон жалобы, если объявление впоследствии будет отмечено как высокорисковое.', de:'Wird in die offizielle Beschwerdevorlage aufgenommen, falls das Angebot später als hochriskant eingestuft wird.' },
  currencyLabel: { en:'Currency', es:'Moneda', zh:'货币', tl:'Pera', vi:'Đơn Vị Tiền Tệ', ar:'العملة', fr:'Devise', ko:'통화', ru:'Валюта', de:'Währung' },
  listedPriceLabel: { en:'Listed Price', es:'Precio de Venta', zh:'标价', tl:'Nakalistang Presyo', vi:'Giá Niêm Yết', ar:'السعر المعلن', fr:'Prix Affiché', ko:'판매 가격', ru:'Указанная Цена', de:'Angebotspreis' },
  listedPricePlaceholder: { en:'e.g. 65.00', es:'p. ej., 65.00', zh:'例如：65.00', tl:'hal. 65.00', vi:'VD: 65.00', ar:'مثال: 65.00', fr:'ex. 65,00', ko:'예: 65.00', ru:'например, 65.00', de:'z. B. 65,00' },
  listedPriceHelper: { en:'Retail value (MSRP) is estimated automatically by AI from the item title (and photos, if provided) — no need to enter it.', es:'El valor de venta al público (PVP) se estima automáticamente mediante IA a partir del título del artículo (y las fotos, si se proporcionan); no es necesario ingresarlo.', zh:'零售价（建议零售价）将根据商品标题（及提供的照片）由人工智能自动估算，无需手动填写。', tl:'Awtomatikong tinatantiya ng AI ang retail value (MSRP) batay sa pamagat ng item (at mga larawan, kung meron) — hindi na kailangang ilagay.', vi:'Giá trị bán lẻ đề xuất (MSRP) được AI tự động ước tính dựa trên tên sản phẩm (và hình ảnh, nếu có) — bạn không cần nhập.', ar:'يتم تقدير سعر التجزئة المقترح (MSRP) تلقائيًا بواسطة الذكاء الاصطناعي من عنوان المنتج (والصور، إن وُجدت) — لا حاجة لإدخاله.', fr:'La valeur de détail (PDSF) est estimée automatiquement par l’IA à partir du titre de l’article (et des photos, le cas échéant) — inutile de la saisir.', ko:'권장 소비자가(MSRP)는 상품명(및 제공된 사진)을 기반으로 AI가 자동으로 추정하므로 직접 입력할 필요가 없습니다.', ru:'Розничная стоимость (рекомендованная цена) автоматически оценивается ИИ на основе названия товара (и фото, если они есть) — вводить её не нужно.', de:'Der Einzelhandelswert (UVP) wird von der KI automatisch anhand des Artikeltitels (und der Fotos, falls vorhanden) geschätzt — keine Eingabe nötig.' },
  descriptionLabel: { en:'Item Description / Notes', es:'Descripción del Artículo / Notas', zh:'商品描述/备注', tl:'Paglalarawan ng Item / Mga Tala', vi:'Mô Tả Sản Phẩm / Ghi Chú', ar:'وصف المنتج / ملاحظات', fr:'Description de l’Article / Remarques', ko:'상품 설명 / 메모', ru:'Описание Товара / Примечания', de:'Artikelbeschreibung / Notizen' },
  descriptionPlaceholder: { en:'Paste item description, condition, shipping/delivery details, return policy, or payment methods here...', es:'Pega aquí la descripción del artículo, su estado, detalles de envío/entrega, política de devolución o métodos de pago...', zh:'请在此粘贴商品描述、成色、配送/交付详情、退货政策或付款方式……', tl:'I-paste dito ang paglalarawan ng item, kondisyon, detalye ng shipping/delivery, patakaran sa pagsauli, o mga paraan ng pagbabayad...', vi:'Dán mô tả sản phẩm, tình trạng, chi tiết vận chuyển/giao hàng, chính sách đổi trả hoặc phương thức thanh toán vào đây...', ar:'الصق هنا وصف المنتج وحالته وتفاصيل الشحن/التوصيل وسياسة الإرجاع أو طرق الدفع...', fr:'Collez ici la description de l’article, son état, les détails de livraison, la politique de retour ou les moyens de paiement...', ko:'상품 설명, 상태, 배송 정보, 반품 정책 또는 결제 방법을 여기에 붙여넣으세요...', ru:'Вставьте сюда описание товара, его состояние, детали доставки, политику возврата или способы оплаты...', de:'Fügen Sie hier Artikelbeschreibung, Zustand, Versand-/Lieferdetails, Rückgaberichtlinie oder Zahlungsmethoden ein...' },
  descriptionHelper: { en:'Include condition, shipping, return policy, and payment terms — these are scanned for scam-language patterns.', es:'Incluye el estado, el envío, la política de devolución y las condiciones de pago; se analizan en busca de patrones de lenguaje fraudulento.', zh:'请包含成色、配送、退货政策和付款条款——系统会扫描其中的诈骗语言模式。', tl:'Isama ang kondisyon, shipping, patakaran sa pagsauli, at mga tuntunin sa pagbabayad — sinisiyasat ang mga ito para sa mga pattern ng scam na wika.', vi:'Bao gồm tình trạng, vận chuyển, chính sách đổi trả và điều khoản thanh toán — những nội dung này sẽ được quét để tìm ngôn ngữ lừa đảo.', ar:'أدرج الحالة والشحن وسياسة الإرجاع وشروط الدفع — يتم فحص هذه العناصر بحثًا عن أنماط لغة الاحتيال.', fr:'Incluez l’état, la livraison, la politique de retour et les modalités de paiement — ces éléments sont analysés à la recherche de formulations frauduleuses.', ko:'상태, 배송, 반품 정책, 결제 조건을 포함하세요 — 사기성 문구 패턴을 검사합니다.', ru:'Укажите состояние, доставку, политику возврата и условия оплаты — этот текст проверяется на признаки мошеннических формулировок.', de:'Geben Sie Zustand, Versand, Rückgaberichtlinie und Zahlungsbedingungen an — diese werden auf betrugstypische Formulierungen geprüft.' },
  productImagesLabel: { en:'Product Images', es:'Imágenes del Producto', zh:'商品图片', tl:'Mga Larawan ng Produkto', vi:'Hình Ảnh Sản Phẩm', ar:'صور المنتج', fr:'Photos du Produit', ko:'상품 이미지', ru:'Изображения Товара', de:'Produktbilder' },
  dropzoneText: { en:'Drag & drop images here, or', es:'Arrastra y suelta imágenes aquí, o', zh:'将图片拖放到此处，或', tl:'I-drag at i-drop ang mga larawan dito, o', vi:'Kéo và thả hình ảnh vào đây, hoặc', ar:'اسحب الصور وأفلتها هنا، أو', fr:'Glissez-déposez des images ici, ou', ko:'이미지를 여기로 드래그하거나', ru:'Перетащите изображения сюда или', de:'Bilder hierher ziehen oder' },
  dropzoneBrowse: { en:'browse files', es:'explorar archivos', zh:'浏览文件', tl:'mag-browse ng mga file', vi:'chọn tệp', ar:'تصفح الملفات', fr:'parcourir les fichiers', ko:'파일 찾아보기', ru:'выбрать файлы', de:'Dateien durchsuchen' },
  dropzoneHelper: { en:'PNG, JPG, or WEBP — up to 6 images, 8MB each', es:'PNG, JPG o WEBP; hasta 6 imágenes de 8 MB cada una', zh:'PNG、JPG 或 WEBP 格式——最多 6 张图片，每张不超过 8MB', tl:'PNG, JPG, o WEBP — hanggang 6 na larawan, 8MB bawat isa', vi:'PNG, JPG hoặc WEBP — tối đa 6 ảnh, mỗi ảnh 8MB', ar:'PNG أو JPG أو WEBP — حتى 6 صور، بحد أقصى 8 ميغابايت لكل صورة', fr:'PNG, JPG ou WEBP — jusqu’à 6 images, 8 Mo chacune', ko:'PNG, JPG 또는 WEBP — 최대 6장, 각 8MB까지', ru:'PNG, JPG или WEBP — до 6 изображений, по 8 МБ каждое', de:'PNG, JPG oder WEBP — bis zu 6 Bilder, je 8 MB' },
  analyzeBtn: { en:'Analyze Item', es:'Analizar Artículo', zh:'分析商品', tl:'Suriin ang Item', vi:'Phân Tích Sản Phẩm', ar:'تحليل المنتج', fr:'Analyser l’Article', ko:'상품 분석', ru:'Анализировать Товар', de:'Artikel Analysieren' },

  // ---------- Batch inspector ----------
  batchLabel: { en:'Batch / Serial Code Inspector', es:'Verificador de Código de Lote / Serie', zh:'批次/序列号检查器', tl:'Tagasuri ng Batch / Serial Code', vi:'Công Cụ Kiểm Tra Mã Lô / Số Sê-ri', ar:'أداة فحص رمز الدفعة / الرقم التسلسلي', fr:'Vérificateur de Code de Lot / Série', ko:'배치/일련번호 검사기', ru:'Проверка Партийного / Серийного Кода', de:'Chargen-/Seriennummern-Prüfer' },
  batchPlaceholder: { en:'e.g. FR228145 (format: 2 letters + 6 digits)', es:'p. ej., FR228145 (formato: 2 letras + 6 dígitos)', zh:'例如：FR228145（格式：2个字母+6个数字）', tl:'hal. FR228145 (format: 2 titik + 6 numero)', vi:'VD: FR228145 (định dạng: 2 chữ cái + 6 chữ số)', ar:'مثال: FR228145 (الصيغة: حرفان + 6 أرقام)', fr:'ex. FR228145 (format : 2 lettres + 6 chiffres)', ko:'예: FR228145 (형식: 영문자 2자 + 숫자 6자)', ru:'например, FR228145 (формат: 2 буквы + 6 цифр)', de:'z. B. FR228145 (Format: 2 Buchstaben + 6 Ziffern)' },
  batchHelper: { en:'Checked against manufacturer formatting rules and known duplicate/invalid code registry.', es:'Se verifica según las reglas de formato del fabricante y el registro de códigos duplicados o inválidos conocidos.', zh:'系统将根据制造商格式规则以及已知的重复/无效代码库进行核对。', tl:'Sinusuri ito laban sa mga alituntunin ng pag-format ng gumagawa at sa rehistro ng mga kilalang duplicate/invalid na code.', vi:'Được đối chiếu với quy tắc định dạng của nhà sản xuất và cơ sở dữ liệu mã trùng lặp/không hợp lệ đã biết.', ar:'يتم التحقق منه وفق قواعد تنسيق الشركة المصنعة وسجل الرموز المكررة أو غير الصالحة المعروفة.', fr:'Vérifié selon les règles de formatage du fabricant et le registre des codes en double ou invalides connus.', ko:'제조사 형식 규칙 및 알려진 중복/무효 코드 목록과 대조하여 검사합니다.', ru:'Проверяется по правилам форматирования производителя и реестру известных повторяющихся/недействительных кодов.', de:'Wird anhand der Formatierungsregeln des Herstellers und eines Verzeichnisses bekannter doppelter/ungültiger Codes geprüft.' },

  // ---------- Scanning ----------
  runningAnalysis: { en:'Running Analysis', es:'Analizando', zh:'正在分析', tl:'Isinasagawa ang Pagsusuri', vi:'Đang Phân Tích', ar:'جارٍ التحليل', fr:'Analyse en Cours', ko:'분석 진행 중', ru:'Выполняется Анализ', de:'Analyse Läuft' },
  scanStepImage: { en:'Checking image hashes against known catalogs', es:'Comparando los hashes de las imágenes con catálogos conocidos', zh:'正在将图片哈希与已知目录进行比对', tl:'Sinusuri ang image hash laban sa mga kilalang katalogo', vi:'Đang đối chiếu mã băm hình ảnh với các danh mục đã biết', ar:'جارٍ مقارنة بصمات الصور بالكتالوجات المعروفة', fr:'Comparaison des empreintes d’images avec des catalogues connus', ko:'이미지 해시를 알려진 카탈로그와 대조 중', ru:'Сверка хешей изображений с известными каталогами', de:'Bildhashes werden mit bekannten Katalogen abgeglichen' },
  scanStepText: { en:'Analyzing description text for scam patterns', es:'Analizando el texto de la descripción en busca de patrones de fraude', zh:'正在分析描述文字中的诈骗模式', tl:'Sinusuri ang teksto ng paglalarawan para sa mga pattern ng scam', vi:'Đang phân tích văn bản mô tả để tìm dấu hiệu lừa đảo', ar:'جارٍ تحليل نص الوصف بحثًا عن أنماط الاحتيال', fr:'Analyse du texte de la description à la recherche de schémas frauduleux', ko:'설명 텍스트에서 사기 패턴 분석 중', ru:'Анализ текста описания на признаки мошенничества', de:'Beschreibungstext wird auf Betrugsmuster analysiert' },
  scanStepPrice: { en:'Cross-referencing listing price with retail value', es:'Comparando el precio del anuncio con el valor de venta al público', zh:'正在将标价与零售价进行交叉核对', tl:'Inihahambing ang presyo ng listahan sa retail value', vi:'Đang đối chiếu giá niêm yết với giá trị bán lẻ', ar:'جارٍ مقارنة سعر الإعلان بسعر التجزئة', fr:'Comparaison du prix affiché avec la valeur de détail', ko:'판매 가격과 소매가 비교 중', ru:'Сопоставление цены объявления с розничной стоимостью', de:'Angebotspreis wird mit Einzelhandelswert abgeglichen' },
  scanStepCode: { en:'Validating batch / serial code (if provided)', es:'Validando el código de lote/serie (si se proporcionó)', zh:'正在验证批次/序列号（如有提供）', tl:'Pinapatunayan ang batch / serial code (kung meron)', vi:'Đang xác thực mã lô / số sê-ri (nếu có)', ar:'جارٍ التحقق من رمز الدفعة / الرقم التسلسلي (إن وُجد)', fr:'Validation du code de lot/série (le cas échéant)', ko:'배치/일련번호 확인 중(입력된 경우)', ru:'Проверка партийного/серийного кода (если указан)', de:'Chargen-/Seriennummer wird geprüft (falls angegeben)' },

  // ---------- Results dashboard ----------
  riskScoreLabel: { en:'Risk Score', es:'Puntuación de Riesgo', zh:'风险评分', tl:'Iskor ng Panganib', vi:'Điểm Rủi Ro', ar:'درجة الخطورة', fr:'Score de Risque', ko:'위험 점수', ru:'Оценка Риска', de:'Risikobewertung' },
  newScanBtn: { en:'New Scan', es:'Nuevo Análisis', zh:'新建扫描', tl:'Bagong Scan', vi:'Quét Mới', ar:'فحص جديد', fr:'Nouvelle Analyse', ko:'새 스캔', ru:'Новая Проверка', de:'Neue Prüfung' },
  downloadReportBtn: { en:'Download Audit Report', es:'Descargar Informe de Auditoría', zh:'下载审核报告', tl:'I-download ang Ulat ng Pag-audit', vi:'Tải Báo Cáo Kiểm Định', ar:'تنزيل تقرير التدقيق', fr:'Télécharger le Rapport d’Audit', ko:'감사 보고서 다운로드', ru:'Скачать Отчёт о Проверке', de:'Prüfbericht Herunterladen' },
  complaintBtnLabel: { en:'Official Complaint Template', es:'Plantilla de Queja Oficial', zh:'官方投诉模板', tl:'Opisyal na Template ng Reklamo', vi:'Mẫu Khiếu Nại Chính Thức', ar:'نموذج الشكوى الرسمي', fr:'Modèle de Plainte Officielle', ko:'공식 신고 양식', ru:'Официальный Шаблон Жалобы', de:'Offizielle Beschwerdevorlage' },
  statusLegit: { en:'LOW RISK — Legit', es:'RIESGO BAJO — Legítimo', zh:'低风险 —— 合法', tl:'MABABANG PANGANIB — Lehitimo', vi:'RỦI RO THẤP — Hợp Lệ', ar:'خطورة منخفضة — شرعي', fr:'RISQUE FAIBLE — Légitime', ko:'낮은 위험 — 정상', ru:'НИЗКИЙ РИСК — Легитимно', de:'GERINGES RISIKO — Legitim' },
  statusModerate: { en:'MODERATE RISK', es:'RIESGO MODERADO', zh:'中等风险', tl:'KATAMTAMANG PANGANIB', vi:'RỦI RO TRUNG BÌNH', ar:'خطورة متوسطة', fr:'RISQUE MODÉRÉ', ko:'중간 위험', ru:'СРЕДНИЙ РИСК', de:'MITTLERES RISIKO' },
  statusHigh: { en:'HIGH COUNTERFEIT RISK', es:'ALTO RIESGO DE FALSIFICACIÓN', zh:'高假货风险', tl:'MATAAS NA PANGANIB NG PEKENG PRODUKTO', vi:'RỦI RO HÀNG GIẢ CAO', ar:'خطورة عالية للتزييف', fr:'RISQUE ÉLEVÉ DE CONTREFAÇON', ko:'높은 위조 위험', ru:'ВЫСОКИЙ РИСК ПОДДЕЛКИ', de:'HOHES FÄLSCHUNGSRISIKO' },
  verdictPass: { en:'Pass', es:'Aprobado', zh:'通过', tl:'Pasado', vi:'Đạt', ar:'اجتياز', fr:'Réussi', ko:'통과', ru:'Пройдено', de:'Bestanden' },
  verdictFlag: { en:'Flag', es:'Marcado', zh:'标记', tl:'Naka-flag', vi:'Cảnh Báo', ar:'مُعلَّم', fr:'Signalé', ko:'표시됨', ru:'Отмечено', de:'Markiert' },
  verdictHighFlag: { en:'High Flag', es:'Marca Alta', zh:'高度标记', tl:'Mataas na Flag', vi:'Cảnh Báo Cao', ar:'تعليم عالي', fr:'Signalement Élevé', ko:'높은 위험 표시', ru:'Высокая Отметка', de:'Hohe Markierung' },
  verdictNA: { en:'N/A', es:'N/D', zh:'不适用', tl:'N/A', vi:'Không Áp Dụng', ar:'غير متاح', fr:'N/D', ko:'해당 없음', ru:'Н/Д', de:'Nicht Verfügbar' },
  imageIntegrityTitle: { en:'Image Integrity', es:'Integridad de la Imagen', zh:'图像完整性', tl:'Integridad ng Larawan', vi:'Tính Xác Thực Hình Ảnh', ar:'سلامة الصورة', fr:'Intégrité de l’Image', ko:'이미지 무결성', ru:'Достоверность Изображения', de:'Bildintegrität' },
  textDescriptionTitle: { en:'Text & Description', es:'Texto y Descripción', zh:'文本与描述', tl:'Teksto at Paglalarawan', vi:'Văn Bản & Mô Tả', ar:'النص والوصف', fr:'Texte et Description', ko:'텍스트 및 설명', ru:'Текст и Описание', de:'Text & Beschreibung' },
  priceVarianceTitle: { en:'Price Variance', es:'Variación de Precio', zh:'价格差异', tl:'Pagkakaiba sa Presyo', vi:'Chênh Lệch Giá', ar:'فرق السعر', fr:'Écart de Prix', ko:'가격 편차', ru:'Отклонение Цены', de:'Preisabweichung' },
  estRetailLabel: { en:'Est. Retail (MSRP)', es:'Valor de Venta Estimado (PVP)', zh:'预估零售价（建议零售价）', tl:'Tinatayang Retail (MSRP)', vi:'Giá Bán Lẻ Ước Tính (MSRP)', ar:'سعر التجزئة المقدر (السعر المقترح)', fr:'Valeur de Détail Estimée (PDSF)', ko:'추정 소매가(MSRP)', ru:'Оценочная Розничная Цена (РРЦ)', de:'Geschätzter Einzelhandelswert (UVP)' },
  vsEstRetailSuffix: { en:'vs est. retail (MSRP)', es:'frente al valor de venta estimado (PVP)', zh:'相对于预估零售价（建议零售价）', tl:'kumpara sa tinatayang retail (MSRP)', vi:'so với giá bán lẻ ước tính (MSRP)', ar:'مقارنة بسعر التجزئة المقدر', fr:'par rapport à la valeur de détail estimée (PDSF)', ko:'추정 소매가(MSRP) 대비', ru:'по сравнению с оценочной розничной ценой', de:'im Vergleich zum geschätzten Einzelhandelswert (UVP)' },
  batchCodeCheckTitle: { en:'Batch / Serial Code Check', es:'Verificación de Código de Lote / Serie', zh:'批次/序列号检查', tl:'Pagsusuri ng Batch / Serial Code', vi:'Kiểm Tra Mã Lô / Số Sê-ri', ar:'فحص رمز الدفعة / الرقم التسلسلي', fr:'Vérification du Code de Lot / Série', ko:'배치/일련번호 검사', ru:'Проверка Партийного / Серийного Кода', de:'Chargen-/Seriennummern-Prüfung' },
  validLabel: { en:'VALID', es:'VÁLIDO', zh:'有效', tl:'BALIDO', vi:'HỢP LỆ', ar:'صالح', fr:'VALIDE', ko:'유효', ru:'ДЕЙСТВИТЕЛЕН', de:'GÜLTIG' },
  flaggedLabel: { en:'FLAGGED', es:'MARCADO', zh:'已标记', tl:'NA-FLAG', vi:'BỊ CẢNH BÁO', ar:'تم التعليم', fr:'SIGNALÉ', ko:'표시됨', ru:'ОТМЕЧЕНО', de:'MARKIERT' },

  // ---------- buildManualReport dynamic labels ----------
  textVerdictHighLabel: { en:'Multiple Suspicious Phrases', es:'Varias Frases Sospechosas', zh:'多处可疑措辞', tl:'Maraming Kahina-hinalang Parirala', vi:'Nhiều Cụm Từ Đáng Ngờ', ar:'عبارات مشبوهة متعددة', fr:'Plusieurs Formulations Suspectes', ko:'다수의 의심스러운 문구', ru:'Несколько Подозрительных Фраз', de:'Mehrere Verdächtige Formulierungen' },
  textVerdictModerateLabel: { en:'Some Suspicious Phrasing', es:'Algunas Frases Sospechosas', zh:'部分可疑措辞', tl:'May Kahina-hinalang Parirala', vi:'Một Số Cụm Từ Đáng Ngờ', ar:'بعض العبارات المشبوهة', fr:'Quelques Formulations Suspectes', ko:'일부 의심스러운 문구', ru:'Некоторые Подозрительные Фразы', de:'Einige Verdächtige Formulierungen' },
  textVerdictPassLabel: { en:'No Suspicious Phrasing Detected', es:'No se Detectaron Frases Sospechosas', zh:'未发现可疑措辞', tl:'Walang Nakitang Kahina-hinalang Parirala', vi:'Không Phát Hiện Cụm Từ Đáng Ngờ', ar:'لم يتم اكتشاف عبارات مشبوهة', fr:'Aucune Formulation Suspecte Détectée', ko:'의심스러운 문구 없음', ru:'Подозрительных Фраз Не Обнаружено', de:'Keine Verdächtigen Formulierungen Gefunden' },
  textDetailWithDescription: { en:'Scanned the title and description for language patterns commonly associated with scam or low-trust listings.', es:'Se analizaron el título y la descripción en busca de patrones de lenguaje comúnmente asociados con anuncios fraudulentos o poco confiables.', zh:'已扫描标题和描述，查找常见于诈骗或低信誉商品的语言模式。', tl:'Sinuri ang pamagat at paglalarawan para sa mga pattern ng wika na karaniwang nauugnay sa scam o hindi mapagkakatiwalaang listahan.', vi:'Đã quét tiêu đề và mô tả để tìm các mẫu ngôn ngữ thường liên quan đến lừa đảo hoặc sản phẩm kém tin cậy.', ar:'تم فحص العنوان والوصف بحثًا عن أنماط لغوية ترتبط عادةً بالإعلانات الاحتيالية أو منخفضة الثقة.', fr:'Le titre et la description ont été analysés à la recherche de formulations généralement associées aux annonces frauduleuses ou peu fiables.', ko:'제목과 설명에서 사기성 또는 신뢰도가 낮은 상품에서 흔히 나타나는 언어 패턴을 검사했습니다.', ru:'Заголовок и описание проверены на языковые шаблоны, характерные для мошеннических или подозрительных объявлений.', de:'Titel und Beschreibung wurden auf Sprachmuster geprüft, die häufig mit betrügerischen oder wenig vertrauenswürdigen Angeboten in Verbindung stehen.' },
  textDetailNoDescription: { en:'No description/notes were entered, so only the title was scanned.', es:'No se ingresó ninguna descripción o nota, por lo que solo se analizó el título.', zh:'未输入描述/备注，因此仅扫描了标题。', tl:'Walang inilagay na paglalarawan/tala, kaya ang pamagat lang ang sinuri.', vi:'Không có mô tả/ghi chú nào được nhập, vì vậy chỉ tiêu đề được quét.', ar:'لم يتم إدخال وصف/ملاحظات، لذا تم فحص العنوان فقط.', fr:'Aucune description/remarque n’a été saisie, seul le titre a donc été analysé.', ko:'설명/메모가 입력되지 않아 제목만 검사했습니다.', ru:'Описание/примечания не были указаны, поэтому проверен только заголовок.', de:'Es wurde keine Beschreibung/Notiz eingegeben, daher wurde nur der Titel geprüft.' },
  priceNoListedLabel: { en:'No Listed Price', es:'Sin Precio Indicado', zh:'未提供标价', tl:'Walang Nakalistang Presyo', vi:'Chưa Có Giá Niêm Yết', ar:'لا يوجد سعر معلن', fr:'Aucun Prix Indiqué', ko:'판매 가격 없음', ru:'Цена Не Указана', de:'Kein Angebotspreis' },
  priceNoListedDetail: { en:'Enter a listed price to run a price-variance check.', es:'Ingresa un precio de venta para realizar una verificación de variación de precio.', zh:'请输入标价以进行价格差异检查。', tl:'Maglagay ng nakalistang presyo upang masuri ang pagkakaiba sa presyo.', vi:'Nhập giá niêm yết để kiểm tra chênh lệch giá.', ar:'أدخل السعر المعلن لإجراء فحص فرق السعر.', fr:'Saisissez un prix affiché pour effectuer une vérification de l’écart de prix.', ko:'가격 편차를 확인하려면 판매 가격을 입력하세요.', ru:'Введите указанную цену, чтобы проверить отклонение цены.', de:'Geben Sie einen Angebotspreis ein, um die Preisabweichung zu prüfen.' },
  priceHighLabel: { en:'Severe Price Anomaly', es:'Anomalía de Precio Grave', zh:'严重价格异常', tl:'Matinding Kakaibang Presyo', vi:'Bất Thường Giá Nghiêm Trọng', ar:'شذوذ سعري خطير', fr:'Anomalie de Prix Sévère', ko:'심각한 가격 이상', ru:'Серьёзная Ценовая Аномалия', de:'Schwerwiegende Preisanomalie' },
  priceModerateLabel: { en:'Below-Market Price', es:'Precio por Debajo del Mercado', zh:'低于市场价', tl:'Presyong Mas Mababa sa Merkado', vi:'Giá Thấp Hơn Thị Trường', ar:'سعر أقل من سعر السوق', fr:'Prix Inférieur au Marché', ko:'시장가 이하', ru:'Цена Ниже Рыночной', de:'Preis Unter Marktwert' },
  pricePassLabel: { en:'Price Aligned', es:'Precio Acorde', zh:'价格正常', tl:'Angkop na Presyo', vi:'Giá Phù Hợp', ar:'السعر متوافق', fr:'Prix Cohérent', ko:'적정 가격', ru:'Цена Соответствует', de:'Preis Angemessen' },
  priceBelowSuffixHigh: { en:'High Flag', es:'Marca Alta', zh:'高度标记', tl:'Mataas na Flag', vi:'Cảnh Báo Cao', ar:'تعليم عالي', fr:'Signalement Élevé', ko:'높은 위험 표시', ru:'Высокая Отметка', de:'Hohe Markierung' },
  priceBelowSuffixModerate: { en:'worth double-checking', es:'vale la pena verificarlo', zh:'值得进一步核实', tl:'sulit na tingnang muli', vi:'nên kiểm tra lại', ar:'يستحق التحقق مرة أخرى', fr:'mérite d’être vérifié', ko:'다시 확인해볼 필요가 있음', ru:'стоит перепроверить', de:'sollte überprüft werden' },
  priceBelowSuffixPass: { en:'within normal range', es:'dentro del rango normal', zh:'处于正常范围内', tl:'nasa normal na saklaw', vi:'trong phạm vi bình thường', ar:'ضمن النطاق الطبيعي', fr:'dans la fourchette normale', ko:'정상 범위 내', ru:'в пределах нормы', de:'im normalen Bereich' },
  priceDetailBelowPrefix: { en:'Price is', es:'El precio es', zh:'价格比', tl:'Ang presyo ay', vi:'Giá thấp hơn', ar:'السعر أقل بنسبة', fr:'Le prix est inférieur de', ko:'가격이', ru:'Цена ниже расчётной розничной (РРЦ)', de:'Der Preis liegt' },
  priceDetailBelowMid: { en:'% below the AI-estimated retail (MSRP) value', es:'% por debajo del valor de venta estimado por IA (PVP)', zh:'%（低于人工智能估算的零售价/建议零售价）', tl:'% mas mababa kaysa sa tinatayang retail value (MSRP) ng AI', vi:'% thấp hơn giá trị bán lẻ ước tính bởi AI (MSRP)', ar:'% أقل من سعر التجزئة المقدر بالذكاء الاصطناعي', fr:'% en dessous de la valeur de détail estimée par l’IA (PDSF)', ko:'% 낮습니다 (AI 추정 소매가/MSRP 기준)', ru:'на {pct}% ниже расчётной розничной цены (РРЦ), оценённой ИИ', de:'% unter dem von der KI geschätzten Einzelhandelswert (UVP)', },
  priceDetailAbovePrefix: { en:'Price is at or above the AI-estimated retail (MSRP) value', es:'El precio es igual o superior al valor de venta estimado por IA (PVP)', zh:'价格等于或高于人工智能估算的零售价（建议零售价）', tl:'Ang presyo ay katumbas o mas mataas sa tinatayang retail value (MSRP) ng AI', vi:'Giá bằng hoặc cao hơn giá trị bán lẻ ước tính bởi AI (MSRP)', ar:'السعر يساوي أو يزيد عن سعر التجزئة المقدر بالذكاء الاصطناعي', fr:'Le prix est égal ou supérieur à la valeur de détail estimée par l’IA (PDSF)', ko:'가격이 AI 추정 소매가(MSRP) 이상입니다', ru:'Цена равна или выше расчётной розничной цены (РРЦ), оценённой ИИ', de:'Der Preis liegt auf oder über dem von der KI geschätzten Einzelhandelswert (UVP)' },
  priceRangeConnector: { en:'est. range', es:'rango estimado', zh:'预估范围', tl:'tinatayang saklaw', vi:'khoảng ước tính', ar:'النطاق المقدر', fr:'fourchette estimée', ko:'추정 범위', ru:'оценочный диапазон', de:'geschätzter Bereich' },
  confidenceWordHigh: { en:'high', es:'alta', zh:'高', tl:'mataas', vi:'cao', ar:'عالية', fr:'élevée', ko:'높음', ru:'высокая', de:'hoch' },
  confidenceWordMedium: { en:'medium', es:'media', zh:'中', tl:'katamtaman', vi:'trung bình', ar:'متوسطة', fr:'moyenne', ko:'보통', ru:'средняя', de:'mittel' },
  confidenceWordLow: { en:'low', es:'baja', zh:'低', tl:'mababa', vi:'thấp', ar:'منخفضة', fr:'faible', ko:'낮음', ru:'низкая', de:'niedrig' },
  confidenceSuffix: { en:'confidence', es:'de confianza', zh:'置信度', tl:'kumpiyansa', vi:'độ tin cậy', ar:'ثقة', fr:'de confiance', ko:'신뢰도', ru:'уверенность', de:'Konfidenz' },
  imageNotVerifiedLabel: { en:'Not Verified', es:'No Verificado', zh:'未验证', tl:'Hindi Naberipika', vi:'Chưa Xác Minh', ar:'غير موثق', fr:'Non Vérifié', ko:'미확인', ru:'Не Проверено', de:'Nicht Überprüft' },
  imageNoUploadDetail: { en:'No images were uploaded, so no visual review could be performed.', es:'No se subieron imágenes, por lo que no se pudo realizar una revisión visual.', zh:'未上传图片，因此无法进行视觉审查。', tl:'Walang na-upload na larawan, kaya hindi maisasagawa ang visual review.', vi:'Không có hình ảnh nào được tải lên, vì vậy không thể thực hiện đánh giá trực quan.', ar:'لم يتم رفع أي صور، لذا تعذّر إجراء مراجعة بصرية.', fr:'Aucune image n’a été téléchargée, l’examen visuel n’a donc pas pu être effectué.', ko:'업로드된 이미지가 없어 시각적 검토를 수행할 수 없습니다.', ru:'Изображения не были загружены, поэтому визуальная проверка не проводилась.', de:'Es wurden keine Bilder hochgeladen, daher konnte keine visuelle Prüfung durchgeführt werden.' },
  imageAnalysisUnavailableLabel: { en:'Analysis Unavailable', es:'Análisis No Disponible', zh:'分析不可用', tl:'Hindi Available ang Pagsusuri', vi:'Không Có Phân Tích', ar:'التحليل غير متاح', fr:'Analyse Indisponible', ko:'분석 불가', ru:'Анализ Недоступен', de:'Analyse Nicht Verfügbar' },
  imageAnalysisUnavailableDetail: { en:'Images were uploaded, but the vision model did not return a usable result for them.', es:'Se subieron imágenes, pero el modelo de visión no devolvió un resultado utilizable para ellas.', zh:'图片已上传，但视觉模型未返回可用的分析结果。', tl:'May na-upload na larawan, ngunit hindi nagbigay ang vision model ng magagamit na resulta para dito.', vi:'Hình ảnh đã được tải lên, nhưng mô hình thị giác không trả về kết quả sử dụng được.', ar:'تم رفع الصور، لكن نموذج الرؤية لم يُرجع نتيجة قابلة للاستخدام لها.', fr:'Des images ont été téléchargées, mais le modèle de vision n’a pas renvoyé de résultat exploitable.', ko:'이미지가 업로드되었지만 비전 모델이 사용 가능한 결과를 반환하지 않았습니다.', ru:'Изображения были загружены, но модель компьютерного зрения не вернула пригодный результат.', de:'Bilder wurden hochgeladen, aber das Bildmodell lieferte kein verwertbares Ergebnis.' },
  imageHighLabel: { en:'Possible Counterfeit Indicators', es:'Posibles Indicios de Falsificación', zh:'可能存在假货迹象', tl:'Posibleng mga Palatandaan ng Peke', vi:'Có Thể Có Dấu Hiệu Hàng Giả', ar:'مؤشرات محتملة على التزييف', fr:'Indices Possibles de Contrefaçon', ko:'위조 가능성 있음', ru:'Возможные Признаки Подделки', de:'Mögliche Fälschungshinweise' },
  imageModerateLabel: { en:'Some Visual Inconsistencies', es:'Algunas Inconsistencias Visuales', zh:'存在部分视觉不一致', tl:'May mga Hindi Pagkakatugma sa Visual', vi:'Một Số Điểm Bất Nhất Về Hình Ảnh', ar:'بعض التناقضات البصرية', fr:'Quelques Incohérences Visuelles', ko:'일부 시각적 불일치', ru:'Некоторые Визуальные Несоответствия', de:'Einige Visuelle Unstimmigkeiten' },
  imagePassLabel: { en:'No Visual Red Flags Detected', es:'No se Detectaron Señales Visuales de Alerta', zh:'未发现视觉风险信号', tl:'Walang Nakitang Visual Red Flag', vi:'Không Phát Hiện Dấu Hiệu Cảnh Báo Hình Ảnh', ar:'لم يتم اكتشاف إشارات تحذير بصرية', fr:'Aucun Signal d’Alerte Visuel Détecté', ko:'시각적 위험 신호 없음', ru:'Визуальных Тревожных Признаков Не Обнаружено', de:'Keine Visuellen Warnsignale Gefunden' },
  imageAnalyzedDetail: { en:'AI vision review of the uploaded photo(s) for label/logo, packaging, and stock-photo inconsistencies. Heuristic review, not certified authentication.', es:'Revisión visual por IA de las fotos subidas en busca de inconsistencias en etiquetas/logotipos, empaques y fotos de stock. Revisión heurística, no una autenticación certificada.', zh:'人工智能视觉审查已上传的照片，检查标签/标志、包装及网络图库照片的不一致之处。此为启发式审查，并非认证鉴定。', tl:'Sinuri ng AI vision ang mga na-upload na larawan para sa hindi pagkakatugma sa label/logo, packaging, at stock photo. Heuristic review lamang, hindi ito sertipikadong pagpapatunay.', vi:'AI đã xem xét trực quan (các) ảnh đã tải lên để tìm điểm bất nhất về nhãn/logo, bao bì và ảnh stock. Đây là đánh giá theo kinh nghiệm, không phải xác thực chính thức.', ar:'مراجعة بصرية بالذكاء الاصطناعي للصور المرفوعة للتحقق من تناقضات الملصق/الشعار والتغليف والصور الجاهزة (stock). مراجعة استدلالية وليست توثيقًا معتمدًا.', fr:'Examen visuel par IA des photos téléchargées à la recherche d’incohérences dans l’étiquette/le logo, l’emballage et les photos de stock. Analyse heuristique, non une authentification certifiée.', ko:'업로드된 사진에서 라벨/로고, 포장, 스톡 이미지 불일치 여부를 AI 비전으로 검토했습니다. 이는 휴리스틱 검토이며 공인 감정이 아닙니다.', ru:'ИИ визуально проверил загруженные фото на несоответствия в этикетке/логотипе, упаковке и признаки стоковых изображений. Эвристическая проверка, не является сертифицированной экспертизой.', de:'KI-Bildprüfung der hochgeladenen Fotos auf Unstimmigkeiten bei Etikett/Logo, Verpackung und Stockfoto-Merkmalen. Heuristische Prüfung, keine zertifizierte Echtheitsprüfung.' },
  summaryHigh: { en:'Elevated risk signals detected from the entered data. Recommend manual verification before purchase.', es:'Se detectaron señales de riesgo elevado en los datos ingresados. Se recomienda verificación manual antes de comprar.', zh:'根据输入的数据检测到较高的风险信号。建议在购买前进行人工核实。', tl:'May nakitang mataas na senyales ng panganib mula sa ipinasok na datos. Inirerekomenda ang manual na pagpapatunay bago bumili.', vi:'Phát hiện tín hiệu rủi ro cao từ dữ liệu đã nhập. Khuyến nghị xác minh thủ công trước khi mua.', ar:'تم اكتشاف مؤشرات خطورة مرتفعة من البيانات المُدخلة. يُنصح بالتحقق اليدوي قبل الشراء.', fr:'Signaux de risque élevé détectés à partir des données saisies. Une vérification manuelle avant l’achat est recommandée.', ko:'입력된 데이터에서 높은 위험 신호가 감지되었습니다. 구매 전 수동 확인을 권장합니다.', ru:'В введённых данных обнаружены признаки повышенного риска. Рекомендуется ручная проверка перед покупкой.', de:'Erhöhte Risikosignale in den eingegebenen Daten festgestellt. Manuelle Überprüfung vor dem Kauf wird empfohlen.' },
  summaryModerate: { en:'Some risk signals detected from the entered data. Not conclusive on their own — worth double-checking.', es:'Se detectaron algunas señales de riesgo en los datos ingresados. No son concluyentes por sí solas, pero vale la pena verificarlas.', zh:'根据输入的数据检测到一些风险信号。这些信号本身并非定论，但值得进一步核实。', tl:'May nakitang ilang senyales ng panganib mula sa ipinasok na datos. Hindi ito konklusibo mag-isa — sulit na tingnang muli.', vi:'Phát hiện một số tín hiệu rủi ro từ dữ liệu đã nhập. Chưa đủ để kết luận nhưng nên kiểm tra lại.', ar:'تم اكتشاف بعض مؤشرات الخطورة من البيانات المُدخلة. ليست قاطعة بحد ذاتها — يستحق الأمر التحقق مرة أخرى.', fr:'Certains signaux de risque ont été détectés à partir des données saisies. Non concluants à eux seuls — mieux vaut vérifier.', ko:'입력된 데이터에서 일부 위험 신호가 감지되었습니다. 단독으로는 결정적이지 않으나 다시 확인해볼 가치가 있습니다.', ru:'В введённых данных обнаружены отдельные признаки риска. Сами по себе они не окончательны — стоит перепроверить.', de:'Einige Risikosignale in den eingegebenen Daten festgestellt. Für sich genommen nicht eindeutig — eine Überprüfung lohnt sich.' },
  summaryLegit: { en:'No significant risk signals detected from the data entered.', es:'No se detectaron señales de riesgo significativas en los datos ingresados.', zh:'根据输入的数据未检测到明显的风险信号。', tl:'Walang nakitang makabuluhang senyales ng panganib mula sa ipinasok na datos.', vi:'Không phát hiện tín hiệu rủi ro đáng kể từ dữ liệu đã nhập.', ar:'لم يتم اكتشاف مؤشرات خطورة ملحوظة من البيانات المُدخلة.', fr:'Aucun signal de risque significatif détecté à partir des données saisies.', ko:'입력된 데이터에서 유의미한 위험 신호가 감지되지 않았습니다.', ru:'В введённых данных не обнаружено значимых признаков риска.', de:'Keine signifikanten Risikosignale in den eingegebenen Daten festgestellt.' },
  reportNoteText: { en:'Retail price and image findings are generated by an AI model — treat as an assistive signal, not certified authentication.', es:'El precio de venta y los hallazgos de imagen son generados por un modelo de IA; considérelos una señal de apoyo, no una autenticación certificada.', zh:'零售价及图像分析结果均由人工智能模型生成——请将其视为辅助参考信号，而非认证鉴定。', tl:'Ang retail price at mga natuklasan sa larawan ay gawa ng AI model — ituring itong panulong na senyales, hindi sertipikadong pagpapatunay.', vi:'Giá bán lẻ và các phát hiện về hình ảnh do mô hình AI tạo ra — hãy xem đây là tín hiệu hỗ trợ, không phải xác thực chính thức.', ar:'يتم إنشاء سعر التجزئة ونتائج تحليل الصور بواسطة نموذج ذكاء اصطناعي — اعتبرها إشارة مساعدة وليست توثيقًا معتمدًا.', fr:'Le prix de détail et les résultats d’image sont générés par un modèle d’IA — à considérer comme un signal d’aide, non une authentification certifiée.', ko:'소매가와 이미지 분석 결과는 AI 모델이 생성한 것입니다 — 참고용 신호로만 활용하고 공인 감정으로 취급하지 마세요.', ru:'Розничная цена и результаты анализа изображений созданы ИИ-моделью — воспринимайте это как вспомогательный сигнал, а не сертифицированную экспертизу.', de:'Einzelhandelspreis und Bildanalyseergebnisse werden von einem KI-Modell erstellt — als unterstützendes Signal zu verstehen, nicht als zertifizierte Echtheitsprüfung.' },
  footerDetection: { en:'Demo tool. Text flags are computed locally from the fields you enter. Retail price estimates and image findings are generated by an AI vision model and may be inaccurate — treat as an assistive signal, not certified authentication.', es:'Herramienta de demostración. Las alertas de texto se calculan localmente a partir de los campos que ingresas. Las estimaciones de precio de venta y los hallazgos de imagen son generados por un modelo de visión de IA y pueden ser inexactos; considérelos una señal de apoyo, no una autenticación certificada.', zh:'演示工具。文本标记根据您输入的字段在本地计算得出。零售价估算和图像分析结果由人工智能视觉模型生成，可能不准确——请将其视为辅助参考信号，而非认证鉴定。', tl:'Demo tool. Ang mga text flag ay kinakalkula nang lokal mula sa mga field na inilagay mo. Ang mga tantiya ng retail price at natuklasan sa larawan ay gawa ng AI vision model at maaaring hindi tumpak — ituring itong panulong na senyales, hindi sertipikadong pagpapatunay.', vi:'Công cụ minh họa. Cảnh báo văn bản được tính toán cục bộ từ các trường bạn nhập. Ước tính giá bán lẻ và phát hiện hình ảnh do mô hình thị giác AI tạo ra và có thể không chính xác — hãy xem đây là tín hiệu hỗ trợ, không phải xác thực chính thức.', ar:'أداة تجريبية. يتم احتساب إشارات النص محليًا من الحقول التي تُدخلها. يتم إنشاء تقديرات سعر التجزئة ونتائج تحليل الصور بواسطة نموذج رؤية بالذكاء الاصطناعي وقد تكون غير دقيقة — اعتبرها إشارة مساعدة وليست توثيقًا معتمدًا.', fr:'Outil de démonstration. Les signalements textuels sont calculés localement à partir des champs que vous saisissez. Les estimations de prix de détail et les résultats d’image sont générés par un modèle de vision IA et peuvent être inexacts — à considérer comme un signal d’aide, non une authentification certifiée.', ko:'데모 도구입니다. 텍스트 표시는 입력한 필드를 기반으로 로컬에서 계산됩니다. 소매가 추정치와 이미지 분석 결과는 AI 비전 모델이 생성한 것으로 부정확할 수 있습니다 — 참고용 신호로만 활용하고 공인 감정으로 취급하지 마세요.', ru:'Демонстрационный инструмент. Текстовые пометки вычисляются локально на основе введённых вами данных. Оценки розничной цены и результаты анализа изображений создаются ИИ-моделью и могут быть неточными — воспринимайте это как вспомогательный сигнал, а не сертифицированную экспертизу.', de:'Demo-Tool. Textmarkierungen werden lokal aus den von Ihnen eingegebenen Feldern berechnet. Einzelhandelspreisschätzungen und Bildanalyseergebnisse werden von einem KI-Bildmodell erstellt und können ungenau sein — als unterstützendes Signal zu verstehen, nicht als zertifizierte Echtheitsprüfung.' },

  // ---------- validateBatchCode ----------
  batchInvalidFormat: { en:'Does not match standard manufacturer format (2 letters + 6 digits, e.g. "FR228145"). Non-conforming codes are commonly seen on counterfeit packaging.', es:'No coincide con el formato estándar del fabricante (2 letras + 6 dígitos, p. ej., "FR228145"). Los códigos no conformes son comunes en el empaque falsificado.', zh:'不符合标准制造商格式（2个字母+6个数字，例如"FR228145"）。假冒包装上常见不符合规范的代码。', tl:'Hindi tugma sa karaniwang format ng gumagawa (2 titik + 6 numero, hal. "FR228145"). Karaniwang nakikita ang mga hindi tugmang code sa pekeng packaging.', vi:'Không khớp với định dạng tiêu chuẩn của nhà sản xuất (2 chữ cái + 6 chữ số, VD: "FR228145"). Mã không đúng định dạng thường thấy trên bao bì hàng giả.', ar:'لا يتطابق مع الصيغة القياسية للشركة المصنعة (حرفان + 6 أرقام، مثل "FR228145"). غالبًا ما تظهر الرموز غير المطابقة على العبوات المزيفة.', fr:'Ne correspond pas au format standard du fabricant (2 lettres + 6 chiffres, ex. "FR228145"). Les codes non conformes sont fréquents sur les emballages contrefaits.', ko:'표준 제조사 형식(영문자 2자 + 숫자 6자, 예: "FR228145")과 일치하지 않습니다. 형식에 맞지 않는 코드는 위조 포장에서 흔히 발견됩니다.', ru:'Не соответствует стандартному формату производителя (2 буквы + 6 цифр, например, "FR228145"). Несоответствующие коды часто встречаются на поддельной упаковке.', de:'Entspricht nicht dem Standardformat des Herstellers (2 Buchstaben + 6 Ziffern, z. B. "FR228145"). Nicht konforme Codes sind häufig auf gefälschten Verpackungen zu finden.' },
  batchDuplicate: { en:'This exact code has been reported across multiple unrelated listings — a strong indicator of a commonly duplicated counterfeit batch code.', es:'Este código exacto se ha reportado en múltiples anuncios no relacionados, un fuerte indicio de un código de lote falsificado duplicado comúnmente.', zh:'该确切代码已在多个无关商品中被报告——这是常见重复使用的假冒批次代码的有力迹象。', tl:'Naiulat ang eksaktong code na ito sa maraming hindi magkaugnay na listahan — malakas na indikasyon ng karaniwang pinandarayang batch code.', vi:'Mã chính xác này đã được báo cáo trên nhiều sản phẩm không liên quan — dấu hiệu mạnh cho thấy đây là mã lô hàng giả bị trùng lặp phổ biến.', ar:'تم الإبلاغ عن هذا الرمز بعينه في العديد من الإعلانات غير المرتبطة — مؤشر قوي على رمز دفعة مزيفة مكرر بشكل شائع.', fr:'Ce code exact a été signalé sur plusieurs annonces sans lien entre elles — un indice fort d’un code de lot contrefait couramment dupliqué.', ko:'이 정확한 코드는 서로 관련 없는 여러 상품에서 보고되었습니다 — 흔히 중복 사용되는 위조 배치 코드의 강력한 신호입니다.', ru:'Этот же самый код был замечен в нескольких не связанных между собой объявлениях — явный признак часто дублируемого поддельного партийного кода.', de:'Genau dieser Code wurde bei mehreren nicht zusammenhängenden Angeboten gemeldet — ein starkes Indiz für einen häufig duplizierten gefälschten Chargencode.' },
  batchValidReason: { en:'Format matches standard manufacturer conventions and does not appear in the known invalid/duplicate registry.', es:'El formato coincide con las convenciones estándar del fabricante y no aparece en el registro conocido de códigos inválidos o duplicados.', zh:'格式符合标准制造商规范，且未出现在已知的无效/重复代码库中。', tl:'Tugma ang format sa karaniwang kombensiyon ng gumagawa at hindi ito lumalabas sa kilalang rehistro ng invalid/duplicate.', vi:'Định dạng khớp với quy ước tiêu chuẩn của nhà sản xuất và không xuất hiện trong cơ sở dữ liệu mã trùng lặp/không hợp lệ đã biết.', ar:'تتطابق الصيغة مع اصطلاحات الشركة المصنعة القياسية ولا تظهر في سجل الرموز غير الصالحة/المكررة المعروفة.', fr:'Le format correspond aux conventions standard du fabricant et n’apparaît pas dans le registre connu des codes invalides ou en double.', ko:'표준 제조사 규칙과 일치하며 알려진 무효/중복 코드 목록에도 없습니다.', ru:'Формат соответствует стандартным правилам производителя и не значится в реестре известных недействительных/повторяющихся кодов.', de:'Das Format entspricht den Standardkonventionen des Herstellers und erscheint nicht im Verzeichnis bekannter ungültiger/doppelter Codes.' },

  // ---------- Form validation errors ----------
  analyzeMinInputError: { en:'Enter at least an item title or description, or upload an image, to analyze.', es:'Ingresa al menos un título o descripción del artículo, o sube una imagen, para analizar.', zh:'请至少输入商品标题或描述，或上传图片以进行分析。', tl:'Maglagay ng kahit man lang pamagat o paglalarawan ng item, o mag-upload ng larawan, para masuri.', vi:'Nhập ít nhất tiêu đề hoặc mô tả sản phẩm, hoặc tải lên hình ảnh, để phân tích.', ar:'أدخل عنوان المنتج أو وصفه على الأقل، أو ارفع صورة، لإجراء التحليل.', fr:'Saisissez au moins un titre ou une description de l’article, ou téléchargez une image, pour lancer l’analyse.', ko:'분석하려면 상품명, 설명 중 하나를 입력하거나 이미지를 업로드하세요.', ru:'Введите хотя бы название или описание товара либо загрузите изображение, чтобы выполнить анализ.', de:'Geben Sie mindestens einen Artikeltitel oder eine Beschreibung ein oder laden Sie ein Bild hoch, um die Analyse zu starten.' },
  listedPriceInvalidError: { en:'Listed price must be a valid positive number.', es:'El precio de venta debe ser un número positivo válido.', zh:'标价必须为有效的正数。', tl:'Ang nakalistang presyo ay dapat balidong positibong numero.', vi:'Giá niêm yết phải là một số dương hợp lệ.', ar:'يجب أن يكون السعر المعلن رقمًا موجبًا صالحًا.', fr:'Le prix affiché doit être un nombre positif valide.', ko:'판매 가격은 유효한 양수여야 합니다.', ru:'Указанная цена должна быть корректным положительным числом.', de:'Der Angebotspreis muss eine gültige positive Zahl sein.' },

  // ---------- Complaint modal ----------
  complaintModalTitle: { en:'File an Official Complaint', es:'Presentar una Queja Oficial', zh:'提交官方投诉', tl:'Maghain ng Opisyal na Reklamo', vi:'Nộp Khiếu Nại Chính Thức', ar:'تقديم شكوى رسمية', fr:'Déposer une Plainte Officielle', ko:'공식 신고 접수', ru:'Подать Официальную Жалобу', de:'Offizielle Beschwerde Einreichen' },
  complaintModalSubtitle: { en:'Guided walkthrough for submitting this high-risk listing to ReportFraud.ftc.gov', es:'Guía paso a paso para enviar este anuncio de alto riesgo a ReportFraud.ftc.gov', zh:'指导您将此高风险商品提交至 ReportFraud.ftc.gov', tl:'Gabay na hakbang-hakbang para isumite ang high-risk na listahan na ito sa ReportFraud.ftc.gov', vi:'Hướng dẫn từng bước để gửi sản phẩm rủi ro cao này đến ReportFraud.ftc.gov', ar:'دليل إرشادي لتقديم هذا الإعلان عالي الخطورة إلى ReportFraud.ftc.gov', fr:'Guide pas à pas pour soumettre cette annonce à haut risque à ReportFraud.ftc.gov', ko:'이 고위험 상품을 ReportFraud.ftc.gov에 제출하는 단계별 안내', ru:'Пошаговое руководство по подаче жалобы на это высокорисковое объявление на ReportFraud.ftc.gov', de:'Schrittweise Anleitung zur Meldung dieses hochriskanten Angebots bei ReportFraud.ftc.gov' },
  complaintDisclaimerPrefix: { en:'These steps reflect ReportFraud.ftc.gov’s reporting flow as checked on', es:'Estos pasos reflejan el proceso de denuncia de ReportFraud.ftc.gov verificado el', zh:'以下步骤反映了 ReportFraud.ftc.gov 的举报流程，核实日期为', tl:'Ang mga hakbang na ito ay batay sa proseso ng pag-uulat ng ReportFraud.ftc.gov na sinuri noong', vi:'Các bước này phản ánh quy trình báo cáo của ReportFraud.ftc.gov đã được kiểm tra vào ngày', ar:'تعكس هذه الخطوات آلية الإبلاغ في ReportFraud.ftc.gov كما تم التحقق منها بتاريخ', fr:'Ces étapes reflètent le processus de signalement de ReportFraud.ftc.gov vérifié le', ko:'이 단계는', ru:'Эти шаги отражают процесс подачи жалобы на ReportFraud.ftc.gov, проверенный', de:'Diese Schritte spiegeln den Meldeprozess von ReportFraud.ftc.gov wider, überprüft am' },
  complaintDisclaimerSuffix: { en:'— the FTC can change its form at any time, so treat this as a helpful guide, not a guarantee of an exact match.', es:'; la FTC puede modificar su formulario en cualquier momento, así que trata esto como una guía útil, no como una garantía de coincidencia exacta.', zh:'——联邦贸易委员会（FTC）随时可能更改其表单，因此请将本指南视为参考，而非完全一致的保证。', tl:'— maaaring baguhin ng FTC ang kanilang form anumang oras, kaya ituring ito bilang kapaki-pakinabang na gabay, hindi garantiya ng eksaktong pagtutugma.', vi:'— FTC có thể thay đổi biểu mẫu bất cứ lúc nào, vì vậy hãy xem đây là hướng dẫn tham khảo, không phải sự đảm bảo khớp chính xác.', ar:'— يمكن للجنة التجارة الفيدرالية (FTC) تغيير نموذجها في أي وقت، لذا اعتبر هذا دليلاً مساعدًا وليس ضمانًا لتطابق دقيق.', fr:'— la FTC peut modifier son formulaire à tout moment ; considérez donc ceci comme un guide utile, non une garantie de correspondance exacte.', ko:'2026년 8월 7일 기준 ReportFraud.ftc.gov의 신고 절차를 반영한 것입니다 — FTC는 언제든 양식을 변경할 수 있으므로 참고용 안내로만 활용하시고 완전히 일치한다고 보장하지는 않습니다.', ru:'— FTC может в любой момент изменить свою форму, поэтому воспринимайте это как справочное руководство, а не гарантию точного соответствия.', de:'— die FTC kann ihr Formular jederzeit ändern; betrachten Sie dies daher als hilfreiche Anleitung, nicht als Garantie für eine exakte Übereinstimmung.' },
  stepByStepTitle: { en:'Step-by-step', es:'Paso a paso', zh:'分步说明', tl:'Hakbang-hakbang', vi:'Từng Bước', ar:'خطوة بخطوة', fr:'Étape par Étape', ko:'단계별 안내', ru:'Пошаговая Инструкция', de:'Schritt für Schritt' },
  complaintStep1: { en:'Go to <strong>ReportFraud.ftc.gov</strong> and click <strong>"Report Now"</strong>.', es:'Ve a <strong>ReportFraud.ftc.gov</strong> y haz clic en <strong>"Report Now"</strong>.', zh:'访问 <strong>ReportFraud.ftc.gov</strong>，点击 <strong>"Report Now"</strong>。', tl:'Pumunta sa <strong>ReportFraud.ftc.gov</strong> at i-click ang <strong>"Report Now"</strong>.', vi:'Truy cập <strong>ReportFraud.ftc.gov</strong> và nhấp vào <strong>"Report Now"</strong>.', ar:'اذهب إلى <strong>ReportFraud.ftc.gov</strong> وانقر على <strong>"Report Now"</strong>.', fr:'Rendez-vous sur <strong>ReportFraud.ftc.gov</strong> et cliquez sur <strong>« Report Now »</strong>.', ko:'<strong>ReportFraud.ftc.gov</strong>에 접속해 <strong>"Report Now"</strong>를 클릭하세요.', ru:'Перейдите на <strong>ReportFraud.ftc.gov</strong> и нажмите <strong>«Report Now»</strong>.', de:'Rufen Sie <strong>ReportFraud.ftc.gov</strong> auf und klicken Sie auf <strong>„Report Now"</strong>.' },
  complaintStep2: { en:'Choose <strong>"Online shopping"</strong>, then <strong>"A problem with an online purchase or sale"</strong>.', es:'Elige <strong>"Online shopping"</strong> y luego <strong>"A problem with an online purchase or sale"</strong>.', zh:'选择 <strong>"Online shopping"</strong>，然后选择 <strong>"A problem with an online purchase or sale"</strong>。', tl:'Piliin ang <strong>"Online shopping"</strong>, pagkatapos ay <strong>"A problem with an online purchase or sale"</strong>.', vi:'Chọn <strong>"Online shopping"</strong>, sau đó chọn <strong>"A problem with an online purchase or sale"</strong>.', ar:'اختر <strong>"Online shopping"</strong>، ثم <strong>"A problem with an online purchase or sale"</strong>.', fr:'Choisissez <strong>« Online shopping »</strong>, puis <strong>« A problem with an online purchase or sale »</strong>.', ko:'<strong>"Online shopping"</strong>을 선택한 다음 <strong>"A problem with an online purchase or sale"</strong>을 선택하세요.', ru:'Выберите <strong>«Online shopping»</strong>, затем <strong>«A problem with an online purchase or sale»</strong>.', de:'Wählen Sie <strong>„Online shopping"</strong> und dann <strong>„A problem with an online purchase or sale"</strong>.' },
  complaintStep3: { en:'Under "Report details," check <strong>"I received a fake/counterfeit product"</strong>.', es:'En "Report details," marca <strong>"I received a fake/counterfeit product"</strong>.', zh:'在"Report details"下，勾选 <strong>"I received a fake/counterfeit product"</strong>。', tl:'Sa ilalim ng "Report details," lagyan ng check ang <strong>"I received a fake/counterfeit product"</strong>.', vi:'Trong mục "Report details," chọn <strong>"I received a fake/counterfeit product"</strong>.', ar:'ضمن "Report details"، حدد <strong>"I received a fake/counterfeit product"</strong>.', fr:'Dans « Report details », cochez <strong>« I received a fake/counterfeit product »</strong>.', ko:'"Report details" 항목에서 <strong>"I received a fake/counterfeit product"</strong>를 체크하세요.', ru:'В разделе «Report details» отметьте <strong>«I received a fake/counterfeit product»</strong>.', de:'Aktivieren Sie unter „Report details" die Option <strong>„I received a fake/counterfeit product"</strong>.' },
  complaintStep4: { en:'If you paid the seller, select <strong>"Yes"</strong> and enter the amount — copy it from the box below.', es:'Si le pagaste al vendedor, selecciona <strong>"Yes"</strong> e ingresa el monto; cópialo del cuadro de abajo.', zh:'如果您已向卖家付款，请选择 <strong>"Yes"</strong> 并输入金额——请从下方框中复制。', tl:'Kung nagbayad ka sa nagbebenta, piliin ang <strong>"Yes"</strong> at ilagay ang halaga — kopyahin ito mula sa kahon sa ibaba.', vi:'Nếu bạn đã thanh toán cho người bán, chọn <strong>"Yes"</strong> và nhập số tiền — sao chép từ ô bên dưới.', ar:'إذا كنت قد دفعت للبائع، اختر <strong>"Yes"</strong> وأدخل المبلغ — انسخه من المربع أدناه.', fr:'Si vous avez payé le vendeur, sélectionnez <strong>« Yes »</strong> et saisissez le montant — copiez-le depuis l’encadré ci-dessous.', ko:'판매자에게 대금을 지불했다면 <strong>"Yes"</strong>를 선택하고 금액을 입력하세요 — 아래 박스에서 복사하면 됩니다.', ru:'Если вы заплатили продавцу, выберите <strong>«Yes»</strong> и введите сумму — скопируйте её из поля ниже.', de:'Wenn Sie den Verkäufer bezahlt haben, wählen Sie <strong>„Yes"</strong> und geben Sie den Betrag ein — kopieren Sie ihn aus dem Feld unten.' },
  complaintStep5: { en:'For "How did it start," <strong>"Website or App"</strong> usually fits an online marketplace listing.', es:'Para "How did it start," <strong>"Website or App"</strong> suele ser lo más adecuado para un anuncio de mercado en línea.', zh:'对于"How did it start"，网上市场商品通常应选择 <strong>"Website or App"</strong>。', tl:'Para sa "How did it start," karaniwang tugma ang <strong>"Website or App"</strong> para sa listahan sa online marketplace.', vi:'Đối với "How did it start," <strong>"Website or App"</strong> thường phù hợp với sản phẩm trên chợ trực tuyến.', ar:'بالنسبة إلى "How did it start"، عادةً ما يناسب <strong>"Website or App"</strong> إعلانات السوق الإلكتروني.', fr:'Pour « How did it start », <strong>« Website or App »</strong> convient généralement à une annonce sur une place de marché en ligne.', ko:'"How did it start" 항목에는 온라인 마켓플레이스 상품의 경우 보통 <strong>"Website or App"</strong>이 적합합니다.', ru:'Для «How did it start» онлайн-объявлению обычно подходит вариант <strong>«Website or App»</strong>.', de:'Bei „How did it start" passt für ein Online-Marktplatz-Angebot meist <strong>„Website or App"</strong>.' },
  complaintStep6: { en:'When asked for details about the company/individual, choose <strong>"Yes"</strong> for additional info and paste the Seller &amp; Listing box below into the Comments field.', es:'Cuando se te pidan detalles sobre la empresa/persona, elige <strong>"Yes"</strong> para información adicional y pega el cuadro de Vendedor y Anuncio en el campo de Comentarios.', zh:'当被要求提供公司/个人详情时，选择 <strong>"Yes"</strong> 以提供更多信息，并将下方"卖家与商品信息"框粘贴到评论字段中。', tl:'Kapag hiniling ang mga detalye tungkol sa kompanya/indibidwal, piliin ang <strong>"Yes"</strong> para sa karagdagang impormasyon at i-paste ang Seller & Listing box sa ibaba sa Comments field.', vi:'Khi được hỏi chi tiết về công ty/cá nhân, chọn <strong>"Yes"</strong> để cung cấp thêm thông tin và dán hộp Thông Tin Người Bán & Sản Phẩm bên dưới vào ô Comments.', ar:'عند سؤالك عن تفاصيل الشركة/الفرد، اختر <strong>"Yes"</strong> لإضافة معلومات، والصق مربع معلومات البائع والإعلان أدناه في حقل التعليقات.', fr:'Lorsqu’on vous demande des détails sur l’entreprise/la personne, choisissez <strong>« Yes »</strong> pour ajouter des informations et collez l’encadré Vendeur & Annonce ci-dessous dans le champ Commentaires.', ko:'업체/개인 정보를 묻는 항목에서는 <strong>"Yes"</strong>를 선택해 추가 정보를 입력하고, 아래 "판매자 및 상품 정보" 박스 내용을 Comments 필드에 붙여넣으세요.', ru:'При запросе сведений о компании/продавце выберите <strong>«Yes»</strong> для дополнительной информации и вставьте блок «Продавец и объявление» ниже в поле Comments.', de:'Wenn nach Details zum Unternehmen/zur Person gefragt wird, wählen Sie <strong>„Yes"</strong> für zusätzliche Informationen und fügen Sie das Feld „Verkäufer & Angebot" unten in das Kommentarfeld ein.' },
  complaintStep7: { en:'Paste the Description box below into <strong>"Describe what happened."</strong>', es:'Pega el cuadro de Descripción de abajo en <strong>"Describe what happened."</strong>', zh:'将下方"描述"框粘贴到 <strong>"Describe what happened."</strong> 中。', tl:'I-paste ang Description box sa ibaba sa <strong>"Describe what happened."</strong>', vi:'Dán hộp Mô Tả bên dưới vào mục <strong>"Describe what happened."</strong>', ar:'الصق مربع الوصف أدناه في <strong>"Describe what happened."</strong>', fr:'Collez l’encadré Description ci-dessous dans <strong>« Describe what happened. »</strong>', ko:'아래 "설명" 박스 내용을 <strong>"Describe what happened."</strong>에 붙여넣으세요.', ru:'Вставьте блок «Описание» ниже в поле <strong>«Describe what happened.»</strong>', de:'Fügen Sie das Beschreibungsfeld unten in <strong>„Describe what happened."</strong> ein.' },
  complaintStep8: { en:'If the form lets you attach files, upload your screenshots below. Otherwise, keep them for your own records.', es:'Si el formulario te permite adjuntar archivos, sube tus capturas de pantalla a continuación. Si no, guárdalas para tus propios registros.', zh:'如果表单允许附加文件，请在下方上传您的截图。否则，请自行保留这些截图作为记录。', tl:'Kung pinapayagan ka ng form na mag-attach ng files, i-upload ang iyong mga screenshot sa ibaba. Kung hindi, itago ang mga ito para sa sarili mong rekord.', vi:'Nếu biểu mẫu cho phép đính kèm tệp, hãy tải ảnh chụp màn hình lên bên dưới. Nếu không, hãy giữ lại để làm hồ sơ cá nhân.', ar:'إذا كان النموذج يسمح بإرفاق الملفات، فقم برفع لقطات الشاشة أدناه. وإلا، احتفظ بها لسجلاتك الخاصة.', fr:'Si le formulaire permet de joindre des fichiers, téléchargez vos captures d’écran ci-dessous. Sinon, conservez-les pour vos propres archives.', ko:'양식에서 파일 첨부가 가능하면 아래에서 스크린샷을 업로드하세요. 불가능하다면 개인 기록용으로 보관하세요.', ru:'Если форма позволяет прикреплять файлы, загрузите скриншоты ниже. В противном случае сохраните их для собственных записей.', de:'Wenn das Formular Dateianhänge zulässt, laden Sie Ihre Screenshots unten hoch. Andernfalls bewahren Sie sie für Ihre eigenen Unterlagen auf.' },
  complaintStep9: { en:'Review everything you entered, then submit your report.', es:'Revisa todo lo que ingresaste y luego envía tu reporte.', zh:'请检查您输入的所有信息，然后提交报告。', tl:'Suriin ang lahat ng inilagay mo, pagkatapos ay isumite ang iyong ulat.', vi:'Xem lại tất cả thông tin đã nhập, sau đó gửi báo cáo của bạn.', ar:'راجع كل ما أدخلته، ثم أرسل تقريرك.', fr:'Vérifiez tout ce que vous avez saisi, puis soumettez votre signalement.', ko:'입력한 모든 내용을 확인한 후 신고서를 제출하세요.', ru:'Проверьте все введённые данные и отправьте жалобу.', de:'Überprüfen Sie alle Angaben und reichen Sie Ihre Meldung ein.' },
  copyReadyDataTitle: { en:'Copy-ready data (matches ReportFraud.ftc.gov’s fields)', es:'Datos listos para copiar (coinciden con los campos de ReportFraud.ftc.gov)', zh:'可直接复制的数据（与 ReportFraud.ftc.gov 的字段对应）', tl:'Datos na handang kopyahin (tugma sa mga field ng ReportFraud.ftc.gov)', vi:'Dữ liệu sẵn sàng để sao chép (khớp với các trường của ReportFraud.ftc.gov)', ar:'بيانات جاهزة للنسخ (تطابق حقول ReportFraud.ftc.gov)', fr:'Données prêtes à copier (correspondent aux champs de ReportFraud.ftc.gov)', ko:'복사해서 바로 사용 가능한 데이터 (ReportFraud.ftc.gov 항목에 맞춤)', ru:'Данные, готовые к копированию (соответствуют полям ReportFraud.ftc.gov)', de:'Kopierbereite Daten (passend zu den Feldern von ReportFraud.ftc.gov)' },
  amountPaidLabel: { en:'Amount Paid', es:'Monto Pagado', zh:'支付金额', tl:'Halagang Binayad', vi:'Số Tiền Đã Thanh Toán', ar:'المبلغ المدفوع', fr:'Montant Payé', ko:'지불 금액', ru:'Уплаченная Сумма', de:'Gezahlter Betrag' },
  amountPaidFor: { en:'for: "How much money did you pay or send?"', es:'para: "How much money did you pay or send?"', zh:'对应字段："How much money did you pay or send?"', tl:'para sa: "How much money did you pay or send?"', vi:'dành cho: "How much money did you pay or send?"', ar:'لحقل: "How much money did you pay or send?"', fr:'pour : « How much money did you pay or send? »', ko:'해당 항목: "How much money did you pay or send?"', ru:'для поля: «How much money did you pay or send?»', de:'für: „How much money did you pay or send?"' },
  amountNoteCurrencyPrefix: { en:'Note: this listing was priced in', es:'Nota: este anuncio estaba en', zh:'注意：此商品定价单位为', tl:'Tandaan: ang listahan na ito ay naka-presyo sa', vi:'Lưu ý: sản phẩm này được định giá bằng', ar:'ملاحظة: تم تسعير هذا الإعلان بعملة', fr:'Remarque : cette annonce était au prix en', ko:'참고: 이 상품의 통화 단위는', ru:'Примечание: цена в этом объявлении указана в', de:'Hinweis: Dieses Angebot war in' },
  amountNoteCurrencySuffix: { en:'. The FTC form’s amount field is in USD — convert before entering.', es:'. El campo de monto del formulario de la FTC está en USD; conviértelo antes de ingresarlo.', zh:'。FTC 表单的金额字段以美元为单位——请先换算再填写。', tl:'. Ang amount field sa FTC form ay nasa USD — i-convert muna bago ilagay.', vi:'. Trường số tiền trên biểu mẫu FTC tính bằng USD — hãy quy đổi trước khi nhập.', ar:'. حقل المبلغ في نموذج FTC بالدولار الأمريكي — قم بالتحويل قبل الإدخال.', fr:'. Le champ de montant du formulaire de la FTC est en USD — convertissez avant de le saisir.', ko:' 표기되어 있습니다. FTC 양식의 금액 필드는 USD 기준이므로 입력 전 환산하세요.', ru:'. Поле суммы в форме FTC указывается в долларах США — конвертируйте перед вводом.', de:' angegeben. Das Betragsfeld im FTC-Formular ist in USD — vor der Eingabe umrechnen.' },
  amountNoteNoPrice: { en:'No listed price was entered, so there’s nothing to copy here — select "No" for "Did you pay or send money?" unless you actually paid.', es:'No se ingresó ningún precio, por lo que no hay nada que copiar aquí; selecciona "No" para "Did you pay or send money?" a menos que realmente hayas pagado.', zh:'未输入标价，因此此处无内容可复制——除非您确实付款，否则请为"Did you pay or send money?"选择"No"。', tl:'Walang inilagay na presyo, kaya walang kokopyahin dito — piliin ang "No" para sa "Did you pay or send money?" maliban kung talagang nagbayad ka.', vi:'Không có giá niêm yết nào được nhập, vì vậy không có gì để sao chép ở đây — chọn "No" cho "Did you pay or send money?" trừ khi bạn thực sự đã thanh toán.', ar:'لم يتم إدخال سعر معلن، لذا لا يوجد شيء لنسخه هنا — اختر "No" لسؤال "Did you pay or send money?" ما لم تكن قد دفعت فعليًا.', fr:'Aucun prix affiché n’a été saisi, il n’y a donc rien à copier ici — sélectionnez « No » pour « Did you pay or send money? » sauf si vous avez réellement payé.', ko:'입력된 판매 가격이 없어 복사할 내용이 없습니다 — 실제로 지불한 경우가 아니라면 "Did you pay or send money?"에서 "No"를 선택하세요.', ru:'Цена не была указана, поэтому копировать нечего — выберите «No» для «Did you pay or send money?», если вы действительно не платили.', de:'Es wurde kein Angebotspreis eingegeben, daher gibt es hier nichts zu kopieren — wählen Sie „No" bei „Did you pay or send money?", es sei denn, Sie haben tatsächlich bezahlt.' },
  copyBtnLabel: { en:'Copy', es:'Copiar', zh:'复制', tl:'Kopyahin', vi:'Sao Chép', ar:'نسخ', fr:'Copier', ko:'복사', ru:'Копировать', de:'Kopieren' },
  copyBtnCopiedLabel: { en:'Copied!', es:'¡Copiado!', zh:'已复制！', tl:'Nakopya na!', vi:'Đã Sao Chép!', ar:'تم النسخ!', fr:'Copié !', ko:'복사됨!', ru:'Скопировано!', de:'Kopiert!' },
  copyBtnFailedLabel: { en:'Copy failed — select manually', es:'Error al copiar; selecciona manualmente', zh:'复制失败——请手动选择', tl:'Nabigo ang pagkopya — piliin nang manual', vi:'Sao chép thất bại — vui lòng chọn thủ công', ar:'فشل النسخ — حدد النص يدويًا', fr:'Échec de la copie — sélectionnez manuellement', ko:'복사 실패 — 수동으로 선택하세요', ru:'Не удалось скопировать — выделите вручную', de:'Kopieren fehlgeschlagen — bitte manuell auswählen' },
  sellerListingInfoLabel: { en:'Seller & Listing Info', es:'Información del Vendedor y Anuncio', zh:'卖家与商品信息', tl:'Impormasyon ng Nagbebenta at Listahan', vi:'Thông Tin Người Bán & Sản Phẩm', ar:'معلومات البائع والإعلان', fr:'Infos Vendeur et Annonce', ko:'판매자 및 상품 정보', ru:'Информация о Продавце и Объявлении', de:'Verkäufer- & Angebotsinfo' },
  sellerListingInfoFor: { en:'for: Comments (under "Details about the company or individual")', es:'para: Comentarios (en "Details about the company or individual")', zh:'对应字段：评论（"Details about the company or individual"下）', tl:'para sa: Comments (sa ilalim ng "Details about the company or individual")', vi:'dành cho: Comments (trong mục "Details about the company or individual")', ar:'لحقل: التعليقات (ضمن "Details about the company or individual")', fr:'pour : Commentaires (sous « Details about the company or individual »)', ko:'해당 항목: Comments ("Details about the company or individual" 하위)', ru:'для поля: Comments (в разделе «Details about the company or individual»)', de:'für: Kommentare (unter „Details about the company or individual")' },
  descriptionWhatHappenedLabel: { en:'Description of What Happened', es:'Descripción de lo Sucedido', zh:'事件经过描述', tl:'Paglalarawan ng Nangyari', vi:'Mô Tả Sự Việc Đã Xảy Ra', ar:'وصف ما حدث', fr:'Description des Faits', ko:'사건 경위 설명', ru:'Описание Произошедшего', de:'Beschreibung des Vorfalls' },
  descriptionWhatHappenedFor: { en:'for: "Describe what happened"', es:'para: "Describe what happened"', zh:'对应字段："Describe what happened"', tl:'para sa: "Describe what happened"', vi:'dành cho: "Describe what happened"', ar:'لحقل: "Describe what happened"', fr:'pour : « Describe what happened »', ko:'해당 항목: "Describe what happened"', ru:'для поля: «Describe what happened»', de:'für: „Describe what happened"' },
  charactersWord: { en:'characters', es:'caracteres', zh:'字符', tl:'karakter', vi:'ký tự', ar:'حرفًا', fr:'caractères', ko:'자', ru:'символов', de:'Zeichen' },
  charLimitOverWarning: { en:'over the limit, trim before pasting', es:'supera el límite; recórtalo antes de pegarlo', zh:'超出限制，粘贴前请精简', tl:'lampas sa limitasyon, paikliin bago i-paste', vi:'vượt quá giới hạn, hãy rút gọn trước khi dán', ar:'تجاوز الحد المسموح، اختصره قبل اللصق', fr:'dépasse la limite, à raccourcir avant de coller', ko:'제한 초과, 붙여넣기 전 줄이세요', ru:'превышен лимит, сократите текст перед вставкой', de:'über dem Limit, vor dem Einfügen kürzen' },
  screenshotsToAttachTitle: { en:'Screenshots to Attach', es:'Capturas de Pantalla para Adjuntar', zh:'待附加的截图', tl:'Mga Screenshot na Iaattach', vi:'Ảnh Chụp Màn Hình Cần Đính Kèm', ar:'لقطات الشاشة المرفقة', fr:'Captures d’Écran à Joindre', ko:'첨부할 스크린샷', ru:'Скриншоты для Прикрепления', de:'Anzuhängende Screenshots' },
  noScreenshotsText: { en:'No screenshots were uploaded for this listing. If you have your own, keep them ready to attach if the form supports it.', es:'No se subieron capturas de pantalla para este anuncio. Si tienes las tuyas, tenlas listas para adjuntar si el formulario lo permite.', zh:'此商品未上传截图。如果您有自己的截图，请准备好，以便在表单支持时附加。', tl:'Walang na-upload na screenshot para sa listahang ito. Kung mayroon kang sarili, ihanda ang mga ito para iattach kung sinusuportahan ng form.', vi:'Không có ảnh chụp màn hình nào được tải lên cho sản phẩm này. Nếu bạn có ảnh riêng, hãy chuẩn bị sẵn để đính kèm nếu biểu mẫu hỗ trợ.', ar:'لم يتم رفع أي لقطات شاشة لهذا الإعلان. إذا كانت لديك لقطات خاصة بك، فأبقها جاهزة للإرفاق إذا كان النموذج يدعم ذلك.', fr:'Aucune capture d’écran n’a été téléchargée pour cette annonce. Si vous en avez, gardez-les prêtes à joindre si le formulaire le permet.', ko:'이 상품에 업로드된 스크린샷이 없습니다. 직접 촬영한 스크린샷이 있다면 양식에서 첨부가 가능할 경우를 대비해 준비해두세요.', ru:'Для этого объявления не было загружено скриншотов. Если у вас есть свои, держите их наготове для прикрепления, если форма это поддерживает.', de:'Für dieses Angebot wurden keine Screenshots hochgeladen. Falls Sie eigene haben, halten Sie diese bereit, falls das Formular Anhänge unterstützt.' },
  downloadLinkText: { en:'Download', es:'Descargar', zh:'下载', tl:'I-download', vi:'Tải Xuống', ar:'تنزيل', fr:'Télécharger', ko:'다운로드', ru:'Скачать', de:'Herunterladen' },
  openFtcBtn: { en:'Open ReportFraud.ftc.gov', es:'Abrir ReportFraud.ftc.gov', zh:'打开 ReportFraud.ftc.gov', tl:'Buksan ang ReportFraud.ftc.gov', vi:'Mở ReportFraud.ftc.gov', ar:'فتح ReportFraud.ftc.gov', fr:'Ouvrir ReportFraud.ftc.gov', ko:'ReportFraud.ftc.gov 열기', ru:'Открыть ReportFraud.ftc.gov', de:'ReportFraud.ftc.gov Öffnen' },
  printFullReportBtn: { en:'Print / Save Full Report (PDF)', es:'Imprimir / Guardar Informe Completo (PDF)', zh:'打印/保存完整报告（PDF）', tl:'I-print / I-save ang Buong Ulat (PDF)', vi:'In / Lưu Báo Cáo Đầy Đủ (PDF)', ar:'طباعة / حفظ التقرير الكامل (PDF)', fr:'Imprimer / Enregistrer le Rapport Complet (PDF)', ko:'전체 보고서 인쇄/저장 (PDF)', ru:'Печать / Сохранить Полный Отчёт (PDF)', de:'Vollständigen Bericht Drucken / Speichern (PDF)' },

  // ---------- Helpful Information section ----------
  selectStateTitle: { en:'Select Your State', es:'Selecciona tu Estado', zh:'选择您所在的州', tl:'Piliin ang Iyong Estado', vi:'Chọn Tiểu Bang Của Bạn', ar:'اختر ولايتك', fr:'Sélectionnez Votre État', ko:'주(State) 선택', ru:'Выберите Свой Штат', de:'Wählen Sie Ihren Bundesstaat' },
  selectStateIntro: { en:'Choose your state to get a direct link to its consumer protection office, alongside general guidance below.', es:'Elige tu estado para obtener un enlace directo a su oficina de protección al consumidor, junto con orientación general a continuación.', zh:'选择您所在的州，即可获取该州消费者保护办公室的直接链接，以及下方的通用指导信息。', tl:'Piliin ang iyong estado para makakuha ng direktang link sa consumer protection office nito, kasama ang pangkalahatang gabay sa ibaba.', vi:'Chọn tiểu bang của bạn để nhận liên kết trực tiếp đến văn phòng bảo vệ người tiêu dùng của tiểu bang đó, cùng với hướng dẫn chung bên dưới.', ar:'اختر ولايتك للحصول على رابط مباشر لمكتب حماية المستهلك فيها، إلى جانب الإرشادات العامة أدناه.', fr:'Choisissez votre état pour obtenir un lien direct vers son bureau de protection des consommateurs, ainsi que des conseils généraux ci-dessous.', ko:'주를 선택하면 해당 주의 소비자 보호국으로 바로 연결되는 링크와 아래의 일반 안내를 확인할 수 있습니다.', ru:'Выберите свой штат, чтобы получить прямую ссылку на его управление по защите прав потребителей, а также общие рекомендации ниже.', de:'Wählen Sie Ihren Bundesstaat, um einen direkten Link zu dessen Verbraucherschutzbehörde sowie allgemeine Hinweise unten zu erhalten.' },
  stateSelectDefault: { en:'Select a state…', es:'Selecciona un estado…', zh:'请选择州……', tl:'Pumili ng estado…', vi:'Chọn một tiểu bang…', ar:'اختر ولاية...', fr:'Sélectionnez un état…', ko:'주 선택…', ru:'Выберите штат…', de:'Bundesstaat auswählen…' },
  stateResourceConsumerProtection: { en:'Consumer Protection', es:'Protección al Consumidor', zh:'消费者保护', tl:'Proteksyon sa Konsumer', vi:'Bảo Vệ Người Tiêu Dùng', ar:'حماية المستهلك', fr:'Protection des Consommateurs', ko:'소비자 보호', ru:'Защита Прав Потребителей', de:'Verbraucherschutz' },
  stateResourceIntro: { en:'Every state has an Attorney General’s office that handles consumer complaints and scam reports.', es:'Cada estado tiene una oficina del Procurador General que gestiona quejas de consumidores y reportes de fraude.', zh:'每个州都设有总检察长办公室，负责处理消费者投诉和诈骗举报。', tl:'Bawat estado ay may Attorney General’s office na humahawak ng mga reklamo ng konsumer at ulat ng scam.', vi:'Mỗi tiểu bang đều có văn phòng Tổng Chưởng Lý xử lý khiếu nại của người tiêu dùng và báo cáo lừa đảo.', ar:'يوجد لدى كل ولاية مكتب للمدعي العام يتعامل مع شكاوى المستهلكين وبلاغات الاحتيال.', fr:'Chaque état dispose d’un bureau du procureur général qui traite les plaintes des consommateurs et les signalements de fraude.', ko:'모든 주에는 소비자 불만과 사기 신고를 처리하는 검찰총장(Attorney General) 사무실이 있습니다.', ru:'В каждом штате есть офис генерального прокурора, который рассматривает жалобы потребителей и сообщения о мошенничестве.', de:'Jeder Bundesstaat verfügt über eine Generalstaatsanwaltschaft, die Verbraucherbeschwerden und Betrugsmeldungen bearbeitet.' },
  stateResourceSearchPrefix: { en:'Search for', es:'Buscar', zh:'搜索', tl:'Hanapin ang', vi:'Tìm kiếm', ar:'ابحث عن', fr:'Rechercher', ko:'검색:', ru:'Найти', de:'Suchen nach' },
  stateResourceSearchSuffix: { en:'’s Attorney General consumer protection office', es:': oficina de protección al consumidor del Procurador General', zh:'的总检察长消费者保护办公室', tl:'’s Attorney General consumer protection office', vi:'văn phòng bảo vệ người tiêu dùng của Tổng Chưởng Lý bang', ar:'مكتب حماية المستهلك التابع للمدعي العام لولاية', fr:' bureau de protection des consommateurs du procureur général', ko:'주 검찰총장 소비자 보호국', ru:'офис генерального прокурора штата по защите прав потребителей', de:' Verbraucherschutzbüro der Generalstaatsanwaltschaft' },
  howToSpotTitle: { en:'How to Spot a Counterfeit', es:'Cómo Detectar una Falsificación', zh:'如何识别假货', tl:'Paano Makikilala ang Peke', vi:'Cách Nhận Biết Hàng Giả', ar:'كيفية اكتشاف المنتج المزيف', fr:'Comment Repérer une Contrefaçon', ko:'위조품 식별 방법', ru:'Как Распознать Подделку', de:'So Erkennen Sie Fälschungen' },
  howToSpot1: { en:'Compare the price to the manufacturer’s MSRP — a price that’s dramatically below market value is the single biggest red flag.', es:'Compara el precio con el PVP del fabricante; un precio muy por debajo del valor de mercado es la mayor señal de alerta.', zh:'将价格与制造商的建议零售价进行比较——远低于市场价的价格是最大的危险信号。', tl:'Ihambing ang presyo sa MSRP ng gumagawa — ang presyong malayong mas mababa sa market value ang pinakamalaking red flag.', vi:'So sánh giá với MSRP của nhà sản xuất — giá thấp hơn đáng kể so với giá trị thị trường là dấu hiệu cảnh báo lớn nhất.', ar:'قارن السعر بسعر التجزئة المقترح من الشركة المصنعة — السعر الأقل بشكل كبير من قيمة السوق هو أكبر إشارة تحذير.', fr:'Comparez le prix au PDSF du fabricant — un prix nettement inférieur à la valeur marchande est le signal d’alerte le plus important.', ko:'제조사의 권장 소비자가(MSRP)와 가격을 비교하세요 — 시장 가치보다 현저히 낮은 가격이 가장 큰 위험 신호입니다.', ru:'Сравните цену с рекомендованной розничной ценой производителя — цена значительно ниже рыночной стоимости — самый явный тревожный признак.', de:'Vergleichen Sie den Preis mit der UVP des Herstellers — ein Preis, der deutlich unter dem Marktwert liegt, ist das wichtigste Warnsignal.' },
  howToSpot2: { en:'Check for stock/catalog photos reused across multiple listings, inconsistent lighting, or missing angles of the actual item.', es:'Busca fotos de stock o catálogo reutilizadas en varios anuncios, iluminación inconsistente o falta de ángulos del artículo real.', zh:'留意是否为多个商品重复使用的库存/目录照片、光线不一致，或缺少实物的多角度照片。', tl:'Suriin kung may paulit-ulit na stock/catalog na larawan sa maraming listahan, hindi pare-parehong ilaw, o kulang na anggulo ng aktwal na item.', vi:'Kiểm tra xem có ảnh stock/catalogue được dùng lại ở nhiều sản phẩm, ánh sáng không đồng nhất, hoặc thiếu góc chụp thực tế của sản phẩm hay không.', ar:'تحقق من وجود صور جاهزة (stock) أو من كتالوج مستخدمة في إعلانات متعددة، أو إضاءة غير متسقة، أو نقص في زوايا تصوير المنتج الفعلي.', fr:'Vérifiez la présence de photos de stock/catalogue réutilisées sur plusieurs annonces, un éclairage incohérent ou l’absence de photos sous différents angles de l’article réel.', ko:'여러 상품에서 재사용된 스톡/카탈로그 사진, 일관되지 않은 조명, 실제 상품의 다양한 각도 사진 부재 여부를 확인하세요.', ru:'Проверьте, не используются ли одни и те же стоковые/каталожные фото в разных объявлениях, нет ли несогласованного освещения или недостатка ракурсов реального товара.', de:'Achten Sie auf wiederverwendete Stock-/Katalogfotos in mehreren Angeboten, inkonsistente Beleuchtung oder fehlende Ansichten des tatsächlichen Artikels.' },
  howToSpot3: { en:'Look closely at logos, fonts, stitching, and packaging for spelling errors, blurry printing, or misalignment.', es:'Observa de cerca los logotipos, tipografías, costuras y empaques en busca de errores ortográficos, impresión borrosa o desalineación.', zh:'仔细检查标志、字体、缝线和包装，查看是否有拼写错误、印刷模糊或错位问题。', tl:'Tingnang mabuti ang mga logo, font, tahi, at packaging para sa mga error sa spelling, malabong pag-print, o hindi pagkakahanay.', vi:'Xem kỹ logo, phông chữ, đường may và bao bì để phát hiện lỗi chính tả, in mờ hoặc lệch.', ar:'تفحص الشعارات والخطوط والخياطة والتغليف عن كثب بحثًا عن أخطاء إملائية أو طباعة غير واضحة أو عدم محاذاة.', fr:'Examinez attentivement les logos, polices, coutures et emballages à la recherche de fautes d’orthographe, d’impressions floues ou de désalignements.', ko:'로고, 글꼴, 바느질, 포장 상태를 자세히 살펴보고 철자 오류, 흐릿한 인쇄, 정렬 불량이 있는지 확인하세요.', ru:'Внимательно осмотрите логотипы, шрифты, швы и упаковку на предмет орфографических ошибок, размытой печати или смещения элементов.', de:'Prüfen Sie Logos, Schriftarten, Nähte und Verpackung genau auf Rechtschreibfehler, unscharfen Druck oder Fehlausrichtungen.' },
  howToSpot4: { en:'Check the seller’s account age, review history, and ratings — new accounts with no history are higher risk.', es:'Verifica la antigüedad de la cuenta del vendedor, su historial de reseñas y calificaciones; las cuentas nuevas sin historial son de mayor riesgo.', zh:'检查卖家的账户注册时间、评价历史和评分——没有历史记录的新账户风险更高。', tl:'Suriin ang edad ng account ng nagbebenta, kasaysayan ng review, at rating — mas mataas ang panganib sa mga bagong account na walang kasaysayan.', vi:'Kiểm tra tuổi tài khoản, lịch sử đánh giá và xếp hạng của người bán — tài khoản mới không có lịch sử có rủi ro cao hơn.', ar:'تحقق من عمر حساب البائع وسجل التقييمات والتقييمات العامة — الحسابات الجديدة بلا سجل أكثر خطورة.', fr:'Vérifiez l’ancienneté du compte du vendeur, son historique d’avis et ses évaluations — les nouveaux comptes sans historique présentent un risque plus élevé.', ko:'판매자 계정 개설 기간, 리뷰 이력, 평점을 확인하세요 — 이력이 없는 신규 계정은 위험이 더 높습니다.', ru:'Проверьте возраст аккаунта продавца, историю отзывов и рейтинг — новые аккаунты без истории представляют более высокий риск.', de:'Prüfen Sie das Alter des Verkäuferkontos, die Bewertungshistorie und die Bewertungen — neue Konten ohne Historie bergen ein höheres Risiko.' },
  howToSpot5: { en:'Ask for original packaging, authenticity cards, or serial/batch numbers you can verify with the manufacturer.', es:'Solicita el empaque original, tarjetas de autenticidad o números de serie/lote que puedas verificar con el fabricante.', zh:'索要原厂包装、真品卡或可向制造商核实的序列号/批号。', tl:'Humingi ng orihinal na packaging, authenticity card, o serial/batch number na maaari mong i-verify sa gumagawa.', vi:'Yêu cầu bao bì gốc, thẻ xác thực hoặc số sê-ri/số lô mà bạn có thể xác minh với nhà sản xuất.', ar:'اطلب التغليف الأصلي أو بطاقات إثبات الأصالة أو الأرقام التسلسلية/أرقام الدفعات التي يمكنك التحقق منها لدى الشركة المصنعة.', fr:'Demandez l’emballage d’origine, les cartes d’authenticité ou les numéros de série/lot vérifiables auprès du fabricant.', ko:'제조사를 통해 확인할 수 있는 정품 포장, 정품 인증 카드, 일련번호/배치번호를 요청하세요.', ru:'Запросите оригинальную упаковку, карточки подлинности или серийные/партийные номера, которые можно проверить у производителя.', de:'Fragen Sie nach Originalverpackung, Echtheitskarten oder Serien-/Chargennummern, die Sie beim Hersteller überprüfen können.' },
  avoidingScamsTitle: { en:'Avoiding Online Shopping Scams', es:'Cómo Evitar Fraudes de Compras en Línea', zh:'如何避免网购诈骗', tl:'Pag-iwas sa mga Online Shopping Scam', vi:'Tránh Lừa Đảo Mua Sắm Trực Tuyến', ar:'تجنب عمليات احتيال التسوق عبر الإنترنت', fr:'Éviter les Arnaques d’Achats en Ligne', ko:'온라인 쇼핑 사기 예방하기', ru:'Как Избежать Мошенничества при Онлайн-Покупках', de:'Online-Einkaufsbetrug Vermeiden' },
  avoidingScams1: { en:'Pay by credit card, not wire transfer, cash app, or gift cards — those payment methods offer little to no fraud protection.', es:'Paga con tarjeta de crédito, no por transferencia bancaria, apps de pago o tarjetas de regalo; esos métodos ofrecen poca o ninguna protección contra fraudes.', zh:'请使用信用卡付款，而非电汇、转账应用或礼品卡——这些付款方式几乎没有防欺诈保障。', tl:'Magbayad gamit ang credit card, hindi wire transfer, cash app, o gift card — kaunti o walang proteksyon laban sa scam ang mga paraan ng pagbabayad na ito.', vi:'Thanh toán bằng thẻ tín dụng, không dùng chuyển khoản, ứng dụng thanh toán tiền mặt hoặc thẻ quà tặng — các phương thức này gần như không có bảo vệ chống gian lận.', ar:'ادفع ببطاقة الائتمان، وليس بالحوالة المصرفية أو تطبيقات الدفع النقدي أو بطاقات الهدايا — فهذه الطرق توفر حماية ضئيلة أو معدومة من الاحتيال.', fr:'Payez par carte de crédit, pas par virement, application de paiement ou carte-cadeau — ces moyens de paiement offrent peu ou pas de protection contre la fraude.', ko:'계좌이체, 캐시 앱, 상품권이 아닌 신용카드로 결제하세요 — 이런 결제 수단은 사기 보호가 거의 없습니다.', ru:'Платите кредитной картой, а не банковским переводом, платёжным приложением или подарочными картами — эти способы почти не защищают от мошенничества.', de:'Zahlen Sie per Kreditkarte, nicht per Überweisung, Zahlungs-App oder Geschenkkarte — diese Zahlungsmethoden bieten kaum oder keinen Betrugsschutz.' },
  avoidingScams2: { en:'Be skeptical of urgency tactics ("only 1 left!", "sale ends in 10 minutes") designed to rush your decision.', es:'Desconfía de las tácticas de urgencia ("¡solo queda 1!", "la oferta termina en 10 minutos") diseñadas para apresurar tu decisión.', zh:'对制造紧迫感的手法（如"仅剩1件！""促销10分钟后结束"）保持警惕，这些都是为了促使您仓促决定。', tl:'Maging maingat sa mga taktika ng urgency ("1 na lang natitira!", "matatapos ang sale sa 10 minuto") na idinisenyo para paapurahin ang iyong desisyon.', vi:'Hãy cảnh giác với các chiêu trò tạo cảm giác cấp bách ("chỉ còn 1 sản phẩm!", "khuyến mãi kết thúc sau 10 phút") nhằm thúc ép bạn quyết định nhanh.', ar:'كن حذرًا من أساليب الاستعجال ("تبقّت قطعة واحدة فقط!"، "ينتهي العرض خلال 10 دقائق") المصممة لدفعك لاتخاذ قرار متسرع.', fr:'Méfiez-vous des tactiques d’urgence (« plus qu’un exemplaire ! », « la vente se termine dans 10 minutes ») conçues pour précipiter votre décision.', ko:'"단 1개 남음!", "10분 후 판매 종료"와 같은 긴박감 조성 문구는 성급한 결정을 유도하려는 수법이니 주의하세요.', ru:'Остерегайтесь тактик создания срочности («осталась всего 1 штука!», «акция заканчивается через 10 минут»), призванных поторопить ваше решение.', de:'Seien Sie skeptisch bei Dringlichkeitstaktiken („nur noch 1 Stück!", „Angebot endet in 10 Minuten"), die Ihre Entscheidung beschleunigen sollen.' },
  avoidingScams3: { en:'Verify the site uses HTTPS and has real contact information, a return policy, and verifiable reviews outside its own page.', es:'Verifica que el sitio use HTTPS y tenga información de contacto real, una política de devoluciones y reseñas verificables fuera de su propia página.', zh:'确认网站使用 HTTPS 协议，并提供真实的联系信息、退货政策，以及可在其官网之外核实的评价。', tl:'Tiyakin na gumagamit ng HTTPS ang site at may tunay na impormasyon sa pakikipag-ugnayan, patakaran sa pagsauli, at mapapatunayang review sa labas ng sarili nitong page.', vi:'Xác minh trang web sử dụng HTTPS và có thông tin liên hệ thực, chính sách đổi trả, cùng các đánh giá có thể kiểm chứng bên ngoài trang riêng của họ.', ar:'تحقق من أن الموقع يستخدم HTTPS ولديه معلومات اتصال حقيقية وسياسة إرجاع ومراجعات يمكن التحقق منها خارج صفحته الخاصة.', fr:'Vérifiez que le site utilise le protocole HTTPS et dispose de coordonnées réelles, d’une politique de retour et d’avis vérifiables en dehors de sa propre page.', ko:'사이트가 HTTPS를 사용하는지, 실제 연락처 정보와 반품 정책이 있는지, 자체 페이지 외부에서 확인 가능한 리뷰가 있는지 확인하세요.', ru:'Убедитесь, что сайт использует HTTPS и имеет реальные контактные данные, политику возврата и отзывы, которые можно проверить за пределами самого сайта.', de:'Prüfen Sie, ob die Website HTTPS verwendet und über echte Kontaktinformationen, eine Rückgaberichtlinie und extern überprüfbare Bewertungen verfügt.' },
  avoidingScams4: { en:'If a deal seems too good to be true for a brand-name item, it almost always is.', es:'Si una oferta parece demasiado buena para ser verdad en un artículo de marca, casi siempre lo es.', zh:'如果知名品牌商品的优惠好得令人难以置信，那几乎肯定有问题。', tl:'Kung ang deal ay parang masyadong maganda para totoo para sa isang branded na item, halos palaging ganoon nga.', vi:'Nếu một sản phẩm chính hãng có giá tốt đến khó tin, thì gần như chắc chắn đó là lừa đảo.', ar:'إذا بدا العرض جيدًا لدرجة يصعب تصديقها لمنتج ذي علامة تجارية معروفة، فهو كذلك في الغالب.', fr:'Si une offre semble trop belle pour être vraie pour un article de marque, c’est presque toujours le cas.', ko:'브랜드 제품인데 지나치게 좋은 조건이라면 거의 항상 사기입니다.', ru:'Если предложение по фирменному товару кажется слишком выгодным, чтобы быть правдой, скорее всего, так оно и есть.', de:'Wenn ein Angebot für ein Markenprodukt zu gut klingt, um wahr zu sein, ist es das fast immer auch.' },
  avoidingScams5: { en:'Search the seller’s name or domain plus the word "scam" before purchasing from an unfamiliar store.', es:'Busca el nombre o dominio del vendedor junto con la palabra "estafa" antes de comprar en una tienda desconocida.', zh:'在不熟悉的商店购买前，请搜索卖家名称或域名加上"诈骗"一词。', tl:'Hanapin ang pangalan o domain ng nagbebenta kasama ang salitang "scam" bago bumili sa hindi pamilyar na tindahan.', vi:'Tìm kiếm tên hoặc tên miền của người bán kèm từ "lừa đảo" trước khi mua từ cửa hàng lạ.', ar:'ابحث عن اسم البائع أو نطاقه مع كلمة "احتيال" قبل الشراء من متجر غير مألوف.', fr:'Recherchez le nom ou le domaine du vendeur accompagné du mot « arnaque » avant d’acheter dans une boutique inconnue.', ko:'낯선 쇼핑몰에서 구매하기 전 판매자 이름이나 도메인과 함께 "사기"라는 단어로 검색해보세요.', ru:'Перед покупкой в незнакомом магазине найдите в поиске имя продавца или домен вместе со словом «мошенничество».', de:'Suchen Sie vor dem Kauf in einem unbekannten Shop nach dem Verkäufernamen oder der Domain zusammen mit dem Wort „Betrug".' },
  nationalResourcesTitle: { en:'National Resources', es:'Recursos Nacionales', zh:'全国性资源', tl:'Mga Pambansang Mapagkukunan', vi:'Nguồn Lực Quốc Gia', ar:'الموارد الوطنية', fr:'Ressources Nationales', ko:'전국 단위 자료', ru:'Общенациональные Ресурсы', de:'Landesweite Ressourcen' },
  ftcConsumerAdvice: { en:'FTC Consumer Advice', es:'Consejos al Consumidor de la FTC', zh:'FTC 消费者建议', tl:'Payo sa Konsumer ng FTC', vi:'Tư Vấn Người Tiêu Dùng của FTC', ar:'نصائح المستهلك من FTC', fr:'Conseils aux Consommateurs de la FTC', ko:'FTC 소비자 조언', ru:'Советы Потребителям от FTC', de:'FTC-Verbraucherhinweise' },
  reportFraudToFtc: { en:'Report Fraud to the FTC', es:'Reportar Fraude a la FTC', zh:'向 FTC 举报诈骗', tl:'Mag-ulat ng Scam sa FTC', vi:'Báo Cáo Gian Lận cho FTC', ar:'الإبلاغ عن الاحتيال إلى FTC', fr:'Signaler une Fraude à la FTC', ko:'FTC에 사기 신고하기', ru:'Сообщить о Мошенничестве в FTC', de:'Betrug bei der FTC Melden' },
  fbiIc3: { en:'FBI Internet Crime Complaint Center (IC3)', es:'Centro de Quejas de Delitos en Internet del FBI (IC3)', zh:'联邦调查局网络犯罪投诉中心 (IC3)', tl:'FBI Internet Crime Complaint Center (IC3)', vi:'Trung Tâm Khiếu Nại Tội Phạm Internet của FBI (IC3)', ar:'مركز شكاوى جرائم الإنترنت التابع لمكتب التحقيقات الفيدرالي (IC3)', fr:'Centre de Plaintes pour Crimes Internet du FBI (IC3)', ko:'FBI 인터넷 범죄 신고 센터 (IC3)', ru:'Центр Приёма Жалоб на Интернет-Преступления ФБР (IC3)', de:'FBI-Internetkriminalitäts-Beschwerdestelle (IC3)' },
  bbb: { en:'Better Business Bureau', es:'Better Business Bureau', zh:'商业改进局 (BBB)', tl:'Better Business Bureau', vi:'Better Business Bureau', ar:'مكتب تحسين الأعمال (BBB)', fr:'Better Business Bureau', ko:'BBB(소비자보호협회)', ru:'Better Business Bureau', de:'Better Business Bureau' },
  footerResources: { en:'Educational content only, not legal advice. State links open a web search for that state’s official consumer protection office rather than a hardcoded address, so they stay accurate over time.', es:'Contenido solo educativo, no es asesoría legal. Los enlaces estatales abren una búsqueda web para la oficina oficial de protección al consumidor de ese estado en lugar de una dirección fija, para que se mantengan precisos con el tiempo.', zh:'本内容仅供参考，不构成法律建议。各州链接会打开该州官方消费者保护办公室的网络搜索，而非固定地址，以确保信息长期保持准确。', tl:'Panturo lamang na nilalaman, hindi legal na payo. Ang mga link ng estado ay nagbubukas ng web search para sa opisyal na consumer protection office ng estadong iyon sa halip na naka-hardcode na address, para manatili itong tumpak sa paglipas ng panahon.', vi:'Chỉ mang tính giáo dục, không phải tư vấn pháp lý. Các liên kết tiểu bang sẽ mở tìm kiếm web cho văn phòng bảo vệ người tiêu dùng chính thức của tiểu bang đó thay vì địa chỉ cố định, giúp thông tin luôn chính xác theo thời gian.', ar:'محتوى تعليمي فقط، وليس استشارة قانونية. تفتح روابط الولايات بحثًا على الويب عن مكتب حماية المستهلك الرسمي لتلك الولاية بدلاً من عنوان ثابت، لتبقى دقيقة مع مرور الوقت.', fr:'Contenu à but éducatif uniquement, ne constitue pas un conseil juridique. Les liens des états ouvrent une recherche web vers le bureau officiel de protection des consommateurs de cet état plutôt qu’une adresse fixe, afin de rester exacts dans le temps.', ko:'본 콘텐츠는 교육 목적으로만 제공되며 법률 자문이 아닙니다. 주(State) 링크는 고정된 주소 대신 해당 주의 공식 소비자 보호국을 찾는 웹 검색을 실행하므로 시간이 지나도 정확성을 유지합니다.', ru:'Только образовательный контент, не является юридической консультацией. Ссылки штатов открывают веб-поиск официального управления по защите прав потребителей этого штата, а не фиксированный адрес, поэтому информация остаётся актуальной со временем.', de:'Nur zu Bildungszwecken, keine Rechtsberatung. Die Links der Bundesstaaten öffnen eine Websuche nach der offiziellen Verbraucherschutzbehörde des jeweiligen Staates statt einer festen Adresse, damit sie langfristig aktuell bleiben.' },
  // ---------- Suspicious phrase pattern labels ----------
  patNoReturns: { en:'No returns accepted', es:'No se aceptan devoluciones', zh:'不接受退货', tl:'Walang tinatanggap na pagsauli', vi:'Không chấp nhận trả hàng', ar:'لا يُقبل الإرجاع', fr:'Aucun retour accepté', ko:'반품 불가', ru:'Возврат не принимается', de:'Keine Rückgabe möglich' },
  patNoRefunds: { en:'No refunds', es:'Sin reembolsos', zh:'不予退款', tl:'Walang refund', vi:'Không hoàn tiền', ar:'لا يوجد استرداد للمبلغ', fr:'Aucun remboursement', ko:'환불 불가', ru:'Возврат денег не предусмотрен', de:'Keine Rückerstattung' },
  patCashOnly: { en:'Cash-only / Cash App payment requested', es:'Solo se acepta efectivo / pago por Cash App', zh:'要求仅现金/Cash App付款', tl:'Cash-only / hiniling ang bayad sa Cash App', vi:'Chỉ nhận tiền mặt / yêu cầu thanh toán qua Cash App', ar:'طُلب الدفع نقدًا فقط / عبر تطبيق Cash App', fr:'Paiement en espèces uniquement / via Cash App demandé', ko:'현금 결제만 가능 / Cash App 결제 요청', ru:'Требуется оплата только наличными / через Cash App', de:'Nur Barzahlung / Zahlung über Cash App gefordert' },
  patZelle: { en:'Zelle payment requested', es:'Se solicitó pago por Zelle', zh:'要求Zelle付款', tl:'Hiniling ang bayad sa pamamagitan ng Zelle', vi:'Yêu cầu thanh toán qua Zelle', ar:'طُلب الدفع عبر Zelle', fr:'Paiement via Zelle demandé', ko:'Zelle 결제 요청', ru:'Требуется оплата через Zelle', de:'Zahlung über Zelle gefordert' },
  patAsIs: { en:'"As-is" / no warranty language', es:'Lenguaje de "tal cual" / sin garantía', zh:'"按原样"/无保修字样', tl:'"As-is" / walang warranty na pananalita', vi:'Ngôn từ "nguyên trạng" / không bảo hành', ar:'صيغة "كما هو" / بدون ضمان', fr:'Formulation « tel quel » / sans garantie', ko:'"현 상태 그대로" / 무보증 문구', ru:'Формулировка «как есть» / без гарантии', de:'„Wie besehen"-Formulierung / keine Garantie' },
  patMustSell: { en:'Urgency language ("must sell")', es:'Lenguaje de urgencia ("debo vender")', zh:'紧迫性措辞（"必须出售"）', tl:'Pananalitang nagmamadali ("dapat ibenta")', vi:'Ngôn từ khẩn cấp ("phải bán gấp")', ar:'عبارات استعجال ("يجب البيع")', fr:'Formulation urgente (« doit vendre »)', ko:'긴박감 조성 문구("반드시 팔아야 함")', ru:'Формулировка срочности («должен продать»)', de:'Dringlichkeitsformulierung („muss verkaufen")' },
  patFinalPrice: { en:'Non-negotiable "final price" framing', es:'Enfoque de "precio final" no negociable', zh:'"最终价格"不可议价措辞', tl:'Hindi mababagong "final price" na pananalita', vi:'Cách diễn đạt "giá cuối cùng" không thương lượng', ar:'صياغة "السعر النهائي" غير القابل للتفاوض', fr:'Formulation « prix final » non négociable', ko:'협상 불가 "최종 가격" 표현', ru:'Формулировка «окончательная цена» без торга', de:'Nicht verhandelbare „Festpreis"-Formulierung' },
  pat100Authentic: { en:'Unverifiable "100% authentic" claim', es:'Afirmación no verificable de "100% auténtico"', zh:'无法核实的"100%正品"声明', tl:'Hindi mapapatunayang claim na "100% authentic"', vi:'Tuyên bố "100% chính hãng" không thể kiểm chứng', ar:'ادعاء غير قابل للتحقق بـ "أصلي 100%"', fr:'Affirmation invérifiable « 100 % authentique »', ko:'검증 불가능한 "100% 정품" 주장', ru:'Непроверяемое утверждение «100% оригинал»', de:'Nicht verifizierbare Behauptung „100 % Original"' },
  patTrustMe: { en:'"Trust me" framing', es:'Enfoque de "confía en mí"', zh:'"相信我"式措辞', tl:'"Trust me" na pananalita', vi:'Cách diễn đạt "hãy tin tôi"', ar:'صياغة "ثق بي"', fr:'Formulation « fais-moi confiance »', ko:'"믿어주세요" 표현', ru:'Формулировка «доверьтесь мне»', de:'„Vertrau mir"-Formulierung' },
  patNoQuestions: { en:'"No questions asked" framing', es:'Enfoque de "sin preguntas"', zh:'"不问问题"式措辞', tl:'"No questions asked" na pananalita', vi:'Cách diễn đạt "không hỏi han gì"', ar:'صياغة "دون أسئلة"', fr:'Formulation « sans poser de questions »', ko:'"묻지도 따지지도 않고" 표현', ru:'Формулировка «без вопросов»', de:'„Keine Fragen"-Formulierung' },
  patMovingOut: { en:'Generic urgency / reason-for-sale framing', es:'Enfoque genérico de urgencia / motivo de venta', zh:'通用紧迫性/出售理由措辞', tl:'Pangkalahatang urgency / dahilan sa pagbebenta na pananalita', vi:'Cách diễn đạt khẩn cấp / lý do bán chung chung', ar:'صياغة عامة للاستعجال / سبب البيع', fr:'Formulation générique d’urgence / motif de vente', ko:'일반적인 긴급성/판매 사유 표현', ru:'Общая формулировка срочности / причины продажи', de:'Allgemeine Dringlichkeits-/Verkaufsgrund-Formulierung' },
  patNoInspection: { en:'No pre-purchase inspection allowed', es:'No se permite inspección previa a la compra', zh:'不允许购前检查', tl:'Walang pinapayagang inspeksyon bago bumili', vi:'Không cho phép kiểm tra trước khi mua', ar:'لا يُسمح بالفحص قبل الشراء', fr:'Aucune inspection avant achat autorisée', ko:'구매 전 검수 불가', ru:'Осмотр перед покупкой не допускается', de:'Keine Besichtigung vor dem Kauf erlaubt' },
  patFirmPrice: { en:'Non-negotiable "firm price" framing', es:'Enfoque de "precio firme" no negociable', zh:'"固定价格"不可议价措辞', tl:'Hindi mababagong "firm price" na pananalita', vi:'Cách diễn đạt "giá cố định" không thương lượng', ar:'صياغة "سعر ثابت" غير القابل للتفاوض', fr:'Formulation « prix ferme » non négociable', ko:'협상 불가 "고정 가격" 표현', ru:'Формулировка «твёрдая цена» без торга', de:'Nicht verhandelbare „Festpreis"-Formulierung (fest)' },

  // ---------- Misc shared ----------
  notProvided: { en:'not provided', es:'no proporcionado', zh:'未提供', tl:'hindi ibinigay', vi:'không cung cấp', ar:'غير متوفر', fr:'non fourni', ko:'제공되지 않음', ru:'не указано', de:'nicht angegeben' },
  sellerPrefixLabel: { en:'seller:', es:'vendedor:', zh:'卖家：', tl:'nagbebenta:', vi:'người bán:', ar:'البائع:', fr:'vendeur :', ko:'판매자:', ru:'продавец:', de:'Verkäufer:' },
  untitledEntry: { en:'Untitled Manual Entry', es:'Entrada Manual Sin Título', zh:'未命名的手动录入', tl:'Walang Pamagat na Manual Entry', vi:'Mục Nhập Thủ Công Chưa Đặt Tên', ar:'إدخال يدوي بلا عنوان', fr:'Saisie Manuelle Sans Titre', ko:'제목 없는 수동 입력', ru:'Безымянная Ручная Запись', de:'Unbenannter Manueller Eintrag' },
  batchInvalidPrefixPrefix: { en:'Prefix "', es:'El prefijo "', zh:'前缀"', tl:'Ang prefix na "', vi:'Tiền tố "', ar:'البادئة "', fr:'Le préfixe « ', ko:'접두사 "', ru:'Префикс «', de:'Das Präfix „' },
  batchInvalidPrefixSuffix: { en:'" is not a recognized manufacturer batch prefix in our reference registry.', es:'" no es un prefijo de lote de fabricante reconocido en nuestro registro de referencia.', zh:'"不是我们参考库中可识别的制造商批次前缀。', tl:'" ay hindi kilalang batch prefix ng gumagawa sa aming reference registry.', vi:'" không phải là tiền tố mã lô nhà sản xuất được nhận diện trong cơ sở dữ liệu tham chiếu của chúng tôi.', ar:'" ليست بادئة دفعة معروفة لشركة مصنعة في سجلنا المرجعي.', fr:' » n’est pas un préfixe de lot fabricant reconnu dans notre registre de référence.', ko:'"는 참조 목록에서 인식되는 제조사 배치 접두사가 아닙니다.', ru:'» не является распознанным префиксом партии производителя в нашем справочном реестре.', de:'" ist kein anerkanntes Hersteller-Chargenpräfix in unserem Referenzverzeichnis.' },

  // ---------- Download Audit Report (PDF) ----------
  auditReportSubtitle: { en:'Counterfeit Detection — Audit Report', es:'Detección de Falsificaciones — Informe de Auditoría', zh:'假货检测 —— 审核报告', tl:'Pagtukoy ng Peke — Ulat ng Pag-audit', vi:'Phát Hiện Hàng Giả — Báo Cáo Kiểm Định', ar:'كشف التزييف — تقرير التدقيق', fr:'Détection de Contrefaçon — Rapport d’Audit', ko:'위조품 탐지 — 감사 보고서', ru:'Обнаружение Подделок — Отчёт о Проверке', de:'Fälschungserkennung — Prüfbericht' },
  listingLabel: { en:'Listing', es:'Anuncio', zh:'商品', tl:'Listahan', vi:'Sản Phẩm', ar:'الإعلان', fr:'Annonce', ko:'상품', ru:'Объявление', de:'Angebot' },
  overallRiskLabel: { en:'Overall Risk', es:'Riesgo General', zh:'总体风险', tl:'Pangkalahatang Panganib', vi:'Rủi Ro Tổng Thể', ar:'الخطورة الإجمالية', fr:'Risque Global', ko:'전체 위험도', ru:'Общий Риск', de:'Gesamtrisiko' },
  generatedLabel: { en:'Generated', es:'Generado', zh:'生成时间', tl:'Nilikha', vi:'Được Tạo', ar:'تم الإنشاء', fr:'Généré', ko:'생성됨', ru:'Создано', de:'Erstellt' },
  listedColonLabel: { en:'Listed', es:'Precio de venta', zh:'标价', tl:'Presyo', vi:'Giá niêm yết', ar:'السعر المعلن', fr:'Prix affiché', ko:'판매 가격', ru:'Указанная цена', de:'Angebotspreis' },
  varianceLabel: { en:'Variance', es:'Variación', zh:'差异', tl:'Pagkakaiba', vi:'Chênh lệch', ar:'الفرق', fr:'Écart', ko:'편차', ru:'Отклонение', de:'Abweichung' },

  // ---------- Technical / error messages ----------
  errCouldNotReadFilePrefix: { en:'Could not read file', es:'No se pudo leer el archivo', zh:'无法读取文件', tl:'Hindi mabasa ang file', vi:'Không thể đọc tệp', ar:'تعذّرت قراءة الملف', fr:'Impossible de lire le fichier', ko:'파일을 읽을 수 없습니다:', ru:'Не удалось прочитать файл', de:'Datei konnte nicht gelesen werden' },
  errNetworkUnreachable: { en:'Could not reach the analysis server. Make sure the backend is running (npm start).', es:'No se pudo conectar con el servidor de análisis. Asegúrate de que el backend esté en ejecución (npm start).', zh:'无法连接到分析服务器。请确认后端服务正在运行（npm start）。', tl:'Hindi maabot ang analysis server. Tiyaking tumatakbo ang backend (npm start).', vi:'Không thể kết nối đến máy chủ phân tích. Hãy đảm bảo backend đang chạy (npm start).', ar:'تعذّر الوصول إلى خادم التحليل. تأكد من أن الواجهة الخلفية (backend) قيد التشغيل (npm start).', fr:'Impossible de joindre le serveur d’analyse. Vérifiez que le backend est bien lancé (npm start).', ko:'분석 서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인하세요 (npm start).', ru:'Не удалось подключиться к серверу анализа. Убедитесь, что бэкенд запущен (npm start).', de:'Der Analyseserver konnte nicht erreicht werden. Stellen Sie sicher, dass das Backend läuft (npm start).' },
  errAnalysisRequestFailedPrefix: { en:'Vision/price analysis request failed (HTTP', es:'La solicitud de análisis de visión/precio falló (HTTP', zh:'视觉/价格分析请求失败（HTTP', tl:'Nabigo ang kahilingan sa pagsusuri ng vision/presyo (HTTP', vi:'Yêu cầu phân tích hình ảnh/giá thất bại (HTTP', ar:'فشل طلب تحليل الصورة/السعر (HTTP', fr:'La requête d’analyse image/prix a échoué (HTTP', ko:'비전/가격 분석 요청이 실패했습니다 (HTTP', ru:'Запрос анализа изображения/цены не выполнен (HTTP', de:'Die Bild-/Preisanalyse-Anfrage ist fehlgeschlagen (HTTP' },
  errMaxImagesReachedSuffix: { en:'max {n} images reached', es:'se alcanzó el máximo de {n} imágenes', zh:'已达到最多 {n} 张图片的上限', tl:'naabot na ang max na {n} na larawan', vi:'đã đạt tối đa {n} ảnh', ar:'تم الوصول إلى الحد الأقصى وهو {n} صور', fr:'nombre maximal de {n} images atteint', ko:'최대 {n}장까지 업로드 가능합니다', ru:'достигнут максимум — {n} изображений', de:'Maximum von {n} Bildern erreicht' },
  errUnsupportedFileType: { en:'unsupported file type', es:'tipo de archivo no admitido', zh:'不支持的文件类型', tl:'hindi suportadong uri ng file', vi:'định dạng tệp không được hỗ trợ', ar:'نوع ملف غير مدعوم', fr:'type de fichier non pris en charge', ko:'지원되지 않는 파일 형식', ru:'неподдерживаемый тип файла', de:'nicht unterstützter Dateityp' },
  errFileTooLarge: { en:'exceeds 8MB', es:'supera los 8 MB', zh:'超过8MB', tl:'lumampas sa 8MB', vi:'vượt quá 8MB', ar:'يتجاوز 8 ميغابايت', fr:'dépasse 8 Mo', ko:'8MB 초과', ru:'превышает 8 МБ', de:'überschreitet 8 MB' },
  errSomethingWentWrong: { en:'Something went wrong while analyzing this listing.', es:'Algo salió mal al analizar este anuncio.', zh:'分析此商品时出现问题。', tl:'May nagkamali habang sinusuri ang listahang ito.', vi:'Đã xảy ra lỗi khi phân tích sản phẩm này.', ar:'حدث خطأ ما أثناء تحليل هذا الإعلان.', fr:'Une erreur s’est produite lors de l’analyse de cette annonce.', ko:'이 상품을 분석하는 중 문제가 발생했습니다.', ru:'При анализе этого объявления произошла ошибка.', de:'Bei der Analyse dieses Angebots ist ein Fehler aufgetreten.' },
};
TRANSLATIONS.subtitleDetection = TRANSLATIONS.tabDetection;

let currentLanguage = 'en';
try{
  const savedLang = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if(savedLang && LANGUAGES.some(l => l.code === savedLang)) currentLanguage = savedLang;
} catch(err){ /* localStorage unavailable — fall back to English */ }

function t(key){
  const entry = TRANSLATIONS[key];
  if(!entry) return '';
  return entry[currentLanguage] || entry.en;
}

function renderLanguageOptions(){
  document.getElementById('languageList').innerHTML = LANGUAGES.map(lang => `
    <button data-lang="${lang.code}" class="language-option w-full flex items-center justify-between gap-3 rounded-lg border ${lang.code === currentLanguage ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-slate-800 hover:border-slate-700 hover:bg-slate-900/60'} px-3 py-2.5 transition text-left">
      <span>
        <span class="text-sm font-medium text-slate-100">${escapeHtml(lang.native)}</span>
        <span class="text-xs text-slate-500 ml-1.5">${lang.native === lang.english ? '' : escapeHtml(lang.english)}</span>
      </span>
      ${lang.code === currentLanguage ? `<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-cyan-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>` : ''}
    </button>
  `).join('');
  document.querySelectorAll('.language-option').forEach(btn => {
    btn.addEventListener('click', () => applyLanguage(btn.dataset.lang));
  });
}

function applyTranslations(){
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.getElementById('headerSubtitle').textContent = activeSection === 'detection' ? t('subtitleDetection') : t('subtitleResources');
}

function applyLanguage(code){
  currentLanguage = code;
  try{ localStorage.setItem(LANGUAGE_STORAGE_KEY, code); } catch(err){ /* ignore */ }
  document.documentElement.lang = code;

  applyTranslations();
  renderLanguageOptions();
  renderHistoryList();

  // Re-render any dynamic content already on screen so it reflects the new
  // language immediately, not just on the next analysis.
  if(currentReport && !document.getElementById('resultsSection').classList.contains('hidden')){
    renderResults(currentReport, currentBatchResult);
  }
  if(!document.getElementById('notifPanel').classList.contains('hidden')){
    renderNotifList();
  }
}

function openSettingsModal(){
  renderLanguageOptions();
  document.getElementById('settingsOverlay').classList.remove('hidden');
  document.getElementById('settingsModal').classList.remove('hidden');
}
function closeSettingsModal(){
  document.getElementById('settingsOverlay').classList.add('hidden');
  document.getElementById('settingsModal').classList.add('hidden');
}

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsModal);
document.getElementById('settingsOverlay').addEventListener('click', closeSettingsModal);

setActiveSection('detection');
applyLanguage(currentLanguage);

/* ---------------------------------------------------------
   Helpful Information — state resource selector
--------------------------------------------------------- */
const US_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri',
  'Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York',
  'North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island',
  'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington',
  'West Virginia','Wisconsin','Wyoming'
];

const stateSelectEl = document.getElementById('stateSelect');
US_STATES.forEach(state => {
  const opt = document.createElement('option');
  opt.value = state;
  opt.textContent = state;
  stateSelectEl.appendChild(opt);
});

stateSelectEl.addEventListener('change', () => {
  const state = stateSelectEl.value;
  const card = document.getElementById('stateResourceCard');
  if(!state){
    card.classList.add('hidden');
    return;
  }
  document.getElementById('stateResourceName').textContent = state;
  document.getElementById('stateResourceNameInline').textContent = state;
  const query = encodeURIComponent(`${state} Attorney General consumer protection office`);
  document.getElementById('stateResourceLink').href = `https://www.google.com/search?q=${query}`;
  card.classList.remove('hidden');
});

/* ---------------------------------------------------------
   Federal alerts / notifications (illustrative demo feed)
--------------------------------------------------------- */
const NOTIFICATIONS_SEEN_KEY = 'marketplaceguardian_notifications_seen_v1';

const FEDERAL_NOTIFICATIONS = [
  { id: 'n1', agency: 'FTC', date: '2026-07-28', title: 'Consumer Alert: Fake Online Storefronts Mimicking Major Retailers', body: 'The FTC warns shoppers to verify seller identity and domain age before buying from unfamiliar "discount" storefronts found via social media ads.' },
  { id: 'n2', agency: 'CPSC', date: '2026-07-22', title: 'Recall Advisory: Counterfeit Phone Chargers Linked to Fire Risk', body: 'Uncertified counterfeit chargers sold under knock-off branding have been linked to overheating incidents. Verify UL/ETL certification before use.' },
  { id: 'n3', agency: 'FBI IC3', date: '2026-07-15', title: 'Advisory: Rise in Non-Delivery and Non-Payment Scams', body: 'The Internet Crime Complaint Center reports a seasonal increase in online shopping scams where payment is collected but goods are never shipped.' },
  { id: 'n4', agency: 'USPIS', date: '2026-07-09', title: 'Warning: Fraudulent Package Delivery Text Scams', body: 'The U.S. Postal Inspection Service is tracking a wave of smishing texts impersonating carriers to harvest payment details via fake redelivery fees.' },
  { id: 'n5', agency: 'FTC', date: '2026-06-30', title: 'Reminder: Report Counterfeit Goods Directly to the FTC', body: 'The FTC\'s ReportFraud tool now includes a dedicated category for counterfeit and knock-off merchandise complaints.' },
];

function loadSeenNotificationIds(){
  try{
    const raw = localStorage.getItem(NOTIFICATIONS_SEEN_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch(err){
    return new Set();
  }
}

function renderNotifBadge(){
  const seen = loadSeenNotificationIds();
  const unread = FEDERAL_NOTIFICATIONS.filter(n => !seen.has(n.id)).length;
  const badge = document.getElementById('notifBadge');
  badge.textContent = String(unread);
  badge.classList.toggle('hidden', unread === 0);
}

function renderNotifList(){
  document.getElementById('notifList').innerHTML = FEDERAL_NOTIFICATIONS.map(n => `
    <div class="rounded-lg border border-slate-800 p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[10px] font-bold uppercase tracking-wide text-cyan-400">${escapeHtml(n.agency)}</span>
        <span class="text-[10px] text-slate-500">${new Date(n.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      </div>
      <p class="text-xs font-semibold text-slate-200 mt-1.5">${escapeHtml(n.title)}</p>
      <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">${escapeHtml(n.body)}</p>
    </div>
  `).join('');
}

function openNotifPanel(){
  renderNotifList();
  document.getElementById('notifPanel').classList.remove('hidden');
  try{
    localStorage.setItem(NOTIFICATIONS_SEEN_KEY, JSON.stringify(FEDERAL_NOTIFICATIONS.map(n => n.id)));
  } catch(err){ console.warn('Could not persist notification read state:', err); }
  renderNotifBadge();
}
function closeNotifPanel(){
  document.getElementById('notifPanel').classList.add('hidden');
}

document.getElementById('notifBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('notifPanel');
  panel.classList.contains('hidden') ? openNotifPanel() : closeNotifPanel();
});
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  if(!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target.id !== 'notifBtn' && !document.getElementById('notifBtn').contains(e.target)){
    closeNotifPanel();
  }
});

renderNotifBadge();

/* ---------------------------------------------------------
   Image upload / dropzone
--------------------------------------------------------- */
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
let uploadedImages = [];
let imageIdSeq = 0;

function renderImageThumbs(){
  const grid = document.getElementById('imageThumbGrid');
  grid.innerHTML = uploadedImages.map(img => `
    <div class="relative">
      <img src="${img.previewUrl}" class="w-full h-20 object-cover rounded-lg border border-slate-700" alt="${img.file.name}">
      <button type="button" data-remove-id="${img.id}" class="remove-image-btn absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-900 border border-slate-600 text-slate-300 hover:text-red-400 hover:border-red-400 flex items-center justify-center text-xs leading-none">✕</button>
    </div>
  `).join('');
  grid.classList.toggle('hidden', uploadedImages.length === 0);
  grid.querySelectorAll('.remove-image-btn').forEach(btn => {
    btn.addEventListener('click', () => removeImage(Number(btn.dataset.removeId)));
  });
}

function addImageFiles(fileList){
  const errEl = document.getElementById('imageError');
  const rejected = [];
  for(const file of Array.from(fileList)){
    if(uploadedImages.length >= MAX_IMAGES){
      rejected.push(`${file.name}: ${t('errMaxImagesReachedSuffix').replace('{n}', MAX_IMAGES)}`);
      continue;
    }
    if(!ALLOWED_IMAGE_TYPES.includes(file.type)){
      rejected.push(`${file.name}: ${t('errUnsupportedFileType')}`);
      continue;
    }
    if(file.size > MAX_IMAGE_BYTES){
      rejected.push(`${file.name}: ${t('errFileTooLarge')}`);
      continue;
    }
    uploadedImages.push({ id: ++imageIdSeq, file, previewUrl: URL.createObjectURL(file) });
  }
  errEl.classList.toggle('hidden', rejected.length === 0);
  if(rejected.length) errEl.textContent = rejected.join(' · ');
  renderImageThumbs();
}

function removeImage(id){
  const idx = uploadedImages.findIndex(img => img.id === id);
  if(idx === -1) return;
  URL.revokeObjectURL(uploadedImages[idx].previewUrl);
  uploadedImages.splice(idx, 1);
  renderImageThumbs();
}

function clearImages(){
  uploadedImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
  uploadedImages = [];
  renderImageThumbs();
  document.getElementById('imageError').classList.add('hidden');
}

const imageDropzone = document.getElementById('imageDropzone');
const imageFileInput = document.getElementById('imageFileInput');
imageDropzone.addEventListener('click', () => imageFileInput.click());
imageFileInput.addEventListener('change', (e) => {
  addImageFiles(e.target.files);
  imageFileInput.value = '';
});
['dragover', 'dragenter'].forEach(evt => imageDropzone.addEventListener(evt, (e) => {
  e.preventDefault();
  imageDropzone.classList.add('border-cyan-500', 'bg-cyan-500/5');
}));
['dragleave', 'drop'].forEach(evt => imageDropzone.addEventListener(evt, (e) => {
  e.preventDefault();
  imageDropzone.classList.remove('border-cyan-500', 'bg-cyan-500/5');
}));
imageDropzone.addEventListener('drop', (e) => {
  if(e.dataTransfer.files.length) addImageFiles(e.dataTransfer.files);
});

/* ---------------------------------------------------------
   Main flow
--------------------------------------------------------- */
async function runAnalysisFlow({ buildReport, btnId, errElId }){
  const btn = document.getElementById(btnId);
  const errEl = document.getElementById(errElId);
  const batchRaw = document.getElementById('batchInput').value;
  const batchResult = validateBatchCode(batchRaw);

  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('scanningSection').classList.remove('hidden');
  document.getElementById('scanningSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  btn.disabled = true;
  btn.classList.add('opacity-60');

  const scanAnimDone = new Promise(resolve => runScanAnimation(!!batchResult, resolve));

  try {
    const [report] = await Promise.all([Promise.resolve().then(buildReport), scanAnimDone]);
    document.getElementById('scanningSection').classList.add('hidden');
    renderResults(report, batchResult);
    saveToHistory(report, batchResult);
  } catch(err){
    await scanAnimDone.catch(() => {});
    document.getElementById('scanningSection').classList.add('hidden');
    errEl.textContent = err.message || t('errSomethingWentWrong');
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.classList.remove('opacity-60');
  }
}

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('manualError');
  errEl.classList.add('hidden');

  const title = document.getElementById('manualTitle').value.trim();
  const seller = document.getElementById('manualSeller').value.trim();
  const listingUrl = document.getElementById('manualListingUrl').value.trim();
  const description = document.getElementById('manualDescription').value.trim();
  const listedCurrency = document.getElementById('manualCurrency').value;
  const listedRaw = document.getElementById('manualListedPrice').value.trim();

  if(!title && !description && uploadedImages.length === 0){
    errEl.textContent = t('analyzeMinInputError');
    errEl.classList.remove('hidden');
    return;
  }

  let listedAmount = null;
  if(listedRaw){
    listedAmount = parseFloat(listedRaw);
    if(isNaN(listedAmount) || listedAmount < 0){
      errEl.textContent = t('listedPriceInvalidError');
      errEl.classList.remove('hidden');
      return;
    }
  }

  const imagesSnapshot = uploadedImages.slice();

  await runAnalysisFlow({
    btnId: 'analyzeBtn', errElId: 'manualError',
    buildReport: async () => {
      const images = await Promise.all(imagesSnapshot.map(async img => ({
        name: img.file.name,
        mimeType: img.file.type,
        dataBase64: await fileToBase64(img.file),
        previewUrl: img.previewUrl,
      })));
      return buildManualReport({ title, seller, description, listedAmount, listedCurrency, images, listingUrl });
    }
  });
});

document.getElementById('resetBtn').addEventListener('click', () => {
  document.getElementById('resultsSection').classList.add('hidden');
  document.getElementById('batchInput').value = '';
  document.getElementById('manualTitle').value = '';
  document.getElementById('manualSeller').value = '';
  document.getElementById('manualListingUrl').value = '';
  document.getElementById('manualDescription').value = '';
  document.getElementById('manualListedPrice').value = '';
  clearImages();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------------------------------------------------------
   Official complaint template (high-risk listings only)
--------------------------------------------------------- */
// English-only, same reasoning as buildWhatHappenedText: this document is meant
// for filing with a US federal agency, independent of the app's UI language.
function printComplaintTemplate(){
  if(!currentReport || currentReport.status !== 'high') return;
  const savedLang = currentLanguage;
  currentLanguage = 'en';
  try{
  const r = currentReport;
  const now = new Date().toLocaleString();

  const priceDisplay = priceBlockDisplay(r.price);
  const textDisplay = textBlockDisplay(r.text);
  const imageDisplay = imageBlockDisplay(r.image);
  const summaryText = summaryForStatus(r.status);

  const listedStr = r.price && r.price.listed !== undefined ? formatMoney(r.price.listed, r.price.listedCurrency || 'USD') : 'Not provided';
  const msrpStr = r.price && r.price.msrp !== undefined ? formatMoney(r.price.msrp, r.price.listedCurrency || 'USD') : 'Not available';

  const concernBlock = (label, block) => block ? `
    <div style="margin-top:8px;"><span style="font-weight:700;">${escapeHtml(label)}:</span> ${escapeHtml(block.detail || '')}</div>
    ${block.flags && block.flags.length ? `<div style="margin-top:4px;">${block.flags.map(f => `&bull; ${escapeHtml(f)}<br>`).join('')}</div>` : ''}
  ` : '';

  const batchRow = currentBatchResult ? `
    <tr>
      <td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;width:200px;">Batch / Serial Code</td>
      <td style="padding:8px 12px;border:1px solid #ccc;">${escapeHtml(currentBatchResult.code)} — ${currentBatchResult.valid ? 'Valid format' : 'Flagged: ' + escapeHtml(batchReasonText(currentBatchResult))}</td>
    </tr>` : '';

  const imagesHtml = (r.image && r.image.images && r.image.images.length)
    ? r.image.images.map(img => `<img src="${img.dataBase64 || img.previewUrl}" style="width:96px;height:96px;object-fit:cover;border:1px solid #ccc;border-radius:4px;margin:0 6px 6px 0;">`).join('')
    : '<em>No screenshots were uploaded for this listing.</em>';

  document.getElementById('printArea').innerHTML = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:800px;margin:0 auto;">
      <div style="border-bottom:3px solid #b91c1c;padding-bottom:12px;margin-bottom:16px;">
        <div style="font-size:20px;font-weight:800;">Official Complaint Template</div>
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#b91c1c;font-weight:700;">High-Risk Counterfeit / Deceptive Listing</div>
        <div style="font-size:11px;color:#555;margin-top:4px;">Drafted by MarketplaceGuardian on ${now}</div>
      </div>

      <div style="background:#fff8e1;border:1px solid #f0c36d;border-radius:6px;padding:10px 12px;font-size:11px;color:#7a5c00;margin-bottom:16px;">
        This is an auto-generated draft based on your analysis inputs — it is not an official government form and has not been filed anywhere. Review every field, fill in your own contact details below, then submit it yourself through the agencies listed at the bottom.
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:0;">
        <tr><td colspan="2" style="padding:8px 12px;background:#111;color:#fff;font-weight:700;font-size:12px;">1. Your Contact Information (fill in before submitting)</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;width:200px;">Full Name</td><td style="padding:8px 12px;border:1px solid #ccc;">&nbsp;</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Email Address</td><td style="padding:8px 12px;border:1px solid #ccc;">&nbsp;</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Phone Number</td><td style="padding:8px 12px;border:1px solid #ccc;">&nbsp;</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Mailing Address</td><td style="padding:8px 12px;border:1px solid #ccc;">&nbsp;</td></tr>

        <tr><td colspan="2" style="padding:8px 12px;background:#111;color:#fff;font-weight:700;font-size:12px;">2. Listing &amp; Seller Information</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Product / Listing Title</td><td style="padding:8px 12px;border:1px solid #ccc;">${escapeHtml(r.title || 'Not provided')}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Seller Username</td><td style="padding:8px 12px;border:1px solid #ccc;">${escapeHtml(r.sellerRaw || 'Not provided')}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Listing URL</td><td style="padding:8px 12px;border:1px solid #ccc;word-break:break-all;">${r.listingUrl ? escapeHtml(r.listingUrl) : 'Not provided'}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">Listed Price</td><td style="padding:8px 12px;border:1px solid #ccc;">${listedStr}</td></tr>
        <tr><td style="padding:8px 12px;border:1px solid #ccc;font-weight:600;">AI-Estimated Retail (MSRP)</td><td style="padding:8px 12px;border:1px solid #ccc;">${msrpStr}</td></tr>
        ${batchRow}

        <tr><td colspan="2" style="padding:8px 12px;background:#111;color:#fff;font-weight:700;font-size:12px;">3. Summary of Concerns — Overall Risk Score: ${r.riskScore}% (High)</td></tr>
        <tr><td colspan="2" style="padding:10px 12px;border:1px solid #ccc;font-size:12px;">
          <div>${escapeHtml(summaryText || '')}</div>
          ${concernBlock('Price', priceDisplay)}
          ${concernBlock('Listing text', textDisplay)}
          ${concernBlock('Photos', imageDisplay)}
        </td></tr>

        <tr><td colspan="2" style="padding:8px 12px;background:#111;color:#fff;font-weight:700;font-size:12px;">4. Supporting Evidence — Uploaded Screenshots</td></tr>
        <tr><td colspan="2" style="padding:10px 12px;border:1px solid #ccc;font-size:12px;">${imagesHtml}</td></tr>
      </table>

      <div style="background:#eef6ff;border:1px solid #bcd9f7;border-radius:6px;padding:12px;font-size:12px;color:#1a3d63;margin-top:16px;">
        <div style="font-weight:700;margin-bottom:6px;">Where to file this complaint</div>
        <div>• Federal Trade Commission — reportfraud.ftc.gov (online shopping fraud &amp; counterfeit goods)</div>
        <div>• FBI Internet Crime Complaint Center — ic3.gov (if the seller/payment was conducted entirely online)</div>
        <div>• Your state Attorney General's consumer protection office — see the "Helpful Information" tab in this app to find yours</div>
      </div>

      <div style="font-size:10px;color:#777;border-top:1px solid #ccc;padding-top:10px;margin-top:16px;">
        Generated by MarketplaceGuardian from your analysis inputs. Not affiliated with, endorsed by, or submitted to the FTC, FBI, or any government agency.
      </div>
    </div>
  `;

  window.print();
  } finally {
    currentLanguage = savedLang;
  }
}

/* ---------------------------------------------------------
   Complaint walkthrough modal — copy-friendly, FTC-field-mapped
--------------------------------------------------------- */
async function copyToClipboard(text, btn){
  const original = btn.textContent;
  try{
    await navigator.clipboard.writeText(text);
    btn.textContent = t('copyBtnCopiedLabel');
  } catch(err){
    console.warn('Clipboard copy failed:', err);
    btn.textContent = t('copyBtnFailedLabel');
  }
  setTimeout(() => { btn.textContent = original; }, 1600);
}

/**
 * This narrative is pasted into ReportFraud.ftc.gov's English-language form,
 * so it's always composed in English regardless of the UI's current language
 * — translating it would make the pasted text unusable on the actual site.
 */
function buildWhatHappenedText(r, batchResult){
  const savedLang = currentLanguage;
  currentLanguage = 'en';
  try{
    const cur = (r.price && r.price.listedCurrency) || 'USD';
    const priceDisplay = priceBlockDisplay(r.price);
    const textDisplay = textBlockDisplay(r.text);
    const imageDisplay = imageBlockDisplay(r.image);
    const lines = [];
    lines.push(`I purchased or was considering purchasing "${r.title || 'this item'}"${r.sellerRaw ? ` from seller "${r.sellerRaw}"` : ''}${r.price && r.price.listed !== undefined ? ` for ${formatMoney(r.price.listed, cur)}` : ''}.`);
    lines.push(`MarketplaceGuardian's automated listing analysis flagged this as HIGH RISK (${r.riskScore}%) for likely counterfeit or deceptive activity, based on:`);
    if(priceDisplay.detail) lines.push(`- Price: ${priceDisplay.detail}`);
    if(textDisplay.detail) lines.push(`- Listing text: ${textDisplay.detail}${textDisplay.flags && textDisplay.flags.length ? ' Specific phrases: ' + textDisplay.flags.join('; ') : ''}`);
    if(imageDisplay.detail) lines.push(`- Photos: ${imageDisplay.detail}${imageDisplay.flags && imageDisplay.flags.length ? ' Specific findings: ' + imageDisplay.flags.join('; ') : ''}`);
    if(batchResult) lines.push(`- Batch/serial code "${batchResult.code}" was ${batchResult.valid ? 'checked and matches standard format' : 'flagged: ' + batchReasonText(batchResult)}`);
    if(r.listingUrl) lines.push(`Listing URL: ${r.listingUrl}`);
    return lines.join('\n');
  } finally {
    currentLanguage = savedLang;
  }
}

// Intentionally always English, same reason as buildWhatHappenedText above.
function buildSellerInfoText(r){
  return [
    `Seller/business username: ${r.sellerRaw || 'Not provided'}`,
    `Listing URL: ${r.listingUrl || 'Not provided'}`,
    `Product listed: ${r.title || 'Not provided'}`,
  ].join('\n');
}

function copyBlockHtml({ id, label, forField }){
  return `
    <div>
      <div class="flex items-center justify-between gap-2 mb-1">
        <label class="text-xs font-semibold text-slate-200">${escapeHtml(label)}</label>
        <span class="text-[10px] text-slate-500">${escapeHtml(forField)}</span>
      </div>
      <textarea id="${id}" readonly rows="3" class="w-full bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 mono resize-none focus:outline-none"></textarea>
      <button data-copy-for="${id}" class="copy-block-btn mt-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300">${escapeHtml(t('copyBtnLabel'))}</button>
    </div>`;
}

function renderComplaintDataBlocks(){
  const r = currentReport;
  const batchResult = currentBatchResult;
  const cur = (r.price && r.price.listedCurrency) || 'USD';

  const amountValue = r.price && r.price.listed !== undefined ? r.price.listed.toFixed(2) : '';
  const amountNote = r.price && r.price.listed !== undefined
    ? (cur !== 'USD' ? `${t('amountNoteCurrencyPrefix')} ${cur}${t('amountNoteCurrencySuffix')}` : '')
    : t('amountNoteNoPrice');

  const whatHappened = buildWhatHappenedText(r, batchResult);
  const sellerInfo = buildSellerInfoText(r);
  const charCount = whatHappened.length;
  const charWarning = charCount > 3500
    ? `<span class="text-red-400 font-semibold">${charCount} / 3500 ${t('charactersWord')} — ${t('charLimitOverWarning')}</span>`
    : `<span>${charCount} / 3500 ${t('charactersWord')}</span>`;

  const images = (r.image && r.image.images) || [];
  const imagesHtml = images.length
    ? `<div class="grid grid-cols-3 sm:grid-cols-4 gap-2">${images.map((img, i) => `
        <div class="space-y-1">
          <img src="${img.dataBase64 || img.previewUrl}" class="w-full h-20 object-cover rounded-lg border border-slate-700" alt="${escapeHtml(img.name || 'screenshot')}">
          <a href="${img.dataBase64 || img.previewUrl}" download="marketplaceguardian-screenshot-${i + 1}.png" class="block text-center text-[10px] font-semibold text-cyan-400 hover:text-cyan-300">${escapeHtml(t('downloadLinkText'))}</a>
        </div>`).join('')}</div>`
    : `<p class="text-xs text-slate-500">${escapeHtml(t('noScreenshotsText'))}</p>`;

  document.getElementById('complaintDataBlocks').innerHTML = `
    <div>
      <h3 class="text-xs font-semibold text-slate-200 uppercase tracking-wide mb-2">${escapeHtml(t('copyReadyDataTitle'))}</h3>
      <div class="space-y-4">
        <div>
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="text-xs font-semibold text-slate-200">${escapeHtml(t('amountPaidLabel'))}</label>
            <span class="text-[10px] text-slate-500">${escapeHtml(t('amountPaidFor'))}</span>
          </div>
          <textarea id="copyAmount" readonly rows="1" class="w-full bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 mono resize-none focus:outline-none">${escapeHtml(amountValue)}</textarea>
          ${amountNote ? `<p class="text-[11px] text-slate-500 mt-1">${escapeHtml(amountNote)}</p>` : ''}
          ${amountValue ? `<button data-copy-for="copyAmount" class="copy-block-btn mt-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300">${escapeHtml(t('copyBtnLabel'))}</button>` : ''}
        </div>
        ${copyBlockHtml({ id: 'copySellerInfo', label: t('sellerListingInfoLabel'), forField: t('sellerListingInfoFor') })}
        <div>
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="text-xs font-semibold text-slate-200">${escapeHtml(t('descriptionWhatHappenedLabel'))}</label>
            <span class="text-[10px] text-slate-500">${escapeHtml(t('descriptionWhatHappenedFor'))}</span>
          </div>
          <textarea id="copyWhatHappened" readonly rows="6" class="w-full bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 mono resize-none focus:outline-none"></textarea>
          <div class="flex items-center justify-between mt-1">
            <button data-copy-for="copyWhatHappened" class="copy-block-btn text-xs font-semibold text-cyan-400 hover:text-cyan-300">${escapeHtml(t('copyBtnLabel'))}</button>
            <span class="text-[10px] text-slate-500">${charWarning}</span>
          </div>
        </div>
      </div>
    </div>
    <div>
      <h3 class="text-xs font-semibold text-slate-200 uppercase tracking-wide mb-2">${escapeHtml(t('screenshotsToAttachTitle'))}</h3>
      ${imagesHtml}
    </div>
  `;

  // Assign via .value (never via innerHTML) so listing/seller-entered text can never be interpreted as markup.
  document.getElementById('copySellerInfo').value = sellerInfo;
  document.getElementById('copyWhatHappened').value = whatHappened;

  document.querySelectorAll('.copy-block-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = document.getElementById(btn.dataset.copyFor);
      copyToClipboard(field.value, btn);
    });
  });
}

function openComplaintModal(){
  if(!currentReport || currentReport.status !== 'high') return;
  document.getElementById('complaintStepsCheckedDate').textContent = new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  renderComplaintDataBlocks();
  document.getElementById('complaintOverlay').classList.remove('hidden');
  document.getElementById('complaintModal').classList.remove('hidden');
}
function closeComplaintModal(){
  document.getElementById('complaintOverlay').classList.add('hidden');
  document.getElementById('complaintModal').classList.add('hidden');
}

document.getElementById('complaintBtn').addEventListener('click', openComplaintModal);
document.getElementById('complaintCloseBtn').addEventListener('click', closeComplaintModal);
document.getElementById('complaintOverlay').addEventListener('click', closeComplaintModal);
document.getElementById('complaintPrintBtn').addEventListener('click', printComplaintTemplate);

/* ---------------------------------------------------------
   Download / print audit report
--------------------------------------------------------- */
document.getElementById('downloadBtn').addEventListener('click', () => {
  if(!currentReport) return;
  const r = currentReport;
  const now = new Date().toLocaleString();

  const imageDisplay = imageBlockDisplay(r.image);
  const textDisplay = textBlockDisplay(r.text);
  const priceDisplay = priceBlockDisplay(r.price);

  function row(label, block){
    return `
      <tr>
        <td style="padding:10px 12px;border:1px solid #ccc;font-weight:600;width:160px;vertical-align:top;">${label}</td>
        <td style="padding:10px 12px;border:1px solid #ccc;">
          <div style="font-weight:700;">${escapeHtml(block.label)} — <span style="text-transform:uppercase;font-size:11px;">${escapeHtml(verdictWord(block.verdict))}</span></div>
          <div style="font-size:12px;color:#333;margin-top:4px;">${escapeHtml(block.detail)}</div>
          ${block.flags && block.flags.length ? `<div style="margin-top:6px;font-size:12px;">${block.flags.map(f=>`&bull; ${escapeHtml(f)}<br>`).join('')}</div>` : ''}
          ${block.listed !== undefined ? `<div style="margin-top:6px;font-size:12px;">${escapeHtml(t('listedColonLabel'))}: ${formatMoney(block.listed, block.listedCurrency || 'USD')}${block.msrp !== undefined ? ` &nbsp;|&nbsp; ${escapeHtml(t('estRetailLabel'))}: ${formatMoney(block.msrp, block.listedCurrency || 'USD')} &nbsp;|&nbsp; ${escapeHtml(t('varianceLabel'))}: ${block.diffPct}%` : ''}</div>` : ''}
          ${block.images && block.images.length ? `<div style="margin-top:8px;">${block.images.map(img=>`<img src="${img.dataBase64 || img.previewUrl}" style="width:64px;height:64px;object-fit:cover;border:1px solid #ccc;border-radius:4px;margin-right:6px;">`).join('')}</div>` : ''}
        </td>
      </tr>`;
  }

  const batchRow = currentBatchResult ? `
    <tr>
      <td style="padding:10px 12px;border:1px solid #ccc;font-weight:600;vertical-align:top;">${escapeHtml(t('batchCodeCheckTitle'))}</td>
      <td style="padding:10px 12px;border:1px solid #ccc;">
        <div style="font-weight:700;">${escapeHtml(currentBatchResult.code)} — ${currentBatchResult.valid ? escapeHtml(t('validLabel')) : escapeHtml(t('flaggedLabel'))}</div>
        <div style="font-size:12px;color:#333;margin-top:4px;">${escapeHtml(batchReasonText(currentBatchResult))}</div>
      </td>
    </tr>` : '';

  const reportHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:800px;margin:0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #111;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <div style="font-size:20px;font-weight:800;">MarketplaceGuardian</div>
          <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555;">${escapeHtml(t('auditReportSubtitle'))}</div>
        </div>
        <div style="text-align:right;font-size:11px;color:#555;">${escapeHtml(t('generatedLabel'))}: ${now}</div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #ccc;font-weight:600;width:160px;">${escapeHtml(t('listingLabel'))}</td>
          <td style="padding:10px 12px;border:1px solid #ccc;">
            <div style="font-weight:700;">${escapeHtml(r.title || t('untitledEntry'))}</div>
            <div style="font-size:12px;color:#555;">${escapeHtml(t('sellerPrefixLabel'))} ${escapeHtml(r.sellerRaw || t('notProvided'))}</div>
            ${r.listingUrl ? `<div style="font-size:12px;color:#555;word-break:break-all;">${escapeHtml(r.listingUrl)}</div>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #ccc;font-weight:600;">${escapeHtml(t('overallRiskLabel'))}</td>
          <td style="padding:10px 12px;border:1px solid #ccc;">
            <div style="font-size:16px;font-weight:800;">${r.riskScore}% — ${escapeHtml(statusLabel(r.status))}</div>
            <div style="font-size:12px;color:#555;margin-top:4px;">${escapeHtml(summaryForStatus(r.status))}</div>
          </td>
        </tr>
        ${row(escapeHtml(t('imageIntegrityTitle')), imageDisplay)}
        ${row(escapeHtml(t('textDescriptionTitle')), textDisplay)}
        ${row(escapeHtml(t('priceVarianceTitle')), priceDisplay)}
        ${batchRow}
      </table>

      <div style="font-size:10px;color:#777;border-top:1px solid #ccc;padding-top:10px;">
        ${escapeHtml(t('footerDetection'))}
      </div>
    </div>
  `;

  if(IS_EXTENSION_POPUP){
    // window.print() doesn't work from an extension popup: the print dialog
    // steals focus, and popups close as soon as they lose focus, so the
    // popup is torn down before the dialog can render. Download a
    // standalone HTML report instead — a real file save works fine here.
    const standaloneHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(t('auditReportSubtitle'))}</title></head><body>${reportHtml}</body></html>`;
    const blob = new Blob([standaloneHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const safeTitle = (r.title || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'listing';
    const link = document.createElement('a');
    link.href = url;
    link.download = `marketplaceguardian-audit-${safeTitle}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else {
    document.getElementById('printArea').innerHTML = reportHtml;
    window.print();
  }
});
