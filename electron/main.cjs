const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const selectedFiles = new Map();
const pendingExports = new Map();
let mainWindow = null;

function engineFile(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, "engine", name);
  return path.join(__dirname, "..", name);
}

function pythonCommand() {
  return process.env.SPATIAL_JXL_PYTHON || "python3";
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), [engineFile("heic_to_jxl.py"), ...args], {
      cwd: app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(__dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => reject(new Error(`Python を起動できませんでした: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `変換処理が終了コード ${code} で停止しました。`).trim()));
    });
  });
}

function inspectHeicDimensions(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SPATIAL_JXL_HEIF_INFO || "heif-info", [filePath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => reject(new Error(`heif-info を起動できませんでした: ${error.message}`)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || "HEIC の画像サイズを読み取れませんでした。").trim()));
        return;
      }
      const lines = stdout.split(/\r?\n/).filter((line) => /^\s*image:/i.test(line));
      const primary = lines.find((line) => /,\s*primary\b/i.test(line)) || lines[0];
      const dimensions = primary?.match(/^\s*image:\s*(\d+)x(\d+)/i);
      if (!dimensions) {
        reject(new Error("HEIC の主画像サイズを取得できませんでした。"));
        return;
      }
      resolve({ width: Number(dimensions[1]), height: Number(dimensions[2]) });
    });
  });
}

async function removePending(token) {
  const entry = pendingExports.get(token);
  if (!entry) return;
  pendingExports.delete(token);
  await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => {});
}

async function clearPendingExports() {
  await Promise.all([...pendingExports.keys()].map(removePending));
}

async function registerInput(filePath) {
  if (typeof filePath !== "string" || !filePath) throw new Error("ファイルを読み取れません。");
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".heic" && extension !== ".heif") {
    throw new Error("HEIC または HEIF ファイルを選択してください。");
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("選択したパスはファイルではありません。");
  if (stat.size > MAX_INPUT_BYTES) throw new Error("ファイルが大きすぎます。上限は 512 MiB です。");

  const dimensions = await inspectHeicDimensions(filePath);
  const id = randomUUID();
  const name = path.basename(filePath);
  selectedFiles.set(id, { path: filePath, name, size: stat.size, ...dimensions });
  return { id, name, size: stat.size, ...dimensions };
}

ipcMain.handle("spatial-jxl:select-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "深度付き HEIC を選択",
    properties: ["openFile"],
    filters: [{ name: "HEIC / HEIF", extensions: ["heic", "heif"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return registerInput(result.filePaths[0]);
});

ipcMain.handle("spatial-jxl:register-file", (_event, filePath) => registerInput(filePath));

ipcMain.handle("spatial-jxl:release-file", (_event, id) => {
  selectedFiles.delete(id);
});

ipcMain.handle("spatial-jxl:discard-preview", (_event, token) => removePending(token));

ipcMain.handle("spatial-jxl:create-preview", async (_event, request) => {
  const input = selectedFiles.get(request?.fileId);
  if (!input) throw new Error("HEIC ファイルを選び直してください。");

  const distance = Number(request.distance);
  const effort = Number(request.effort);
  const width = Number(request.width);
  const height = Number(request.height);
  if (!Number.isFinite(distance) || distance < 0 || distance > 25) {
    throw new Error("カラー画質の値が正しくありません。");
  }
  if (!Number.isInteger(effort) || effort < 1 || effort > 10) {
    throw new Error("Encode effort の設定が正しくありません。");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("出力幅と高さは 1 以上の整数で指定してください。");
  }
  if (width > 32768 || height > 32768 || width * height > 50_000_000) {
    throw new Error("出力サイズは一辺 32,768 px 以下、合計 5,000 万画素以下にしてください。");
  }

  await clearPendingExports();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spatial-to-jxl-"));
  const outputPath = path.join(directory, "converted.jxl");
  const beforePreviewPath = path.join(directory, "before.jpg");
  const afterPreviewPath = path.join(directory, "after.jpg");

  try {
    const reportText = await runPython([
      input.path,
      "--output", outputPath,
      "--distance", String(distance),
      "--effort", String(effort),
      "--width", String(width),
      "--height", String(height),
      "--before-preview", beforePreviewPath,
      "--after-preview", afterPreviewPath,
      "--json-report",
    ]);
    const report = JSON.parse(reportText);
    const [beforePreview, afterPreview] = await Promise.all([
      fs.readFile(beforePreviewPath),
      fs.readFile(afterPreviewPath),
    ]);
    const token = randomUUID();
    pendingExports.set(token, {
      directory,
      outputPath,
      suggestedName: `${path.parse(input.name).name}.jxl`,
    });

    return {
      ...report,
      token,
      beforePreview: `data:image/jpeg;base64,${beforePreview.toString("base64")}`,
      afterPreview: `data:image/jpeg;base64,${afterPreview.toString("base64")}`,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
});

ipcMain.handle("spatial-jxl:export", async (_event, token) => {
  const entry = pendingExports.get(token);
  if (!entry) throw new Error("書き出す JXL が見つかりません。プレビューを作り直してください。");

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "JPEG XL を書き出し",
    defaultPath: entry.suggestedName,
    filters: [{ name: "JPEG XL", extensions: ["jxl"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  await fs.copyFile(entry.outputPath, result.filePath);
  const stat = await fs.stat(result.filePath);
  await removePending(token);
  return { canceled: false, path: result.filePath, size: stat.size };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 980,
    minWidth: 760,
    minHeight: 720,
    backgroundColor: "#101212",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "web", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void clearPendingExports();
  selectedFiles.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
