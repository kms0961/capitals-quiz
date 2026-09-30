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
function readAndDownscale(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
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
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handlePhotoFile(file) {
  if (!file) return;
  const dataUrl = await readAndDownscale(file);
  currentPhotoDataUrl = dataUrl;
  els.previewImg.src = dataUrl;
  els.previewWrap.classList.add("show");
  runOCR(dataUrl);
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
    applyParsedFields(parseInvoiceText(data.text || ""));
    setOcrStatus("Scan complete — check the fields below.", true);
    setTimeout(() => setOcrStatus("", false), 2500);
  } catch (err) {
    console.error("OCR failed", err);
    setOcrStatus("Scan failed — enter details manually.", true);
    setTimeout(() => setOcrStatus("", false), 3000);
  }
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

function parseInvoiceText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = { vendor: "", invDate: "", invoice: "", amount: "", po: "" };

  // Vendor — first substantive line, or a match against known vendors
  const known = getKnownVendors();
  const lower = text.toLowerCase();
  const knownHit = known.find((v) => v && lower.includes(v.toLowerCase()));
  if (knownHit) {
    result.vendor = knownHit;
  } else {
    const candidate = lines.find((l) => l.length >= 2 && !/^\d+$/.test(l) && !parseDateToken(l));
    if (candidate) result.vendor = candidate.slice(0, 60);
  }

  // Invoice date — prefer a line mentioning "invoice date", else first date found
  let dateLine = lines.find((l) => /invoice\s*date/i.test(l));
  result.invDate = (dateLine && parseDateToken(dateLine)) || parseDateToken(text) || "";

  // Invoice number
  let invLine = lines.find((l) => /\b(invoice|inv)\b[^0-9a-z]{0,4}(#|no\.?|number)/i.test(l));
  if (invLine) {
    const m = invLine.match(/(?:invoice|inv)[^0-9a-z]{0,6}(?:#|no\.?|number)?\s*[:#]?\s*([A-Za-z0-9\-]{3,})/i);
    if (m) result.invoice = m[1];
  }

  // PO number
  let poLine = lines.find((l) => /\bp\.?o\.?\b/i.test(l));
  if (poLine) {
    const m = poLine.match(/p\.?o\.?\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Za-z0-9\-]{3,})/i);
    if (m) result.po = m[1];
  }

  // Amount — prefer a "total/balance/amount due" line, else the largest dollar figure
  const amountLine = lines.find((l) =>
    /(total|balance\s+due|amount\s+due|grand\s+total)/i.test(l) && /\d/.test(l)
  );
  const moneyRe = /-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}/g;
  function bestFrom(str) {
    const matches = str.match(moneyRe);
    if (!matches) return null;
    const nums = matches.map((s) => parseFloat(s.replace(/[\$,\s]/g, "")));
    return nums.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), nums[0]);
  }
  result.amount = (amountLine && bestFrom(amountLine)) ?? bestFrom(text) ?? "";

  return result;
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
