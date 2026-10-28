// Capture this while the classic script is executing: currentScript is null
// later in file-loading callbacks. Explicit URLs also work when a cross-origin
// classic script's implicit import base is about:blank.
const demoScriptUrl = document.currentScript?.src || document.baseURI;
const demoLayout = document.querySelector("#demo-layout");
const stage = document.querySelector("#stage");
const viewerCard = document.querySelector(".viewer-card");
const canvas = document.querySelector("#parallax-canvas");
const placeholder = document.querySelector("#placeholder");
const fileInput = document.querySelector("#file-input");
const dropError = document.querySelector("#drop-error");
const dropSpinner = document.querySelector("#drop-spinner");
const dropMessage = document.querySelector("#drop-message");
const dimensions = document.querySelector("#dimensions");
const interactionHint = document.querySelector("#interaction-hint");
const strength = document.querySelector("#strength");
const strengthValue = document.querySelector("#strength-value");
const renderMode = document.querySelector("#render-mode");
const renderModeDescription = document.querySelector("#render-mode-description");
const depthButton = document.querySelector("#depth-button");
const motionButton = document.querySelector("#motion-button");
const motionStatus = document.querySelector("#motion-status");
const errorBox = document.querySelector("#error");

const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
const interaction = { x: 0, y: 0 };
let colorTexture = null;
let depthTexture = null;
let warpDepthTexture = null;
let warpDepthSource = null;
let warpDepthRadius = -1;
let hasDepthMap = false;
let colorSize = { width: 0, height: 0 };
let showDepth = false;
let drawingQueued = false;
let isLoading = false;
let loadSequence = 0;
let jxlLoaderPromise = null;
const tiltEnvironment = matchMedia("(pointer: coarse)").matches;
let tiltEnabled = false;
let motionBaseline = null;

const vertexShaderSource = `
  attribute vec2 a_position;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    v_uv = a_uv;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;
  varying vec2 v_uv;
  uniform highp sampler2D u_color;
  uniform highp sampler2D u_depth;
  uniform highp sampler2D u_warp_depth;
  uniform vec2 u_pointer;
  uniform vec2 u_strength;
  uniform vec2 u_depth_texel;
  uniform bool u_show_depth;
  float smoothDisparity(vec2 uv) {
    // Decode linearly filtered 16-bit depth without 8-bit displacement bands.
    return dot(texture2D(u_warp_depth, uv).rg, vec2(256.0 / 257.0, 1.0 / 257.0));
  }
  float warpDisparity(vec2 uv) {
    vec2 direction = u_pointer * u_strength * 0.25;
    float before = smoothDisparity(clamp(uv - direction, vec2(0.0), vec2(1.0)));
    float after = smoothDisparity(clamp(uv + direction, vec2(0.0), vec2(1.0)));
    // A hard sign test creates a moving seam around curved depth contours.
    // Blend continuously near tangencies; strong occluding edges still use
    // original depth so the first hit clips their hidden background.
    float occlusion = smoothstep(0.0, 0.025, after - before);
    return mix(smoothDisparity(uv), texture2D(u_depth, uv).r, occlusion);
  }
  void main() {
    if (u_show_depth) {
      gl_FragColor = vec4(vec3(texture2D(u_depth, v_uv).r), 1.0);
      return;
    }

    // Reserve image content around the viewport instead of extruding its last
    // row/column when the view moves beyond the original photograph.
    vec2 padding = min(u_strength, vec2(0.2));
    vec2 target_uv = mix(padding, vec2(1.0) - padding, v_uv);
    float destination_disparity = warpDisparity(target_uv);
    vec2 view_shift = u_pointer * u_strength;
    // Trace from near to far so overlapping surfaces consistently show the
    // nearest hit. Fixed-point iteration can oscillate across depth edges and
    // sample the same silhouette twice.
    float ray_pixels = max(abs(view_shift.x / u_depth_texel.x), abs(view_shift.y / u_depth_texel.y));
    float steps = clamp(ceil(ray_pixels * 2.0), 1.0, 256.0);
    float front = 0.0;
    float back = 1.0;
    if (destination_disparity < 1.0) {
      for (int i = 1; i <= 256; i++) {
        float distance = min(float(i) / steps, 1.0);
        vec2 sample_uv = clamp(target_uv - view_shift * distance, vec2(0.0), vec2(1.0));
        float surface_distance = 1.0 - warpDisparity(sample_uv);
        if (distance >= surface_distance) {
          back = distance;
          break;
        }
        front = distance;
      }

      // Resolve the first hit: sharp occlusion or smoothly stretched gap.
      for (int i = 0; i < 10; i++) {
        float distance = (front + back) * 0.5;
        vec2 sample_uv = clamp(target_uv - view_shift * distance, vec2(0.0), vec2(1.0));
        float surface_distance = 1.0 - warpDisparity(sample_uv);
        if (distance >= surface_distance) back = distance;
        else front = distance;
      }
    } else {
      back = 0.0;
    }
    vec2 source_uv = clamp(target_uv - view_shift * back, vec2(0.0), vec2(1.0));

    vec3 color = texture2D(u_color, source_uv).rgb;
    gl_FragColor = vec4(color, 1.0);
  }
`;

let program = null;
let positionLocation = -1;
let uvLocation = -1;
let pointerLocation = null;
let strengthLocation = null;
let depthTexelLocation = null;
let showDepthLocation = null;
let quadBuffer = null;
let meshRenderer = null;
let meshDepthSource = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "WebGL シェーダーを作成できませんでした。";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function initializeRenderer() {
  if (!gl) throw new Error("このブラウザでは WebGL を利用できません。");
  const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
  program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.bindAttribLocation(program, 1, "a_uv");
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "WebGL プログラムを作成できませんでした。");
  }

  gl.useProgram(program);
  const vertices = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
    -1,  1, 0, 1,
     1, -1, 1, 0,
     1,  1, 1, 1,
  ]);
  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  positionLocation = gl.getAttribLocation(program, "a_position");
  uvLocation = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(uvLocation);
  gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
  pointerLocation = gl.getUniformLocation(program, "u_pointer");
  strengthLocation = gl.getUniformLocation(program, "u_strength");
  depthTexelLocation = gl.getUniformLocation(program, "u_depth_texel");
  showDepthLocation = gl.getUniformLocation(program, "u_show_depth");

  colorTexture = createTexture(0);
  depthTexture = createTexture(1);
  warpDepthTexture = createTexture(2);
  gl.uniform1i(gl.getUniformLocation(program, "u_color"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_depth"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "u_warp_depth"), 2);
  gl.clearColor(0.05, 0.07, 0.05, 1.0);
}

function createTexture(unit) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function uploadTexture(texture, unit, image) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
}

async function displayDecodedImage(colorImage, depthImage = null, sourceName = "", depthWarning = "", depthSource = "") {
  const sourceWidth = colorImage.width;
  const sourceHeight = colorImage.height;
  const hasDepth = Boolean(depthImage);
  hasDepthMap = hasDepth;
  const scale = Math.min(1, 2048 / Math.max(colorImage.width, colorImage.height));
  const renderWidth = Math.max(1, Math.round(colorImage.width * scale));
  const renderHeight = Math.max(1, Math.round(colorImage.height * scale));
  let colorPreview;
  try {
    colorPreview = resizeImage(colorImage, renderWidth, renderHeight);
  } finally {
    colorImage.close?.();
  }
  const depthPreview = hasDepth
    ? resizeImage(depthImage, renderWidth, renderHeight)
    : createSolidImage(renderWidth, renderHeight, "#ffffff");

  uploadTexture(colorTexture, 0, colorPreview);
  uploadTexture(depthTexture, 1, depthPreview);
  const warpScale = Math.min(1, 512 / Math.max(renderWidth, renderHeight));
  warpDepthSource = resizeImage(depthPreview, Math.max(1, Math.round(renderWidth * warpScale)), Math.max(1, Math.round(renderHeight * warpScale)));
  warpDepthRadius = -1;
  releaseMesh();
  meshDepthSource = hasDepth ? depthPreview : null;
  colorSize = { width: renderWidth, height: renderHeight };
  stage.style.aspectRatio = `${sourceWidth} / ${sourceHeight}`;
  canvas.classList.remove("hidden");
  placeholder.classList.add("hidden");
  demoLayout.classList.remove("empty");
  dropError.classList.add("hidden");
  showDepth = false;
  depthButton.textContent = "深度マップを見る";
  const isJxl = /\.jxl$/i.test(sourceName);
  dimensions.textContent = hasDepth
    ? `色 ${sourceWidth} × ${sourceHeight} px · ${depthSource || "深度マップ"}を使用中`
    : `色 ${sourceWidth} × ${sourceHeight} px · ${isJxl ? (depthWarning ? "JXL深度チャンネル読込失敗" : "JXL深度チャンネルなし") : "深度マップなし"}`;
  if (!hasDepth && isJxl) {
    interactionHint.textContent = depthWarning ? "深度チャンネルを使用できません" : "このJXLに深度チャンネルはありません";
  } else {
    interactionHint.textContent = hasDepth
      ? (tiltEnvironment ? "端末を傾けて視差を確認" : "カーソルを動かして視差を確認")
      : "色画像のみ表示中";
  }
  strength.disabled = !hasDepth;
  renderMode.disabled = !hasDepth;
  depthButton.disabled = !hasDepth;
  motionButton.disabled = !hasDepth || !tiltEnvironment || !("DeviceOrientationEvent" in window);
  if (!hasDepth) {
    motionStatus.textContent = "";
  } else if (tiltEnvironment && !motionButton.disabled) {
    motionStatus.textContent = "ボタンを押すと端末の傾きで操作します。";
  } else if (tiltEnvironment) {
    motionStatus.textContent = "この環境では傾きセンサーを利用できません。";
  }
  if (depthWarning) showDropError(depthWarning);
  draw();
}

function createSolidImage(width, height, color) {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const context = image.getContext("2d");
  if (!context) throw new Error("深度マップを作成できませんでした。");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return image;
}

function loadImageFile(file, includeDepth = true) {
  if (/\.jxl$/i.test(file.name)) return loadJxlFile(file, includeDepth);

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} をこのブラウザで読み込めません。`));
    };
    image.src = url;
  });
}

function getJxlLoader() {
  return jxlLoaderPromise ||= import(new URL("./jxl-loader.js", demoScriptUrl).href);
}

function warmJxlDecoders() {
  // File selection and dragging give the workers a head start before decoding.
  void getJxlLoader().then(({ warmJxlWorkers }) => warmJxlWorkers()).catch(() => {});
}

function decodedPixelsToCanvas(image) {
  if (!image?.pixels) return image;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("JXL画像を表示用に変換できませんでした。");
  context.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
  return canvas;
}

async function loadJxlFile(file, includeDepth = true) {
  try {
    const { decodeJxlFile } = await getJxlLoader();
    const { colorImage, depthImage, depthWarning } = await decodeJxlFile(file, { includeDepth });
    return {
      colorImage: decodedPixelsToCanvas(colorImage),
      depthImage: decodedPixelsToCanvas(depthImage),
      depthWarning,
    };
  } catch (error) {
    throw new Error(`${file.name} のJXLデコードに失敗しました。${error.message ? ` ${error.message}` : ""}`);
  }
}

function showDropError(message) {
  dropMessage.textContent = message;
  dropSpinner.classList.add("hidden");
  dropError.classList.remove("loading");
  dropError.classList.remove("hidden");
  dropError.setAttribute("role", "alert");
  dropError.setAttribute("aria-busy", "false");
}

function showDropProgress(message) {
  dropMessage.textContent = message;
  dropSpinner.classList.remove("hidden");
  dropError.classList.add("loading");
  dropError.classList.remove("hidden");
  dropError.setAttribute("role", "status");
  dropError.setAttribute("aria-busy", "true");
}

function setLoadingState(loading) {
  isLoading = loading;
  fileInput.disabled = loading;
  placeholder.setAttribute("aria-disabled", String(loading));
  placeholder.tabIndex = loading ? -1 : 0;
  stage.setAttribute("aria-busy", String(loading));
}

async function loadDroppedFiles(fileList) {
  if (isLoading) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const currentSequence = ++loadSequence;
  if (files.length > 2) {
    showDropError("色画像と深度マップの2ファイルを選んでください。");
    return;
  }

  let colorFile = files[0];
  let depthFile = null;
  if (files.length === 2) {
    const namedDepth = files.find((file) => /depth|disparity/i.test(file.name));
    depthFile = namedDepth || files[1];
    colorFile = files.find((file) => file !== depthFile);
  }

  const imageFilePattern = /\.(jxl|jpe?g|png|webp|gif|bmp|tiff?|heic|avif)$/i;
  if (![colorFile, depthFile].filter(Boolean).every((file) => file.type.startsWith("image/") || imageFilePattern.test(file.name))) {
    showDropError("画像ファイルをドロップしてください。");
    return;
  }

  setLoadingState(true);
  showDropProgress("画像と深度チャンネルを読み込み中…");
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (currentSequence !== loadSequence) return;
    const [colorResult, depthResult] = await Promise.all([
      loadImageFile(colorFile, !depthFile),
      depthFile ? loadImageFile(depthFile, false) : Promise.resolve(null),
    ]);
    if (currentSequence !== loadSequence) return;
    const colorImage = colorResult?.colorImage || colorResult;
    const depthImage = depthResult?.colorImage || depthResult || colorResult?.depthImage || null;
    const depthSource = depthResult
      ? "深度マップ"
      : colorResult?.depthImage
        ? "JXL内の深度チャンネル"
        : "";
    const depthWarning = depthResult ? "" : colorResult?.depthWarning || "";
    await displayDecodedImage(colorImage, depthImage, colorFile.name, depthWarning, depthSource);
  } catch (error) {
    if (currentSequence !== loadSequence) return;
    showDropError(error.message || String(error));
  } finally {
    setLoadingState(false);
  }
}

function resizeImage(image, width, height) {
  const preview = document.createElement("canvas");
  preview.width = width;
  preview.height = height;
  const context = preview.getContext("2d");
  if (!context) throw new Error("画像をプレビュー用サイズに変換できませんでした。");
  context.drawImage(image, 0, 0, width, height);
  return preview;
}

placeholder.addEventListener("click", () => {
  if (!isLoading) {
    warmJxlDecoders();
    fileInput.click();
  }
});
placeholder.addEventListener("keydown", (event) => {
  if (isLoading) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    warmJxlDecoders();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  void loadDroppedFiles(fileInput.files);
  fileInput.value = "";
});

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).some((type) => String(type).toLowerCase() === "files")
    || Boolean(event.dataTransfer?.files?.length);
}

window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (isLoading && event.dataTransfer) event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  stage.classList.remove("dragging");
  if (isLoading) return;
  void loadDroppedFiles(event.dataTransfer?.files);
});

viewerCard.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (isLoading) return;
  warmJxlDecoders();
  stage.classList.add("dragging");
});
viewerCard.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = isLoading ? "none" : "copy";
});
viewerCard.addEventListener("dragleave", (event) => {
  if (!viewerCard.contains(event.relatedTarget)) stage.classList.remove("dragging");
});
function queueDraw() {
  if (drawingQueued) return;
  drawingQueued = true;
  requestAnimationFrame(() => {
    drawingQueued = false;
    draw();
  });
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    queueDraw();
  }
}

function blurDepthAxis(source, width, height, radius, vertical) {
  const output = new Float32Array(source.length);
  const length = vertical ? height : width;
  const lines = vertical ? width : height;
  const stride = vertical ? width : 1;
  const windowSize = radius * 2 + 1;
  for (let line = 0; line < lines; line += 1) {
    const start = vertical ? line : line * width;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += source[start + clamp(offset, 0, length - 1) * stride];
    }
    for (let point = 0; point < length; point += 1) {
      output[start + point * stride] = sum / windowSize;
      sum += source[start + Math.min(point + radius + 1, length - 1) * stride]
        - source[start + Math.max(point - radius, 0) * stride];
    }
  }
  return output;
}

function updateWarpDepth(bounds) {
  if (!warpDepthSource) return;
  const { width, height } = warpDepthSource;
  // Spread newly revealed gaps across a region wider than the movement.
  // The shader uses original depth on edges that occlude the background.
  const radius = hasDepthMap ? Math.ceil(1.25 * Number(strength.value) * Math.max(width / bounds.width, height / bounds.height)) : 0;
  if (radius === warpDepthRadius) return;
  const context = warpDepthSource.getContext("2d");
  const rgba = context.getImageData(0, 0, width, height).data;
  let plane = new Float32Array(width * height);
  for (let i = 0; i < plane.length; i += 1) plane[i] = rgba[i * 4];
  // Three separable box passes approximate a Gaussian, with no color blur.
  if (radius > 0) {
    for (let pass = 0; pass < 3; pass += 1) {
      plane = blurDepthAxis(plane, width, height, radius, false);
      plane = blurDepthAxis(plane, width, height, radius, true);
    }
  }
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const outputContext = image.getContext("2d");
  const output = outputContext.createImageData(width, height);
  for (let i = 0; i < plane.length; i += 1) {
    const value = Math.round(clamp(plane[i], 0, 255) * 257);
    output.data[i * 4] = value >> 8;
    output.data[i * 4 + 1] = value & 255;
    output.data[i * 4 + 3] = 255;
  }
  outputContext.putImageData(output, 0, 0);
  uploadTexture(warpDepthTexture, 2, image);
  warpDepthRadius = radius;
}

function releaseMesh() {
  meshRenderer?.clearGeometry();
  meshDepthSource = null;
}

function updateRenderModeDescription() {
  renderModeDescription.textContent = renderMode.value === "mesh"
    ? "深度から立体的な面を作り、手前の面で背後を隠します。開いた隙間は面を引き伸ばしてつなぎます。"
    : "深度に応じて画像を変形し、開いた隙間を滑らかに引き伸ばします。";
}

function draw() {
  if (!gl || !program || !colorSize.width) return;
  resizeCanvas();
  gl.viewport(0, 0, canvas.width, canvas.height);
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  if (renderMode.value === "mesh" && hasDepthMap && !showDepth) {
    try {
      if (!meshRenderer) meshRenderer = new DepthMeshRenderer(gl);
      if (meshRenderer.depthSource !== meshDepthSource) meshRenderer.setDepth(meshDepthSource);
      meshRenderer.draw(colorTexture, interaction, {
        x: Number(strength.value) / bounds.width,
        y: Number(strength.value) / bounds.height,
      });
      return;
    } catch (error) {
      renderMode.value = "warp";
      updateRenderModeDescription();
      showError(`深度メッシュを表示できませんでした。深度ワープに戻しました。 ${error.message || error}`);
    }
  }
  // Restore all fullscreen state after mesh or depth-map mode changes.
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(uvLocation);
  gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, colorTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  updateWarpDepth(bounds);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, warpDepthTexture);
  gl.uniform2f(pointerLocation, interaction.x, interaction.y);
  gl.uniform2f(
    strengthLocation,
    hasDepthMap ? Number(strength.value) / bounds.width : 0,
    hasDepthMap ? Number(strength.value) / bounds.height : 0,
  );
  gl.uniform2f(depthTexelLocation, 1 / colorSize.width, 1 / colorSize.height);
  gl.uniform1i(showDepthLocation, showDepth ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function setInteraction(x, y) {
  interaction.x = clamp(x, -1, 1);
  interaction.y = clamp(y, -1, 1);
  queueDraw();
}

function onDeviceOrientation(event) {
  if (event.gamma === null || event.beta === null) return;
  if (!motionBaseline) {
    motionBaseline = { gamma: event.gamma, beta: event.beta };
    motionStatus.textContent = "端末の傾きで操作中";
    return;
  }
  const x = (event.gamma - motionBaseline.gamma) / 24;
  const y = -(event.beta - motionBaseline.beta) / 24;
  setInteraction(x, y);
}

function startTiltInput() {
  if (tiltEnabled) return;
  tiltEnabled = true;
  motionBaseline = null;
  window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
  motionButton.textContent = "傾き操作中";
  motionButton.disabled = true;
  motionStatus.textContent = "傾きセンサーを待っています…";
  window.setTimeout(() => {
    if (tiltEnabled && !motionBaseline) motionStatus.textContent = "傾きセンサーから入力がありません。端末の設定を確認してください。";
  }, 2000);
}

async function requestTiltPermission() {
  if (!tiltEnvironment || tiltEnabled) return;
  if (!("DeviceOrientationEvent" in window)) {
    motionStatus.textContent = "この環境では傾きセンサーを利用できません。";
    return;
  }
  motionButton.disabled = true;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        motionStatus.textContent = "傾きセンサーへのアクセスが許可されませんでした。";
        motionButton.disabled = false;
        return;
      }
    }
    startTiltInput();
  } catch (error) {
    motionStatus.textContent = error.message || "傾きセンサーを開始できませんでした。";
    motionButton.disabled = false;
  }
}

strength.addEventListener("input", () => {
  strengthValue.textContent = `${strength.value} px`;
  queueDraw();
});
renderMode.addEventListener("change", () => {
  updateRenderModeDescription();
  queueDraw();
});
depthButton.addEventListener("click", () => {
  showDepth = !showDepth;
  depthButton.textContent = showDepth ? "色画像に戻る" : "深度マップを見る";
  queueDraw();
});
motionButton.addEventListener("click", () => void requestTiltPermission());

stage.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  setInteraction((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
});
stage.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "mouse") setInteraction(0, 0);
});
window.addEventListener("resize", queueDraw);

try {
  initializeRenderer();
  if (tiltEnvironment) {
    interactionHint.textContent = "端末を傾けて視差を確認";
    motionStatus.textContent = "ボタンを押すと端末の傾きで操作します。";
    motionButton.disabled = !("DeviceOrientationEvent" in window);
  } else {
    interactionHint.textContent = "カーソルを動かして視差を確認";
    motionButton.disabled = true;
  }
} catch (error) {
  showError(error.message || String(error));
}
