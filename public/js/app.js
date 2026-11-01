import { ModelViewer } from './viewer.js';
import { ModelSlicer } from './slicer.js';
import { STLUtils } from './stl-utils.js';
import { PRINTER_PRESETS, MAGNET_PRESETS, DOWEL_PRESETS, SAMPLES } from './presets.js';

class SnapCutApp {
  constructor() {
    this.viewer = null;
    this.earcut = null;

    // 模型状态
    this.modelName = '未加载模型';
    this.rawPositions = null;
    this.modelDimensions = null; // { x, y, z }

    // 预设配置
    this.currentPrinter = PRINTER_PRESETS[0]; // 默认 A1 mini
    this.connectorType = 'magnet'; // 'none' | 'magnet' | 'dowel'
    this.currentMagnet = MAGNET_PRESETS[0]; // 默认 φ6x3mm
    this.currentDowel = DOWEL_PRESETS[0]; // 默认 D型防呆销
    this.placementMode = 'dual'; // 'single' | 'dual' | 'quad'
    this.clearance = 0.2; // mm

    // 切割刀状态
    this.sliceAxis = 'Y'; // 水平高度切
    this.sliceOffset = 0;
    this.tiltX = 0;
    this.tiltY = 0;

    // 切割产物
    this.sliceResult = null;

    this.init();
  }

  async init() {
    // 1. 初始化 3D 视口
    this.viewer = new ModelViewer('viewport-container');

    // 2. 加载 earcut
    if (window.earcut) {
      this.earcut = typeof window.earcut === 'function' ? window.earcut : (window.earcut.default || window.earcut);
    } else {
      // 备用简易三角剖分
      this.earcut = (coords, holes, dim) => {
        const result = [];
        const n = (coords.length / dim);
        for (let i = 1; i < n - 1; i++) {
          result.push(0, i, i + 1);
        }
        return result;
      };
    }

    // 3. 渲染 UI 面板
    this.populatePrinters();
    this.populateSamples();
    this.populateConnectors();
    this.bindEvents();

    // 4. 默认载入第一个爆款大尺寸示例 (赛博光剑手柄 290mm)
    await this.loadSample(SAMPLES[0]);
  }

  populatePrinters() {
    const select = document.getElementById('printer-select');
    select.innerHTML = '';
    PRINTER_PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.brand} - ${p.name} (${p.size.x}×${p.size.y}×${p.size.z}mm)`;
      select.appendChild(opt);
    });
  }

  populateSamples() {
    const list = document.getElementById('samples-list');
    list.innerHTML = '';
    SAMPLES.forEach(s => {
      const item = document.createElement('div');
      item.className = 'sample-item';
      item.innerHTML = `
        <div>
          <div class="sample-name">${s.name}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${s.desc}</div>
        </div>
        <span class="sample-tag">${s.tag}</span>
      `;
      item.addEventListener('click', () => this.loadSample(s));
      list.appendChild(item);
    });
  }

  populateConnectors() {
    // 磁铁规格下拉
    const magSelect = document.getElementById('magnet-select');
    magSelect.innerHTML = '';
    MAGNET_PRESETS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} [${m.holdingForce}]`;
      magSelect.appendChild(opt);
    });

    // 榫卯规格下拉
    const dowelSelect = document.getElementById('dowel-select');
    dowelSelect.innerHTML = '';
    DOWEL_PRESETS.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name}`;
      dowelSelect.appendChild(opt);
    });
  }

  bindEvents() {
    // 1. 打印机切换
    document.getElementById('printer-select').addEventListener('change', (e) => {
      const found = PRINTER_PRESETS.find(p => p.id === e.target.value);
      if (found) {
        this.currentPrinter = found;
        this.viewer.updatePrinterBed(found.size);
        this.checkModelDimensions();
      }
    });

    // 2. 本地文件上传与拖拽 (支持 Electron 原生文件选择与 Web 降级)
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');

    dropzone.addEventListener('click', async () => {
      if (window.electronAPI && window.electronAPI.openSTL) {
        try {
          const res = await window.electronAPI.openSTL();
          if (res && res.buffer) {
            this.modelName = res.fileName.replace(/\.[^/.]+$/, '');
            document.getElementById('current-model-name').textContent = this.modelName;
            this.processLoadedModel(res.buffer);
            return;
          }
        } catch (err) {
          console.warn('Electron 原生打开失败，降级至标准文件框:', err);
        }
      }
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleFileUpload(e.target.files[0]);
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        this.handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    // 3. 切割轴向切换
    document.querySelectorAll('.axis-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.axis-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sliceAxis = btn.dataset.axis;
        this.updateSlicePlaneLimits();
      });
    });

    // 4. 切割高度滑块
    const offsetSlider = document.getElementById('slice-offset-slider');
    const offsetVal = document.getElementById('slice-offset-val');
    offsetSlider.addEventListener('input', (e) => {
      this.sliceOffset = parseFloat(e.target.value);
      offsetVal.textContent = `${this.sliceOffset.toFixed(1)} mm`;
      this.viewer.setSlicePlane(this.sliceAxis, this.sliceOffset, this.tiltX, this.tiltY);
    });

    // 5. 居中智能推荐按钮
    document.getElementById('btn-center-cut').addEventListener('click', () => {
      if (!this.modelDimensions) return;
      let mid = 0;
      if (this.sliceAxis === 'Y') mid = this.modelDimensions.y / 2;
      else if (this.sliceAxis === 'X') mid = 0;
      else if (this.sliceAxis === 'Z') mid = 0;

      offsetSlider.value = mid;
      this.sliceOffset = mid;
      offsetVal.textContent = `${mid.toFixed(1)} mm`;
      this.viewer.setSlicePlane(this.sliceAxis, this.sliceOffset, this.tiltX, this.tiltY);
    });

    // 6. 连接件类型切换胶囊
    document.querySelectorAll('.connector-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.connector-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.connectorType = btn.dataset.type;

        document.getElementById('magnet-options').style.display = this.connectorType === 'magnet' ? 'block' : 'none';
        document.getElementById('dowel-options').style.display = this.connectorType === 'dowel' ? 'block' : 'none';
      });
    });

    // 7. 连接件规格切换
    document.getElementById('magnet-select').addEventListener('change', (e) => {
      this.currentMagnet = MAGNET_PRESETS.find(m => m.id === e.target.value) || MAGNET_PRESETS[0];
    });
    document.getElementById('dowel-select').addEventListener('change', (e) => {
      this.currentDowel = DOWEL_PRESETS.find(d => d.id === e.target.value) || DOWEL_PRESETS[0];
    });

    // 8. 布局方式
    document.getElementById('placement-select').addEventListener('change', (e) => {
      this.placementMode = e.target.value;
    });

    // 9. 公差调节
    document.getElementById('clearance-input').addEventListener('input', (e) => {
      this.clearance = parseFloat(e.target.value) || 0.2;
    });

    // 10. 执行切分
    document.getElementById('btn-execute-slice').addEventListener('click', () => this.executeSlice());

    // 11. 重置/重新调整
    document.getElementById('btn-reset-slice').addEventListener('click', () => {
      document.getElementById('export-card').style.display = 'none';
      document.getElementById('slice-config-card').style.display = 'block';
      this.viewer.clearCutParts();
      this.viewer.modelGroup.visible = true;
      this.viewer.setSlicePlaneVisible(true);
    });

    // 12. 爆炸视图分离滑块
    const explodeSlider = document.getElementById('explode-slider');
    explodeSlider.addEventListener('input', (e) => {
      const dist = parseFloat(e.target.value);
      const planeDef = this.viewer.getPlaneDefinition();
      this.viewer.setExplode(dist > 0, planeDef.normal, dist);
    });

    // 13. 一键平放打印床
    document.getElementById('btn-lay-flat').addEventListener('click', () => {
      const planeDef = this.viewer.getPlaneDefinition();
      this.viewer.layFlatOnBed(planeDef.normal);
    });

    // 14. 恢复拼合
    document.getElementById('btn-reset-assemble').addEventListener('click', () => {
      this.viewer.resetAssembleState();
      explodeSlider.value = 0;
    });

    // 15. 下载 Part A / Part B STL (支持 Electron 原生保存对话框与 Web 降级)
    document.getElementById('btn-download-parta').addEventListener('click', async () => {
      if (!this.sliceResult) return;
      const buffer = STLUtils.exportBinarySTL(this.sliceResult.partA);
      const fileName = `${this.modelName}_PartA_切分件.stl`;
      if (window.electronAPI && window.electronAPI.saveSTL) {
        await window.electronAPI.saveSTL(fileName, buffer);
      } else {
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        STLUtils.downloadBlob(blob, fileName);
      }
    });
    document.getElementById('btn-download-partb').addEventListener('click', async () => {
      if (!this.sliceResult) return;
      const buffer = STLUtils.exportBinarySTL(this.sliceResult.partB);
      const fileName = `${this.modelName}_PartB_切分件.stl`;
      if (window.electronAPI && window.electronAPI.saveSTL) {
        await window.electronAPI.saveSTL(fileName, buffer);
      } else {
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        STLUtils.downloadBlob(blob, fileName);
      }
    });

    // 16. 一键打包 ZIP
    document.getElementById('btn-download-zip').addEventListener('click', () => this.exportZIP());

    // 17. 弹出装配 BOM 说明书
    document.getElementById('btn-show-bom').addEventListener('click', () => this.showBOMModal());
    document.getElementById('modal-close-btn').addEventListener('click', () => {
      document.getElementById('bom-modal').classList.remove('show');
    });
  }

  async loadSample(sample) {
    this.modelName = sample.name.split(' ')[0];
    document.getElementById('current-model-name').textContent = this.modelName;

    try {
      const response = await fetch(sample.url);
      const arrayBuffer = await response.arrayBuffer();
      this.processLoadedModel(arrayBuffer);
    } catch (err) {
      console.error('加载示例失败:', err);
      alert('加载示例文件失败，请检查网络或刷新');
    }
  }

  async handleFileUpload(file) {
    this.modelName = file.name.replace(/\.[^/.]+$/, '');
    document.getElementById('current-model-name').textContent = this.modelName;

    const arrayBuffer = await file.arrayBuffer();
    this.processLoadedModel(arrayBuffer);
  }

  processLoadedModel(arrayBuffer) {
    // 1. 解析 STL
    const parsed = STLUtils.parse(arrayBuffer);
    this.rawPositions = parsed.positions;

    // 2. 渲染到视口
    const bounds = this.viewer.displayOriginalModel(this.rawPositions);
    this.modelDimensions = bounds.size;

    // 3. 更新尺寸与状态分析
    this.checkModelDimensions();

    // 4. 重置切割平面到物体正中
    this.updateSlicePlaneLimits();
    document.getElementById('btn-center-cut').click();

    // 5. 恢复切片配置面板
    document.getElementById('export-card').style.display = 'none';
    document.getElementById('slice-config-card').style.display = 'block';
  }

  /**
   * 尺寸与打印机成型体积比对
   */
  checkModelDimensions() {
    if (!this.modelDimensions) return;

    const { x, y, z } = this.modelDimensions;
    const pSize = this.currentPrinter.size;

    document.getElementById('model-dim-x').textContent = `${x.toFixed(1)} mm`;
    document.getElementById('model-dim-y').textContent = `${y.toFixed(1)} mm`;
    document.getElementById('model-dim-z').textContent = `${z.toFixed(1)} mm`;

    // 检查是否超出打印床
    // 模型底面在 X-Z 平面，高度为 Y
    const isOverX = x > pSize.x;
    const isOverY = y > pSize.z; // Y 是高度
    const isOverZ = z > pSize.y; // Z 是横深
    const isOverLimit = isOverX || isOverY || isOverZ;

    const alertCard = document.getElementById('printer-alert-card');
    const alertTitle = document.getElementById('alert-title');
    const alertReason = document.getElementById('alert-reason');

    if (isOverLimit) {
      alertCard.classList.add('overlimit');
      const overAxes = [];
      if (isOverX) overAxes.push(`X轴(${x.toFixed(1)} > ${pSize.x}mm)`);
      if (isOverY) overAxes.push(`高度Y轴(${y.toFixed(1)} > ${pSize.z}mm)`);
      if (isOverZ) overAxes.push(`Z深(${z.toFixed(1)} > ${pSize.y}mm)`);

      alertTitle.innerHTML = `⚠️ 严重超出当前机型 (${this.currentPrinter.name}) 成型空间 <span class="tag-overlimit">必需切分</span>`;
      alertReason.textContent = `超限详情: ${overAxes.join('、')}。建议沿超限长轴下刀，分件后可分别放入打印床。`;
    } else {
      alertCard.classList.remove('overlimit');
      alertTitle.innerHTML = `✅ 尺寸可容纳于 (${this.currentPrinter.name}) <span class="tag-fit">无需切分亦可打印</span>`;
      alertReason.textContent = `当前模型尺寸适合一体打印，您也可以切分为两件以便无支撑打孔、埋入强磁或做双色分件。`;
    }
  }

  /**
   * 动态更新滑块范围
   */
  updateSlicePlaneLimits() {
    if (!this.modelDimensions) return;
    const slider = document.getElementById('slice-offset-slider');
    let min = 0, max = 100;

    if (this.sliceAxis === 'Y') {
      min = 0;
      max = this.modelDimensions.y;
    } else if (this.sliceAxis === 'X') {
      min = -this.modelDimensions.x / 2;
      max = this.modelDimensions.x / 2;
    } else {
      min = -this.modelDimensions.z / 2;
      max = this.modelDimensions.z / 2;
    }

    slider.min = min.toFixed(1);
    slider.max = max.toFixed(1);
    slider.step = ((max - min) / 200).toFixed(2);
  }

  /**
   * 核心切片执行
   */
  executeSlice() {
    if (!this.rawPositions) {
      alert('请先上传或选择一个 3D 模型！');
      return;
    }

    const btn = document.getElementById('btn-execute-slice');
    btn.disabled = true;
    btn.innerHTML = `<span class="pulse">⚙️ 正在毫秒级切分与打孔...</span>`;

    setTimeout(() => {
      try {
        const planeDef = this.viewer.getPlaneDefinition();

        const connectorConfig = {
          type: this.connectorType,
          placement: this.placementMode,
          magnet: {
            diameter: this.currentMagnet.diameter,
            depth: this.currentMagnet.depth,
            clearance: this.clearance
          },
          dowel: {
            shape: this.currentDowel.shape,
            diameter: this.currentDowel.diameter,
            length: this.currentDowel.length,
            clearance: this.clearance
          }
        };

        const result = ModelSlicer.slice(this.rawPositions, planeDef, connectorConfig, this.earcut);
        this.sliceResult = result;

        // 渲染切分产物并开启爆炸视效
        this.viewer.displayCutParts(result.partA, result.partB, result.connectorPoints, planeDef);

        // 切换 UI
        document.getElementById('slice-config-card').style.display = 'none';
        document.getElementById('export-card').style.display = 'block';

        // 更新状态卡
        document.getElementById('stat-cut-info').innerHTML = `切分完成! 耗时: <strong>${result.elapsedMs}ms</strong> | 三角面: <strong>${(result.partA.length + result.partB.length)/9}</strong> | 连接孔: <strong>${result.connectorCount} 处</strong>`;

      } catch (err) {
        console.error('切片执行异常:', err);
        alert('切片运算遇到特殊拓扑，请尝试微调切面位置或倾角再试一次。');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `⚡ 立即切分并生成连接件`;
      }
    }, 50);
  }

  /**
   * 打包 ZIP 交付
   */
  async exportZIP() {
    if (!this.sliceResult) return;

    const btn = document.getElementById('btn-download-zip');
    btn.disabled = true;
    btn.textContent = '📦 正在打包 ZIP 与装配指南...';

    try {
      const bufferA = STLUtils.exportBinarySTL(this.sliceResult.partA);
      const bufferB = STLUtils.exportBinarySTL(this.sliceResult.partB);

      const base64A = STLUtils.bufferToBase64(bufferA);
      const base64B = STLUtils.bufferToBase64(bufferB);

      const payload = {
        modelName: this.modelName,
        partADataUrl: base64A,
        partBDataUrl: base64B,
        metadata: {
          connectorType: this.connectorType,
          connectorName: this.connectorType === 'magnet' ? this.currentMagnet.name : this.currentDowel.name,
          diameter: this.connectorType === 'magnet' ? this.currentMagnet.diameter : this.currentDowel.diameter,
          depth: this.connectorType === 'magnet' ? this.currentMagnet.depth : this.currentDowel.length,
          clearance: this.clearance,
          holeCount: this.sliceResult.connectorCount
        }
      };

      const res = await fetch('/api/package-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('后端打包失败');

      const blob = await res.blob();
      STLUtils.downloadBlob(blob, `${this.modelName}_SnapCut_Parts.zip`);

    } catch (err) {
      console.error('ZIP 打包异常:', err);
      // 降级为直接下载两个 STL
      alert('网络连接异常，为您直接下载两个独立切片文件');
      document.getElementById('btn-download-parta').click();
      document.getElementById('btn-download-partb').click();
    } finally {
      btn.disabled = false;
      btn.textContent = '📦 一键打包全部零件与BOM (ZIP)';
    }
  }

  showBOMModal() {
    if (!this.sliceResult) return;
    const modal = document.getElementById('bom-modal');
    const content = document.getElementById('bom-content');

    const isMag = this.connectorType === 'magnet';
    const spec = isMag ? this.currentMagnet : this.currentDowel;
    const count = this.sliceResult.connectorCount;

    content.innerHTML = `
      <h3 style="color:var(--primary);margin-bottom:10px;">📋 ${this.modelName} - 切片与装配清单 (BOM)</h3>
      <p><strong>切片零件:</strong></p>
      <ul>
        <li><code>${this.modelName}_PartA_切分件A.stl</code> (预留沉孔/凹槽)</li>
        <li><code>${this.modelName}_PartB_切分件B.stl</code> (预留沉孔/防呆公榫)</li>
      </ul>
      <br>
      <p><strong>连接构件规格:</strong></p>
      <ul>
        <li>类型: <span style="color:#60a5fa">${isMag ? '钕铁硼强力磁铁' : '3D一体成型榫卯'}</span></li>
        <li>规格: <strong>${spec.name}</strong></li>
        <li>打印公差预留补偿: <strong>+${this.clearance} mm</strong> (无需打磨，直接严丝合缝压入)</li>
        <li>所需数量: <strong>${isMag ? count * 2 : count} 处</strong></li>
      </ul>
      <br>
      <div style="background:#1a202c;padding:12px;border-radius:6px;border-left:4px solid var(--primary);">
        <strong>💡 创客装配小窍门:</strong><br>
        ${isMag ? `
        1. <strong>切记磁极测试:</strong> 压入前务必拿两颗磁铁对吸一下，标记好极性，防止 A/B 件装反相斥！<br>
        2. <strong>固定推荐:</strong> 涂一滴 401 瞬干胶或环氧树脂于孔底即可达到永久坚固固定。<br>
        3. <strong>打印建议:</strong> 切面朝下平放在打印床打印，外壁圈数设为 3~4 圈保证孔壁强度。
        ` : `
        1. <strong>防呆结构:</strong> D 型截面杜绝旋转扭曲，插拔方向唯一。<br>
        2. <strong>倒角引导:</strong> 凸台顶端设计有 1mm 45° 倒角，拼插时自动导正，顺滑自锁。
        `}
      </div>
    `;

    modal.classList.add('show');
  }
}

// 启动应用
window.addEventListener('DOMContentLoaded', () => {
  window.app = new SnapCutApp();
});
