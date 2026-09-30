"use strict";

/* ---------------------------------------------------------------------
   Storage — IndexedDB (photos are too big for localStorage)
--------------------------------------------------------------------- */
const DB_NAME = "invoiceTrackerDB";
const STORE = "invoices";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------------------
   DOM refs
--------------------------------------------------------------------- */
const els = {
  entryCount: document.getElementById("entryCount"),
  formHeading: document.getElementById("formHeading"),
  takePhotoBtn: document.getElementById("takePhotoBtn"),
  choosePhotoBtn: document.getElementById("choosePhotoBtn"),
  photoInput: document.getElementById("photoInput"),
  libraryInput: document.getElementById("libraryInput"),
  previewWrap: document.getElementById("previewWrap"),
  previewImg: document.getElementById("previewImg"),
  ocrStatus: document.getElementById("ocrStatus"),
  ocrStatusText: document.getElementById("ocrStatusText"),
  ocrRawDetails: document.getElementById("ocrRawDetails"),
  ocrRawText: document.getElementById("ocrRawText"),
  form: document.getElementById("invoiceForm"),
  fVendor: document.getElementById("fVendor"),
  fInvDate: document.getElementById("fInvDate"),
  fReceived: document.getElementById("fReceived"),
  fInvoice: document.getElementById("fInvoice"),
  fAmount: document.getElementById("fAmount"),
  fPO: document.getElementById("fPO"),
  fMethod: document.getElementById("fMethod"),
  vendorList: document.getElementById("vendorList"),
  saveBtn: document.getElementById("saveBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportXlsxBtn: document.getElementById("exportXlsxBtn"),
  list: document.getElementById("list"),
  toast: document.getElementById("toast"),
};

let currentPhotoDataUrl = null;
let editingId = null;
let allInvoices = [];

/* ---------------------------------------------------------------------
   Toast
--------------------------------------------------------------------- */
let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2400);
}

/* ---------------------------------------------------------------------
   Photo capture + downscale
--------------------------------------------------------------------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function drawScaled(img, maxDim) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas;
}

// Smaller JPEG copy — what actually gets stored with the record.
function toStorageDataUrl(img, maxDim = 1600, quality = 0.82) {
  return drawScaled(img, maxDim).toDataURL("image/jpeg", quality);
}

// Larger grayscale + contrast-stretched copy — feeds the OCR pass only,
// never stored. Phone photos are usually lower-contrast than a scan, and
// Tesseract reads high-contrast black-on-white text far more reliably.
function toOcrDataUrl(img, maxDim = 2200) {
  const canvas = drawScaled(img, maxDim);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = imageData.data;

  let min = 255, max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = gray;
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) {
    const stretched = ((px[i] - min) / range) * 255;
    px[i] = px[i + 1] = px[i + 2] = stretched;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function handlePhotoFile(file) {
  if (!file) return;
  const img = await loadImage(file);
  currentPhotoDataUrl = toStorageDataUrl(img);
  els.previewImg.src = currentPhotoDataUrl;
  els.previewWrap.classList.add("show");
  runOCR(toOcrDataUrl(img));
}

els.takePhotoBtn.addEventListener("click", () => els.photoInput.click());
els.choosePhotoBtn.addEventListener("click", () => els.libraryInput.click());
els.photoInput.addEventListener("change", (e) => handlePhotoFile(e.target.files[0]));
els.libraryInput.addEventListener("change", (e) => handlePhotoFile(e.target.files[0]));

/* ---------------------------------------------------------------------
   OCR + field parsing
--------------------------------------------------------------------- */
function setOcrStatus(text, show) {
  els.ocrStatusText.textContent = text;
  els.ocrStatus.classList.toggle("show", !!show);
}

async function runOCR(dataUrl) {
  if (typeof Tesseract === "undefined") {
    setOcrStatus("Scanner unavailable offline — enter details manually.", true);
    setTimeout(() => setOcrStatus("", false), 3000);
    return;
  }
  setOcrStatus("Scanning…", true);
  try {
    const { data } = await Tesseract.recognize(dataUrl, "eng");
    showRawOcrText(data.text || "");
    applyParsedFields(parseInvoiceText(data.text || ""));
    setOcrStatus("Scan complete — check the fields below.", true);
    setTimeout(() => setOcrStatus("", false), 2500);
  } catch (err) {
    console.error("OCR failed", err);
    setOcrStatus("Scan failed — enter details manually.", true);
    setTimeout(() => setOcrStatus("", false), 3000);
  }
}

function showRawOcrText(text) {
  if (!els.ocrRawDetails) return;
  const trimmed = text.trim();
  if (!trimmed) {
    els.ocrRawDetails.style.display = "none";
    return;
  }
  els.ocrRawText.textContent = trimmed;
  els.ocrRawDetails.style.display = "";
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

function parseDateToken(raw) {
  if (!raw) return null;
  let m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [, mo, day, yr] = m;
    if (yr.length === 2) yr = (Number(yr) < 50 ? "20" : "19") + yr;
    return toISODate(Number(yr), Number(mo), Number(day));
  }
  const re = new RegExp(`(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i");
  m = raw.match(re);
  if (m) {
    const monthIdx = MONTHS.split("|").indexOf(m[1].toLowerCase().slice(0, 3));
    return toISODate(Number(m[3]), monthIdx + 1, Number(m[2]));
  }
  return null;
}

function toISODate(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Header/label words that show up on nearly every invoice template — never
// good vendor guesses, but OCR happily hands them back as "the first line".
const VENDOR_BLACKLIST = new Set([
  "invoice", "invoice date", "invoice number", "invoice #", "invoice no",
  "bill to", "ship to", "remit to", "sold to", "pay to",
  "statement", "receipt", "estimate", "quote", "quotation",
  "purchase order", "order", "order number", "order #",
  "customer", "customer id", "account", "account number",
  "description", "date", "due date", "page", "terms", "net 30",
  "subtotal", "total", "tax", "balance due", "amount due", "thank you",
]);

function guessVendor(lines) {
  const known = getKnownVendors();
  const joinedLower = lines.join(" ").toLowerCase();
  const knownHit = known.find((v) => v && joinedLower.includes(v.toLowerCase()));
  if (knownHit) return knownHit;

  for (const raw of lines.slice(0, 12)) {
    const l = raw.trim();
    if (l.length < 2) continue;
    const stripped = l.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (!stripped || VENDOR_BLACKLIST.has(stripped)) continue;
    if (/^\d+$/.test(l)) continue;
    if (parseDateToken(l)) continue;
    if (!/[a-zA-Z]{2,}/.test(l)) continue;
    return l.slice(0, 60);
  }
  return "";
}

function guessDate(flatText) {
  const idx = flatText.search(/invoice\s*date/i);
  if (idx >= 0) {
    const found = parseDateToken(flatText.slice(idx, idx + 40));
    if (found) return found;
  }
  return parseDateToken(flatText) || "";
}

// Pull every match of `valueRe` out of `str` as plain strings.
function matchAll(str, valueRe) {
  const out = [];
  const re = new RegExp(valueRe, valueRe.flags.includes("g") ? valueRe.flags : valueRe.flags + "g");
  let m;
  while ((m = re.exec(str))) out.push(m);
  return out;
}

function guessInvoiceNumber(flatText) {
  const skip = new Set(["date", "number", "no", "page", "total", "due"]);
  const matches = matchAll(
    flatText,
    /\b(?:invoice|inv)\.?\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})/i
  );
  for (const m of matches) {
    const token = m[1];
    if (skip.has(token.toLowerCase()) || !/\d/.test(token)) continue;
    return token;
  }
  return "";
}

function guessPO(flatText) {
  const matches = matchAll(
    flatText,
    /\bp\.?o\.?\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-]{2,})/i
  );
  for (const m of matches) {
    const token = m[1];
    if (!/\d/.test(token)) continue; // filters out "PO Box <city>"-style false hits
    return token;
  }
  return "";
}

const MONEY_RE = /-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}/g;
const TOTAL_KEYWORDS_RE = /(invoice\s+total|grand\s+total|balance\s+due|amount\s+due|total\s+due|please\s+pay|pay\s+this\s+amount|total)/gi;

function allMoney(str) {
  const matches = str.match(MONEY_RE);
  if (!matches) return [];
  return matches.map((s) => parseFloat(s.replace(/[\$,\s]/g, "")));
}

function largestAbs(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), nums[0]);
}

function guessAmount(flatText) {
  const candidates = [];
  let km;
  const kre = new RegExp(TOTAL_KEYWORDS_RE);
  while ((km = kre.exec(flatText))) {
    candidates.push(...allMoney(flatText.slice(km.index, km.index + 80)));
  }
  return largestAbs(candidates) ?? largestAbs(allMoney(flatText)) ?? "";
}

function parseInvoiceText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Collapse to single-spaced text so a label and its value that landed on
  // different OCR lines (common with invoice tables) still read as adjacent.
  const flatText = text.replace(/\s+/g, " ").trim();

  return {
    vendor: guessVendor(lines),
    invDate: guessDate(flatText),
    invoice: guessInvoiceNumber(flatText),
    amount: guessAmount(flatText),
    po: guessPO(flatText),
  };
}

function applyParsedFields(parsed) {
  if (parsed.vendor && !els.fVendor.value) els.fVendor.value = parsed.vendor;
  if (parsed.invDate) els.fInvDate.value = parsed.invDate;
  if (parsed.invoice && !els.fInvoice.value) els.fInvoice.value = parsed.invoice;
  if (parsed.amount !== "" && !els.fAmount.value) els.fAmount.value = parsed.amount;
  if (parsed.po && !els.fPO.value) els.fPO.value = parsed.po;
}

function getKnownVendors() {
  const set = new Set(allInvoices.map((r) => r.vendor).filter(Boolean));
  return Array.from(set);
}

/* ---------------------------------------------------------------------
   Form — save / edit / reset
--------------------------------------------------------------------- */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resetForm() {
  editingId = null;
  currentPhotoDataUrl = null;
  els.form.reset();
  els.fReceived.value = todayISO();
  els.previewWrap.classList.remove("show");
  els.previewImg.src = "";
  els.ocrRawDetails.style.display = "none";
  els.formHeading.textContent = "New Invoice";
  els.saveBtn.textContent = "Save Invoice";
  els.cancelEditBtn.style.display = "none";
}

els.cancelEditBtn.addEventListener("click", resetForm);

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const record = {
    id: editingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    vendor: els.fVendor.value.trim(),
    invDate: els.fInvDate.value,
    invoice: els.fInvoice.value.trim(),
    amount: els.fAmount.value ? parseFloat(els.fAmount.value) : "",
    po: els.fPO.value.trim(),
    received: els.fReceived.value || todayISO(),
    method: els.fMethod.value.trim(),
    photo: currentPhotoDataUrl,
    createdAt: editingId
      ? (allInvoices.find((r) => r.id === editingId) || {}).createdAt || Date.now()
      : Date.now(),
  };

  if (!record.vendor && !record.amount) {
    showToast("Add at least a vendor or amount before saving.");
    return;
  }

  await dbPut(record);
  showToast(editingId ? "Invoice updated." : "Invoice saved.");
  resetForm();
  await refreshList();
});

/* ---------------------------------------------------------------------
   List render + edit/delete
--------------------------------------------------------------------- */
function money(n) {
  if (n === "" || n === null || n === undefined || isNaN(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function displayDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

function renderList() {
  const sorted = [...allInvoices].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  els.entryCount.textContent = `${sorted.length} saved`;

  if (sorted.length === 0) {
    els.list.innerHTML = '<p class="empty">No invoices saved yet.</p>';
    return;
  }

  els.list.innerHTML = "";
  sorted.forEach((r) => {
    const row = document.createElement("div");
    row.className = "entry";
    row.dataset.id = r.id;

    const img = document.createElement("img");
    img.src = r.photo || "";
    img.alt = "";

    const meta = document.createElement("div");
    meta.className = "meta";
    const vendor = document.createElement("div");
    vendor.className = "vendor";
    vendor.textContent = r.vendor || "(no vendor)";
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = [displayDate(r.invDate), r.invoice].filter(Boolean).join(" · ");
    meta.appendChild(vendor);
    meta.appendChild(sub);

    const amount = document.createElement("div");
    amount.className = "amount" + (typeof r.amount === "number" && r.amount < 0 ? " negative" : "");
    amount.textContent = money(r.amount);

    row.appendChild(img);
    row.appendChild(meta);
    row.appendChild(amount);
    row.addEventListener("click", () => openEntry(r));

    els.list.appendChild(row);
  });
}

function openEntry(r) {
  editingId = r.id;
  currentPhotoDataUrl = r.photo || null;
  els.fVendor.value = r.vendor || "";
  els.fInvDate.value = r.invDate || "";
  els.fReceived.value = r.received || "";
  els.fInvoice.value = r.invoice || "";
  els.fAmount.value = r.amount === "" || r.amount === undefined ? "" : r.amount;
  els.fPO.value = r.po || "";
  els.fMethod.value = r.method || "";

  if (r.photo) {
    els.previewImg.src = r.photo;
    els.previewWrap.classList.add("show");
  } else {
    els.previewWrap.classList.remove("show");
  }
  els.ocrRawDetails.style.display = "none";

  els.formHeading.textContent = "Edit Invoice";
  els.saveBtn.textContent = "Update Invoice";
  els.cancelEditBtn.style.display = "";

  els.formHeading.scrollIntoView({ behavior: "smooth", block: "start" });
  ensureDeleteButton(r.id);
}

function ensureDeleteButton(id) {
  let btn = document.getElementById("deleteEntryBtn");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "deleteEntryBtn";
    btn.className = "btn btn-danger";
    btn.textContent = "Delete this invoice";
    els.form.querySelector(".form-actions").appendChild(btn);
  }
  btn.onclick = async () => {
    if (!confirm("Delete this invoice? This can't be undone.")) return;
    await dbDelete(id);
    showToast("Invoice deleted.");
    resetForm();
    await refreshList();
  };
}

async function refreshList() {
  allInvoices = await dbGetAll();
  renderList();
  updateVendorList();
}

function updateVendorList() {
  els.vendorList.innerHTML = "";
  getKnownVendors().forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    els.vendorList.appendChild(opt);
  });
}

/* ---------------------------------------------------------------------
   Export — CSV + XLSX, matching the Track sheet's column order
--------------------------------------------------------------------- */
const EXPORT_HEADERS = [
  "Vendor", "Inv Date", "Invoice", "Amount", "PO",
  "Received", "Method", "To Purchaser", "From Purchaser", "QB Entry",
];

function buildExportRows() {
  const sorted = [...allInvoices].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return sorted.map((r) => [
    r.vendor || "",
    displayDate(r.invDate),
    r.invoice || "",
    r.amount === "" || r.amount === undefined ? "" : r.amount,
    r.po || "",
    displayDate(r.received),
    r.method || "",
    "", "", "",
  ]);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

els.exportCsvBtn.addEventListener("click", () => {
  if (allInvoices.length === 0) return showToast("Nothing to export yet.");
  const rows = [EXPORT_HEADERS, ...buildExportRows()];
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  downloadBlob(new Blob([csv], { type: "text/csv" }), `invoices-${todayISO()}.csv`);
});

els.exportXlsxBtn.addEventListener("click", () => {
  if (allInvoices.length === 0) return showToast("Nothing to export yet.");
  if (typeof XLSX === "undefined") return showToast("Excel export needs an internet connection once, then works offline.");
  const rows = [EXPORT_HEADERS, ...buildExportRows()];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Track");
  XLSX.writeFile(wb, `invoices-${todayISO()}.xlsx`);
});

/* ---------------------------------------------------------------------
   Init
--------------------------------------------------------------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

resetForm();
refreshList();
