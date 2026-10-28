const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("spatialJxl", Object.freeze({
  selectFile: () => ipcRenderer.invoke("spatial-jxl:select-file"),
  registerFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return Promise.reject(new Error("このファイルの場所を取得できませんでした。"));
    return ipcRenderer.invoke("spatial-jxl:register-file", filePath);
  },
  releaseFile: (id) => ipcRenderer.invoke("spatial-jxl:release-file", id),
  discardPreview: (token) => ipcRenderer.invoke("spatial-jxl:discard-preview", token),
  createPreview: (request) => ipcRenderer.invoke("spatial-jxl:create-preview", request),
  exportFile: (token) => ipcRenderer.invoke("spatial-jxl:export", token),
}));
