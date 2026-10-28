const input = document.querySelector("#file-input");
const dropzone = document.querySelector("#dropzone");
const fileCard = document.querySelector("#file-card");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const removeFile = document.querySelector("#remove-file");
const previewButton = document.querySelector("#preview-button");
const exportButton = document.querySelector("#export-button");
const outputWidth = document.querySelector("#output-width");
const outputHeight = document.querySelector("#output-height");
const aspectLock = document.querySelector("#aspect-lock");
const sourceSizeNote = document.querySelector("#source-size-note");
const quality = document.querySelector("#quality");
const qualityValue = document.querySelector("#quality-value");
const effort = document.querySelector("#effort");
const progressArea = document.querySelector("#progress-area");
const status = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const successBox = document.querySelector("#success");
const comparison = document.querySelector("#comparison");
const beforeImage = document.querySelector("#before-image");
const afterImage = document.querySelector("#after-image");
const wipeStage = document.querySelector("#wipe-stage");
const wipeDivider = document.querySelector("#wipe-divider");
const zoomToggleButton = document.querySelector("#zoom-toggle");
const previewModal = document.querySelector("#preview-modal");
const zoomViewport = document.querySelector("#zoom-viewport");
const zoomStage = document.querySelector("#zoom-stage");
const zoomBeforeImage = document.querySelector("#zoom-before-image");
const zoomAfterImage = document.querySelector("#zoom-after-image");
const zoomDivider = document.querySelector("#zoom-divider");
const zoomLevel = document.querySelector("#zoom-level");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomInButton = document.querySelector("#zoom-in");

let selectedFile = null;
let previewToken = null;
let sourceAspectRatio = null;
let wipePosition = 50;
const mainView = { stage: wipeStage, divider: wipeDivider, scale: 1, panX: 0, panY: 0 };
const zoomView = { stage: zoomStage, divider: zoomDivider, scale: 1, panX: 0, panY: 0 };

function sizeText(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function hideError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function hideSuccess() {
  successBox.textContent = "";
  successBox.classList.add("hidden");
}

function resetComparison() {
  if (previewToken) void window.spatialJxl?.discardPreview(previewToken);
  previewToken = null;
  comparison.classList.add("hidden");
  if (!previewModal.classList.contains("hidden")) closeZoom();
  setWipePosition(50);
  setViewScale(mainView, 1);
  setViewScale(zoomView, 1);
  exportButton.disabled = true;
  hideSuccess();
}

function setWipePosition(value) {
  wipePosition = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  for (const view of [mainView, zoomView]) {
    view.stage.style.setProperty("--wipe-position", `${wipePosition}%`);
    view.divider.setAttribute("aria-valuenow", String(wipePosition));
  }
}

function applyViewTransform(view) {
  view.stage.style.setProperty("--zoom-scale", String(view.scale));
  view.stage.style.setProperty("--pan-x", `${view.panX}px`);
  view.stage.style.setProperty("--pan-y", `${view.panY}px`);
  view.stage.classList.toggle("is-zoomed", view.scale > 1);
  if (view === zoomView) {
    zoomLevel.textContent = view.scale === 1 ? "全体表示" : `${Math.round(view.scale * 100)}%`;
    zoomOutButton.disabled = view.scale <= 1;
    zoomInButton.disabled = view.scale >= 4;
  }
}

function setViewScale(view, value) {
  view.scale = Math.max(1, Math.min(4, Math.round(value * 100) / 100));
  if (view.scale === 1) {
    view.panX = 0;
    view.panY = 0;
  }
  applyViewTransform(view);
}

function setWipeFromPointer(view, event) {
  const bounds = view.stage.getBoundingClientRect();
  if (bounds.width > 0) setWipePosition((event.clientX - bounds.left) / bounds.width * 100);
}

function bindWipeInteraction(view) {
  let dragMode = null;
  let startX = 0;
  let startY = 0;
  let startPanX = 0;
  let startPanY = 0;

  view.stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const dividerBounds = view.divider.getBoundingClientRect();
    const grabbedDivider = event.target.closest(`#${view.divider.id}`)
      || Math.abs(event.clientX - (dividerBounds.left + dividerBounds.width / 2)) < 18;
    dragMode = view.scale === 1 || grabbedDivider ? "wipe" : "pan";
    startX = event.clientX;
    startY = event.clientY;
    startPanX = view.panX;
    startPanY = view.panY;
    view.stage.setPointerCapture(event.pointerId);
    if (dragMode === "wipe") setWipeFromPointer(view, event);
    event.preventDefault();
  });
  view.stage.addEventListener("pointermove", (event) => {
    if (dragMode === "wipe") {
      setWipeFromPointer(view, event);
    } else if (dragMode === "pan") {
      const maxPanX = view.stage.clientWidth * (view.scale - 1) / 2;
      const maxPanY = view.stage.clientHeight * (view.scale - 1) / 2;
      view.panX = Math.max(-maxPanX, Math.min(maxPanX, startPanX + event.clientX - startX));
      view.panY = Math.max(-maxPanY, Math.min(maxPanY, startPanY + event.clientY - startY));
      applyViewTransform(view);
    }
  });
  const stopDrag = (event) => {
    dragMode = null;
    if (view.stage.hasPointerCapture(event.pointerId)) view.stage.releasePointerCapture(event.pointerId);
  };
  view.stage.addEventListener("pointerup", stopDrag);
  view.stage.addEventListener("pointercancel", stopDrag);
  view.divider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setWipePosition(wipePosition + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 5 : 1));
    }
  });
}

bindWipeInteraction(mainView);
bindWipeInteraction(zoomView);

function fitZoomStage() {
  if (previewModal.classList.contains("hidden") || !zoomBeforeImage.naturalWidth || !zoomBeforeImage.naturalHeight) return;
  const width = zoomBeforeImage.naturalWidth;
  const height = zoomBeforeImage.naturalHeight;
  const fit = Math.min(1, zoomViewport.clientWidth / width, zoomViewport.clientHeight / height);
  zoomStage.style.aspectRatio = `${width} / ${height}`;
  zoomStage.style.width = `${Math.max(1, Math.round(width * fit))}px`;
  zoomStage.style.height = `${Math.max(1, Math.round(height * fit))}px`;
  applyViewTransform(zoomView);
}

function openZoom() {
  zoomView.scale = 2;
  zoomView.panX = 0;
  zoomView.panY = 0;
  zoomBeforeImage.onload = fitZoomStage;
  zoomAfterImage.onload = fitZoomStage;
  zoomBeforeImage.src = beforeImage.src;
  zoomAfterImage.src = afterImage.src;
  setWipePosition(wipePosition);
  previewModal.classList.remove("hidden");
  document.body.classList.add("zoom-open");
  requestAnimationFrame(fitZoomStage);
  document.querySelector("#zoom-close").focus();
}

function closeZoom() {
  previewModal.classList.add("hidden");
  document.body.classList.remove("zoom-open");
  zoomToggleButton.focus();
}

zoomToggleButton.addEventListener("click", openZoom);
document.querySelector("#zoom-close").addEventListener("click", closeZoom);
zoomInButton.addEventListener("click", () => {
  setViewScale(zoomView, zoomView.scale + 0.25);
});
zoomOutButton.addEventListener("click", () => {
  setViewScale(zoomView, zoomView.scale - 0.25);
});
document.querySelector("#zoom-fit").addEventListener("click", () => {
  setViewScale(zoomView, 1);
});
zoomStage.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaY) < 0.1) return;
  event.preventDefault();
  setViewScale(zoomView, zoomView.scale + (event.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });
previewModal.addEventListener("click", (event) => {
  if (event.target === previewModal) closeZoom();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !previewModal.classList.contains("hidden")) closeZoom();
});
window.addEventListener("resize", fitZoomStage);
beforeImage.addEventListener("load", () => {
  wipeStage.style.aspectRatio = `${beforeImage.naturalWidth} / ${beforeImage.naturalHeight}`;
});

async function chooseFile(file) {
  hideError();
  hideSuccess();
  if (!file) return;
  if (!/\.hei[cf]$/i.test(file.name)) {
    showError("HEIC または HEIF ファイルを選択してください。");
    return;
  }
  if (file.size > 512 * 1024 * 1024) {
    showError("ファイルが大きすぎます。上限は 512 MiB です。");
    return;
  }
  if (!window.spatialJxl) {
    showError("この変換ツールは Electron デスクトップアプリとして起動してください。");
    return;
  }

  try {
    if (selectedFile) await window.spatialJxl.releaseFile(selectedFile.id);
    selectedFile = await window.spatialJxl.registerFile(file);
    fileName.textContent = selectedFile.name;
    fileSize.textContent = sizeText(selectedFile.size);
    sourceAspectRatio = selectedFile.width / selectedFile.height;
    outputWidth.value = String(selectedFile.width);
    outputHeight.value = String(selectedFile.height);
    outputWidth.disabled = false;
    outputHeight.disabled = false;
    aspectLock.disabled = false;
    sourceSizeNote.textContent = `元画像: ${selectedFile.width} × ${selectedFile.height} px`;
    dropzone.classList.add("hidden");
    fileCard.classList.remove("hidden");
    previewButton.disabled = false;
    resetComparison();
  } catch (error) {
    selectedFile = null;
    sourceAspectRatio = null;
    outputWidth.value = "";
    outputHeight.value = "";
    outputWidth.disabled = true;
    outputHeight.disabled = true;
    aspectLock.disabled = true;
    aspectLock.checked = true;
    sourceSizeNote.textContent = "HEIC を選ぶと元画像のサイズが入ります。";
    dropzone.classList.remove("hidden");
    fileCard.classList.add("hidden");
    previewButton.disabled = true;
    resetComparison();
    showError(error.message || String(error));
  }
}

input.addEventListener("change", () => {
  const file = input.files?.[0];
  void chooseFile(file);
  input.value = "";
});

removeFile.addEventListener("click", async () => {
  if (selectedFile) await window.spatialJxl?.releaseFile(selectedFile.id);
  selectedFile = null;
  sourceAspectRatio = null;
  outputWidth.value = "";
  outputHeight.value = "";
  outputWidth.disabled = true;
  outputHeight.disabled = true;
  aspectLock.disabled = true;
  aspectLock.checked = true;
  sourceSizeNote.textContent = "HEIC を選ぶと元画像のサイズが入ります。";
  input.value = "";
  dropzone.classList.remove("hidden");
  fileCard.classList.add("hidden");
  previewButton.disabled = true;
  resetComparison();
  hideError();
});

function updateOutputDimensions(changedInput) {
  const currentValue = Number(changedInput.value);
  if (aspectLock.checked && sourceAspectRatio && Number.isInteger(currentValue) && currentValue > 0) {
    if (changedInput === outputWidth) {
      outputHeight.value = String(Math.max(1, Math.round(currentValue / sourceAspectRatio)));
    } else {
      outputWidth.value = String(Math.max(1, Math.round(currentValue * sourceAspectRatio)));
    }
  }
  hideError();
  resetComparison();
}

outputWidth.addEventListener("input", () => updateOutputDimensions(outputWidth));
outputHeight.addEventListener("input", () => updateOutputDimensions(outputHeight));

quality.addEventListener("input", () => {
  const distance = Number(quality.value);
  qualityValue.textContent = distance === 0 ? "ロスレス" : `Distance ${distance.toFixed(1)}`;
  resetComparison();
});

effort.addEventListener("change", resetComparison);

dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    input.click();
  }
});

for (const name of ["dragenter", "dragover"]) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const name of ["dragleave", "drop"]) {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
}
dropzone.addEventListener("drop", (event) => {
  void chooseFile(event.dataTransfer?.files?.[0]);
});

previewButton.addEventListener("click", async () => {
  if (!selectedFile || !window.spatialJxl) return;
  hideError();
  hideSuccess();
  resetComparison();
  const width = Number(outputWidth.value);
  const height = Number(outputHeight.value);
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 32768 || height > 32768 || width * height > 50_000_000
  ) {
    showError("出力サイズは一辺 32,768 px 以下、合計 5,000 万画素以下の整数で指定してください。");
    return;
  }
  previewButton.disabled = true;
  progressArea.classList.remove("hidden");
  status.textContent = "色画像と深度を読み取り、JPEG XL を作成しています…";

  try {
    const report = await window.spatialJxl.createPreview({
      fileId: selectedFile.id,
      distance: Number(quality.value),
      effort: Number(effort.value),
      width,
      height,
    });
    previewToken = report.token;
    document.querySelector("#before-image").src = report.beforePreview;
    document.querySelector("#after-image").src = report.afterPreview;
    document.querySelector("#before-size").textContent = sizeText(report.input_size);
    document.querySelector("#after-size").textContent = sizeText(report.output_size);
    document.querySelector("#before-size-detail").textContent = sizeText(report.input_size);
    document.querySelector("#after-size-detail").textContent = sizeText(report.output_size);
    document.querySelector("#dimensions").textContent =
      `色 ${report.source_color_size[0]} × ${report.source_color_size[1]} → ${report.color_size[0]} × ${report.color_size[1]} px · 深度 ${report.source_depth_size[0]} × ${report.source_depth_size[1]} → ${report.stored_depth_size[0]} × ${report.stored_depth_size[1]}`;

    const ratio = report.input_size ? report.output_size / report.input_size : 1;
    const difference = Math.abs(ratio - 1) * 100;
    const direction = ratio <= 1 ? "小さく" : "大きく";
    document.querySelector("#size-change").textContent = `${difference.toFixed(1)}% ${direction}`;
    const scale = Math.max(report.input_size, report.output_size, 1);
    document.querySelector("#before-bar").style.width = `${Math.max(1, report.input_size / scale * 100)}%`;
    document.querySelector("#after-bar").style.width = `${Math.max(1, report.output_size / scale * 100)}%`;

    comparison.classList.remove("hidden");
    exportButton.disabled = false;
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    progressArea.classList.add("hidden");
    previewButton.disabled = !selectedFile;
  }
});

exportButton.addEventListener("click", async () => {
  if (!previewToken) return;
  exportButton.disabled = true;
  hideError();
  try {
    const result = await window.spatialJxl.exportFile(previewToken);
    if (result.canceled) return;
    previewToken = null;
    successBox.textContent = `保存しました: ${result.path}`;
    successBox.classList.remove("hidden");
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    exportButton.disabled = !previewToken;
  }
});

if (!window.spatialJxl) {
  previewButton.disabled = true;
  showError("この変換ツールは Electron デスクトップアプリとして起動してください。");
}
