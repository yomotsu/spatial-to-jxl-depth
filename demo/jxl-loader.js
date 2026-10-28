class WorkerUnavailableError extends Error {}

const workers = new Map();
const unavailableWorkers = new Set();
let colorDecoderPromise = null;
let depthDecoderPromise = null;

function getWorker(kind) {
  if (typeof Worker === "undefined" || unavailableWorkers.has(kind)) {
    throw new WorkerUnavailableError("Web Worker を利用できません。");
  }
  if (workers.has(kind)) return workers.get(kind);
  const url = new URL("./jxl-worker.js", import.meta.url);
  url.searchParams.set("kind", kind);
  let worker;
  try {
    worker = new Worker(url, { type: "module", name: `jxl-${kind}` });
  } catch (error) {
    unavailableWorkers.add(kind);
    throw new WorkerUnavailableError(error.message);
  }
  const pending = new Map();
  let nextId = 0;
  const fail = () => {
    unavailableWorkers.add(kind);
    workers.delete(kind);
    worker.terminate();
    for (const { reject } of pending.values()) reject(new WorkerUnavailableError("JXLワーカーを起動できませんでした。"));
    pending.clear();
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail();
  };
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.image);
  };
  const client = {
    decode(file) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try {
          // File is immutable and structured-cloned without copying all its
          // bytes on the main thread. Each worker reads its own input buffer.
          worker.postMessage({ id, file });
        } catch {
          fail();
        }
      });
    },
  };
  workers.set(kind, client);
  return client;
}

export function warmJxlWorkers() {
  for (const kind of ["depth", "color"]) {
    try { getWorker(kind); } catch { /* Decoding has a main-thread fallback. */ }
  }
}

async function decodeOnWorker(kind, file, fallback) {
  try {
    return await getWorker(kind).decode(file);
  } catch (error) {
    // Decode errors must not repeat expensive work. Only retry when the
    // environment cannot start or communicate with a worker.
    if (!(error instanceof WorkerUnavailableError)) throw error;
    return fallback();
  }
}

function pixelResult(image) {
  return image ? { width: image.width, height: image.height, pixels: image.data } : null;
}

async function decodeColor(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch { /* Use libjxl. */ }
  }
  return decodeOnWorker("color", file, async () => {
    colorDecoderPromise ||= import("./vendor/jxl/decode.js");
    const [{ default: decode }, buffer] = await Promise.all([colorDecoderPromise, file.arrayBuffer()]);
    return pixelResult(await decode(buffer));
  });
}

async function decodeDepth(file) {
  return decodeOnWorker("depth", file, async () => {
    depthDecoderPromise ||= import("./jxl-depth.js");
    const [{ extractJxlDepthPixels }, buffer] = await Promise.all([depthDecoderPromise, file.arrayBuffer()]);
    return pixelResult(await extractJxlDepthPixels(buffer));
  });
}

export async function decodeJxlFile(file, { includeDepth = true } = {}) {
  // Start both immediately, including native color decoding. Neither decoder
  // waits for the other to finish or uses the other's mutable memory.
  const depthResult = includeDepth
    ? decodeDepth(file).then(
      (depthImage) => ({ depthImage, depthWarning: "" }),
      (error) => ({ depthImage: null, depthWarning: `JXLの深度チャンネルを読み取れませんでした。 ${error.message || error}` }),
    )
    : Promise.resolve({ depthImage: null, depthWarning: "" });
  const [colorImage, depth] = await Promise.all([decodeColor(file), depthResult]);
  return { colorImage, ...depth };
}
