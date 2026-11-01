const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 720,
    title: 'SnapCut 3D - 3D打印大模型分件切片与磁吸/榫卯定位器',
    backgroundColor: '#12151b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // 允许本地直接读取拖拽与导入的 STL 模型
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接调用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 原生文件打开对话框
ipcMain.handle('dialog:open-stl', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 3D 模型 (STL)',
    filters: [
      { name: '3D 模型文件', extensions: ['stl'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  return {
    filePath,
    fileName,
    buffer: fileBuffer.buffer
  };
});

// 原生文件保存对话框 (STL)
ipcMain.handle('dialog:save-stl', async (event, { defaultName, arrayBuffer }) => {
  if (!mainWindow) return false;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存切分件 STL',
    defaultPath: defaultName || 'Part.stl',
    filters: [
      { name: 'STL 3D 模型', extensions: ['stl'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return false;
  }

  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(result.filePath, buffer);
  return true;
});

// 原生文件保存对话框 (ZIP)
ipcMain.handle('dialog:save-zip', async (event, { defaultName, base64Data }) => {
  if (!mainWindow) return false;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出零件包与装配清单 (ZIP)',
    defaultPath: defaultName || 'SnapCut_Parts.zip',
    filters: [
      { name: 'ZIP 压缩包', extensions: ['zip'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return false;
  }

  const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  fs.writeFileSync(result.filePath, buffer);
  return true;
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
