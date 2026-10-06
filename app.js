// Background Remover — everything runs client-side.
// AI segmentation: @imgly/background-removal (loaded lazily from a CDN on first use).

const LIB_URL = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
const MAX_SIDE = 3000; // larger images are downscaled to keep memory reasonable
const MAX_HISTORY = 15;

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  canvasWrap: $("canvasWrap"),
  view: $("view"),
  splitHandle: $("splitHandle"),
  brushCursor: $("brushCursor"),
  busy: $("busy"),
  busyText: $("busyText"),
  busyProgress: $("busyProgress"),
  controls: $("controls"),
  model: $("model"),
  aiBtn: $("aiBtn"),
  brushSize: $("brushSize"),
  brushSizeOut: $("brushSizeOut"),
  brushSoft: $("brushSoft"),
  brushSoftOut: $("brushSoftOut"),
  tolerance: $("tolerance"),
  toleranceOut: $("toleranceOut"),
  contiguous: $("contiguous"),
  undoBtn: $("undoBtn"),
  redoBtn: $("redoBtn"),
  resetBtn: $("resetBtn"),
  swatches: $("swatches"),
  customColor: $("customColor"),
  bgImageInput: $("bgImageInput"),
  compare: $("compare"),
  format: $("format"),
  trim: $("trim"),
  downloadBtn: $("downloadBtn"),
  copyBtn: $("copyBtn"),
  newBtn: $("newBtn"),
  status: $("status"),
};
const viewCtx = els.view.getContext("2d");

const state = {
  name: "image",
  w: 0,
  h: 0,
  original: null, // canvas holding the source image
  pixels: null, // Uint8ClampedArray RGBA of the source image
  mask: null, // Uint8ClampedArray, one alpha value per pixel
  result: null, // canvas: source RGB + mask alpha
  resultCtx: null,
  resultData: null, // ImageData backing `result`
  history: [],
  historyIndex: -1,
  tool: "none",
  bg: { type: "transparent", value: null },
  split: 0.5,
  busy: false,
};

let bgLib = null;

// ---------- status / busy ----------

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

function setBusy(on, text = "Working…", progress = null) {
  state.busy = on;
  els.busy.hidden = !on;
  els.busyText.textContent = text;
  if (progress == null) els.busyProgress.removeAttribute("value");
  else els.busyProgress.value = progress;
}

// ---------- loading images ----------

async function loadImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("That file doesn't look like an image.", true);
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    setStatus("Couldn't read that image. Try a PNG, JPG or WebP.", true);
    return;
  }

  let w = bitmap.width;
  let h = bitmap.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);

  const original = document.createElement("canvas");
  original.width = w;
  original.height = h;
  const octx = original.getContext("2d", { willReadFrequently: true });
  octx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  state.name = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
  state.w = w;
  state.h = h;
  state.original = original;
  state.pixels = octx.getImageData(0, 0, w, h).data;
  state.mask = new Uint8ClampedArray(w * h).fill(255);

  state.result = document.createElement("canvas");
  state.result.width = w;
  state.result.height = h;
  state.resultCtx = state.result.getContext("2d");
  state.resultData = new ImageData(new Uint8ClampedArray(state.pixels), w, h);

  els.view.width = w;
  els.view.height = h;

  state.history = [];
  state.historyIndex = -1;
  commit();
  refreshResult();

  els.dropzone.hidden = true;
  els.canvasWrap.hidden = false;
  els.controls.disabled = false;
  updateUndoButtons();
  render();
  setStatus(
    scale < 1
      ? `Loaded (downscaled to ${w}×${h}). Click “Remove background” to start.`
      : `Loaded ${w}×${h}. Click “Remove background” to start.`
  );
}

function resetToDropzone() {
  state.original = null;
  state.mask = null;
  els.canvasWrap.hidden = true;
  els.dropzone.hidden = false;
  els.controls.disabled = true;
  els.compare.checked = false;
  els.splitHandle.hidden = true;
  els.fileInput.value = "";
  setStatus("");
}

// ---------- mask → result ----------

function refreshResult(x0 = 0, y0 = 0, x1 = state.w, y1 = state.h) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(state.w, Math.ceil(x1));
  y1 = Math.min(state.h, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const { w, mask, pixels } = state;
  const out = state.resultData.data;
  for (let y = y0; y < y1; y++) {
    let i = y * w + x0;
    for (let x = x0; x < x1; x++, i++) {
      // combine with the source alpha so already-transparent PNGs stay transparent
      out[i * 4 + 3] = (pixels[i * 4 + 3] * mask[i]) / 255;
    }
  }
  state.resultCtx.putImageData(state.resultData, 0, 0, x0, y0, x1 - x0, y1 - y0);
}

// ---------- rendering ----------

let bgImage = null;

function drawBackground(ctx, w, h, forExport = false) {
  const { bg } = state;
  if (bg.type === "color") {
    ctx.fillStyle = bg.value;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.type === "image" && bgImage) {
    // cover-fit
    const s = Math.max(w / bgImage.width, h / bgImage.height);
    const dw = bgImage.width * s;
    const dh = bgImage.height * s;
    ctx.drawImage(bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else if (forExport && els.format.value === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
}

function render() {
  if (!state.original) return;
  const { w, h } = state;
  viewCtx.clearRect(0, 0, w, h);
  drawBackground(viewCtx, w, h);
  viewCtx.drawImage(state.result, 0, 0);
  if (els.compare.checked) {
    const sx = Math.round(state.split * w);
    viewCtx.save();
    viewCtx.beginPath();
    viewCtx.rect(0, 0, sx, h);
    viewCtx.clip();
    viewCtx.clearRect(0, 0, sx, h);
    viewCtx.drawImage(state.original, 0, 0);
    viewCtx.restore();
  }
  positionSplitHandle();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function positionSplitHandle() {
  const show = els.compare.checked && !!state.original;
  els.splitHandle.hidden = !show;
  if (!show) return;
  const r = els.view.getBoundingClientRect();
  const wr = els.canvasWrap.getBoundingClientRect();
  els.splitHandle.style.left = `${r.left - wr.left + state.split * r.width}px`;
  els.splitHandle.style.top = `${r.top - wr.top}px`;
  els.splitHandle.style.height = `${r.height}px`;
  els.splitHandle.style.bottom = "auto";
}

window.addEventListener("resize", positionSplitHandle);

// ---------- history ----------

function commit() {
  state.history.splice(state.historyIndex + 1);
  state.history.push(new Uint8ClampedArray(state.mask));
  if (state.history.length > MAX_HISTORY) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateUndoButtons();
}

function restoreHistory(index) {
  if (index < 0 || index >= state.history.length) return;
  state.historyIndex = index;
  state.mask.set(state.history[index]);
  refreshResult();
  render();
  updateUndoButtons();
}

function undo() { restoreHistory(state.historyIndex - 1); }
function redo() { restoreHistory(state.historyIndex + 1); }

function updateUndoButtons() {
  els.undoBtn.disabled = state.historyIndex <= 0;
  els.redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// ---------- AI removal ----------

async function loadLib() {
  if (!bgLib) bgLib = await import(LIB_URL);
  return bgLib;
}

function describeProgress(key) {
  if (key.startsWith("fetch")) return "Downloading AI model (first time only)…";
  if (key.startsWith("compute")) return "Finding the subject…";
  return "Working…";
}

async function runAI() {
  if (!state.original || state.busy) return;
  setBusy(true, "Loading AI engine…");
  setStatus("");
  try {
    const { removeBackground } = await loadLib();
    const input = await new Promise((res) => state.original.toBlob(res, "image/png"));
    const blob = await removeBackground(input, {
      model: els.model.value,
      output: { format: "image/png", quality: 1 },
      progress: (key, current, total) => {
        setBusy(true, describeProgress(key), total ? current / total : null);
      },
    });
    setBusy(true, "Applying…");
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = state.w;
    c.height = state.h;
    const cctx = c.getContext("2d", { willReadFrequently: true });
    cctx.drawImage(bmp, 0, 0, state.w, state.h);
    bmp.close?.();
    const data = cctx.getImageData(0, 0, state.w, state.h).data;
    for (let i = 0; i < state.mask.length; i++) state.mask[i] = data[i * 4 + 3];
    commit();
    refreshResult();
    render();
    setStatus("Done! Use Erase / Restore to touch up edges, then download.");
  } catch (err) {
    console.error(err);
    setStatus(
      `AI removal failed: ${err?.message || err}. Check your connection, or try the 🪄 Color tool instead.`,
      true
    );
  } finally {
    setBusy(false);
  }
}

// ---------- tools ----------

function setTool(tool) {
  state.tool = tool;
  for (const b of document.querySelectorAll(".tool")) {
    b.classList.toggle("active", b.dataset.tool === tool);
  }
  els.canvasWrap.className = `canvas-wrap tool-${tool}`;
  for (const f of document.querySelectorAll("[data-for]")) {
    const forTool = f.dataset.for;
    f.hidden =
      (forTool === "brush" && tool !== "erase" && tool !== "restore") ||
      (forTool === "wand" && tool !== "wand");
  }
  if (tool !== "erase" && tool !== "restore") els.brushCursor.hidden = true;
}

function toImageCoords(e) {
  const r = els.view.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * state.w,
    y: ((e.clientY - r.top) / r.height) * state.h,
    scale: state.w / r.width,
  };
}

// Brush: stamp a soft circle into the mask. Erase lowers alpha, restore raises it.
function stamp(cx, cy, radius, erase) {
  const soft = els.brushSoft.value / 100;
  const inner = radius * (1 - soft);
  const { w, h, mask } = state;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(w, Math.ceil(cx + radius));
  const y1 = Math.min(h, Math.ceil(cy + radius));
  const r2 = radius * radius;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const s = d <= inner ? 1 : 1 - (d - inner) / (radius - inner);
      const i = y * w + x;
      if (erase) {
        const v = 255 * (1 - s);
        if (mask[i] > v) mask[i] = v;
      } else {
        const v = 255 * s;
        if (mask[i] < v) mask[i] = v;
      }
    }
  }
  return [x0, y0, x1, y1];
}

let stroke = null;

function strokeTo(p) {
  const erase = state.tool === "erase";
  const radius = Math.max(0.5, (els.brushSize.value / 2) * p.scale);
  const from = stroke.last || p;
  const dist = Math.hypot(p.x - from.x, p.y - from.y);
  const step = Math.max(1, radius / 4);
  const n = Math.max(1, Math.ceil(dist / step));
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let k = stroke.last ? 1 : 0; k <= n; k++) {
    const t = k / n;
    const [a, b, c, d] = stamp(from.x + (p.x - from.x) * t, from.y + (p.y - from.y) * t, radius, erase);
    bx0 = Math.min(bx0, a); by0 = Math.min(by0, b);
    bx1 = Math.max(bx1, c); by1 = Math.max(by1, d);
  }
  stroke.last = p;
  refreshResult(bx0, by0, bx1, by1);
  scheduleRender();
}

// Color tool: remove pixels similar to the clicked color (optionally only the connected region).
function colorRemove(px, py) {
  const { w, h, pixels, mask } = state;
  const sx = Math.floor(px);
  const sy = Math.floor(py);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const si = (sy * w + sx) * 4;
  const r0 = pixels[si], g0 = pixels[si + 1], b0 = pixels[si + 2];
  const tol = Number(els.tolerance.value);
  const feather = Math.max(4, tol * 0.25);
  const hard2 = tol * tol;
  const soft2 = (tol + feather) ** 2;

  const dist2 = (i) => {
    const dr = pixels[i * 4] - r0, dg = pixels[i * 4 + 1] - g0, db = pixels[i * 4 + 2] - b0;
    return dr * dr + dg * dg + db * db;
  };
  const apply = (i, d2) => {
    if (d2 <= hard2) {
      mask[i] = 0;
    } else if (d2 <= soft2) {
      const t = (Math.sqrt(d2) - tol) / feather; // 0 at edge of tolerance → 1 at feather end
      const v = 255 * t;
      if (mask[i] > v) mask[i] = v;
    }
  };

  if (!els.contiguous.checked) {
    for (let i = 0; i < w * h; i++) apply(i, dist2(i));
  } else {
    const seen = new Uint8Array(w * h);
    const stack = [sy * w + sx];
    seen[sy * w + sx] = 1;
    while (stack.length) {
      const i = stack.pop();
      const d2 = dist2(i);
      apply(i, d2);
      if (d2 > hard2) continue; // feathered pixels are the border; don't spread past them
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
  }
  commit();
  refreshResult();
  render();
}

// ---------- pointer handling on the canvas ----------

els.view.addEventListener("pointerdown", (e) => {
  if (!state.original || state.busy || e.button !== 0) return;
  const p = toImageCoords(e);
  if (state.tool === "wand") {
    colorRemove(p.x, p.y);
  } else if (state.tool === "erase" || state.tool === "restore") {
    els.view.setPointerCapture(e.pointerId);
    stroke = { last: null };
    strokeTo(p);
  }
});

els.view.addEventListener("pointermove", (e) => {
  updateBrushCursor(e);
  if (stroke) strokeTo(toImageCoords(e));
});

function endStroke() {
  if (!stroke) return;
  stroke = null;
  commit();
}
els.view.addEventListener("pointerup", endStroke);
els.view.addEventListener("pointercancel", endStroke);
els.view.addEventListener("pointerleave", () => { els.brushCursor.hidden = true; });

function updateBrushCursor(e) {
  const brushing = state.tool === "erase" || state.tool === "restore";
  els.brushCursor.hidden = !brushing || e.pointerType === "touch";
  if (els.brushCursor.hidden) return;
  const wr = els.canvasWrap.getBoundingClientRect();
  const size = Number(els.brushSize.value);
  Object.assign(els.brushCursor.style, {
    left: `${e.clientX - wr.left}px`,
    top: `${e.clientY - wr.top}px`,
    width: `${size}px`,
    height: `${size}px`,
  });
}

// ---------- compare slider ----------

let draggingSplit = false;
els.splitHandle.addEventListener("pointerdown", (e) => {
  draggingSplit = true;
  els.splitHandle.setPointerCapture(e.pointerId);
});
els.splitHandle.addEventListener("pointermove", (e) => {
  if (!draggingSplit) return;
  const r = els.view.getBoundingClientRect();
  state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  scheduleRender();
});
els.splitHandle.addEventListener("pointerup", () => { draggingSplit = false; });
els.splitHandle.addEventListener("pointercancel", () => { draggingSplit = false; });

// ---------- export ----------

function trimBounds() {
  const { w, h, mask, pixels } = state;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] > 8 && pixels[i * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function exportBlob(type) {
  const { w, h } = state;
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const fctx = full.getContext("2d");
  const flatten = type === "image/jpeg";
  if (flatten || state.bg.type !== "transparent") {
    drawBackground(fctx, w, h, true);
    if (flatten && state.bg.type === "transparent") {
      fctx.fillStyle = "#ffffff";
      fctx.fillRect(0, 0, w, h);
    }
  }
  fctx.drawImage(state.result, 0, 0);

  let out = full;
  if (els.trim.checked) {
    const b = trimBounds();
    out = document.createElement("canvas");
    out.width = b.w;
    out.height = b.h;
    out.getContext("2d").drawImage(full, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  }
  return new Promise((res) => out.toBlob(res, type, 0.95));
}

async function download() {
  if (!state.original) return;
  const type = els.format.value;
  const blob = await exportBlob(type);
  const ext = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" }[type];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name}-no-bg.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  setStatus(`Saved ${a.download}`);
}

async function copyToClipboard() {
  if (!state.original) return;
  try {
    // ClipboardItem accepts a promise, which keeps Safari's user-gesture requirement happy
    await navigator.clipboard.write([new ClipboardItem({ "image/png": exportBlob("image/png") })]);
    setStatus("Copied to clipboard.");
  } catch (err) {
    console.error(err);
    setStatus("Your browser blocked clipboard access — use Download instead.", true);
  }
}

// ---------- wiring ----------

els.fileInput.addEventListener("change", () => loadImageFile(els.fileInput.files[0]));

["dragenter", "dragover"].forEach((t) =>
  document.addEventListener(t, (e) => {
    e.preventDefault();
    if (!els.dropzone.hidden) els.dropzone.classList.add("over");
  })
);
["dragleave", "drop"].forEach((t) =>
  document.addEventListener(t, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("over");
  })
);
document.addEventListener("drop", (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) loadImageFile(file);
});

document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) loadImageFile(item.getAsFile());
});

els.aiBtn.addEventListener("click", runAI);

for (const b of document.querySelectorAll(".tool")) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}

const syncOutputs = () => {
  els.brushSizeOut.textContent = els.brushSize.value;
  els.brushSoftOut.textContent = `${els.brushSoft.value}%`;
  els.toleranceOut.textContent = els.tolerance.value;
};
[els.brushSize, els.brushSoft, els.tolerance].forEach((i) => i.addEventListener("input", syncOutputs));

els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.resetBtn.addEventListener("click", () => {
  if (!state.mask) return;
  state.mask.fill(255);
  commit();
  refreshResult();
  render();
  setStatus("Reset to the original image.");
});

function selectSwatch(el) {
  for (const s of els.swatches.querySelectorAll(".swatch")) s.classList.toggle("active", s === el);
}
for (const s of els.swatches.querySelectorAll("button.swatch")) {
  s.addEventListener("click", () => {
    state.bg = s.dataset.bg === "transparent" ? { type: "transparent" } : { type: "color", value: s.dataset.bg };
    selectSwatch(s);
    render();
  });
}
els.customColor.addEventListener("input", () => {
  state.bg = { type: "color", value: els.customColor.value };
  selectSwatch(els.customColor.parentElement);
  render();
});
els.bgImageInput.addEventListener("change", async () => {
  const f = els.bgImageInput.files[0];
  if (!f) return;
  try {
    bgImage = await createImageBitmap(f);
    state.bg = { type: "image" };
    selectSwatch(null);
    render();
  } catch {
    setStatus("Couldn't read that background image.", true);
  }
  els.bgImageInput.value = "";
});

els.compare.addEventListener("change", render);
els.downloadBtn.addEventListener("click", download);
els.copyBtn.addEventListener("click", copyToClipboard);
els.newBtn.addEventListener("click", resetToDropzone);

document.addEventListener("keydown", (e) => {
  if (!state.original || e.target.closest("input, select, textarea")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "[" || e.key === "]") {
    const v = Number(els.brushSize.value) + (e.key === "]" ? 5 : -5);
    els.brushSize.value = Math.min(300, Math.max(2, v));
    syncOutputs();
  }
});

setTool("none");
syncOutputs();
