import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as arch from 'archiver';

const require = createRequire(import.meta.url);
const multer = require('multer');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3008;

// 中间件配置
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 确保目录存在
const uploadsDir = path.join(__dirname, 'uploads');
const samplesDir = path.join(__dirname, 'public', 'samples');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(samplesDir)) fs.mkdirSync(samplesDir, { recursive: true });

// 配置文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E6);
    const ext = path.extname(file.originalname) || '.stl';
    cb(null, 'model-' + uniqueSuffix + ext);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// 打印机机型预设库
const PRINTER_PRESETS = [
  {
    id: 'bambu-a1-mini',
    brand: '拓竹 (Bambu Lab)',
    name: 'A1 mini',
    size: { x: 180, y: 180, z: 180 },
    shape: 'box',
    description: '入门爆款，180mm 尺寸受限，绝大多数大件必需切分'
  },
  {
    id: 'bambu-p1-x1-a1',
    brand: '拓竹 (Bambu Lab)',
    name: 'P1S / X1C / A1',
    size: { x: 256, y: 256, z: 256 },
    shape: 'box',
    description: '主流旗舰标配 256mm 打印立方体'
  },
  {
    id: 'creality-ender3',
    brand: '创想三维 (Creality)',
    name: 'Ender-3 / V3 / KE 系列',
    size: { x: 220, y: 220, z: 250 },
    shape: 'box',
    description: '最经典的普及型 220mm 打印机'
  },
  {
    id: 'anycubic-kobra2',
    brand: '纵维立方 (Anycubic)',
    name: 'Kobra 2 / 3 系列',
    size: { x: 250, y: 250, z: 260 },
    shape: 'box',
    description: '常见高性价比中型机'
  },
  {
    id: 'bambu-large',
    brand: '大尺寸工业/大容积',
    name: '大尺寸 (300³ mm)',
    size: { x: 300, y: 300, z: 300 },
    shape: 'box',
    description: '300mm 以上大型机型'
  }
];

// 市售常用强磁与连接件规格库
const CONNECTOR_PRESETS = {
  magnets: [
    {
      id: 'mag-6x3',
      name: 'φ6 × 3 mm (圈内首选·推荐)',
      diameter: 6.0,
      depth: 3.0,
      recommendedClearance: 0.2,
      holdingForce: '中高吸力 (~0.8kg)',
      usage: '手办/面具/道具首选，体积小吸力强，淘宝/拼多多最易采购'
    },
    {
      id: 'mag-5x2',
      name: 'φ5 × 2 mm (超薄小件)',
      diameter: 5.0,
      depth: 2.0,
      recommendedClearance: 0.15,
      holdingForce: '中等吸力 (~0.4kg)',
      usage: '薄壁模型、小型装饰件、可动关节'
    },
    {
      id: 'mag-8x2',
      name: 'φ8 × 2 mm (扁平强吸)',
      diameter: 8.0,
      depth: 2.0,
      recommendedClearance: 0.2,
      holdingForce: '高吸力 (~1.2kg)',
      usage: '大型切面、平整底座、重型道具'
    },
    {
      id: 'mag-10x3',
      name: 'φ10 × 3 mm (超强磁吸)',
      diameter: 10.0,
      depth: 3.0,
      recommendedClearance: 0.25,
      holdingForce: '极强吸力 (>2.0kg)',
      usage: '大宝剑/长刀切件、承重构件'
    }
  ],
  dowels: [
    {
      id: 'dowel-round-8',
      name: '圆柱定位销 (φ8 × 12mm)',
      shape: 'cylinder',
      diameter: 8.0,
      length: 12.0,
      chamfer: 1.0,
      clearance: 0.2,
      description: '经典圆销，公母槽配合'
    },
    {
      id: 'dowel-keyed-d',
      name: 'D型截面防呆销 (φ8 × 12mm)',
      shape: 'd-shape',
      diameter: 8.0,
      length: 12.0,
      chamfer: 1.0,
      clearance: 0.2,
      description: '单边切平，彻底杜绝旋转与反向误装'
    },
    {
      id: 'dowel-square-8',
      name: '方榫定位榫 (8 × 8 × 12mm)',
      shape: 'square',
      width: 8.0,
      length: 12.0,
      chamfer: 1.0,
      clearance: 0.2,
      description: '榫卯结构，强抗扭刚度'
    }
  ]
};

// API 路由
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), app: 'SnapCut-3D' });
});

app.get('/api/printers', (req, res) => {
  res.json(PRINTER_PRESETS);
});

app.get('/api/magnets', (req, res) => {
  res.json(CONNECTOR_PRESETS);
});

app.get('/api/samples', (req, res) => {
  const sampleList = [
    {
      id: 'cyber-blade-hilt',
      name: '赛博短剑/光剑手柄 (长290mm)',
      filename: 'cyber-blade-hilt.stl',
      size: '290 × 64 × 36 mm',
      overLimitReason: '长度 290mm 严重超出 A1 mini(180mm) 及 P1/X1(256mm)',
      recommendation: '建议在 Z 轴 145mm 处切断，加配 2 颗 φ6×3mm 强磁或 D 型防呆榫'
    },
    {
      id: 'mecha-helmet-mask',
      name: '机甲面具/头盔零件 (高230mm)',
      filename: 'mecha-helmet-mask.stl',
      size: '210 × 160 × 230 mm',
      overLimitReason: '高 230mm、宽 210mm 无法放进 A1 mini',
      recommendation: '沿冠状面或水平切为上下两半，切面打磁铁孔实现快拆'
    },
    {
      id: 'modular-storage-bin',
      name: '超宽模块收纳盒 (长270mm)',
      filename: 'modular-storage-bin.stl',
      size: '270 × 140 × 85 mm',
      overLimitReason: '长 270mm 超出 256mm 打印机',
      recommendation: '从中间对称切分为左右双件，榫卯拼接'
    }
  ];
  res.json(sampleList);
});

// 文件上传
app.post('/api/upload', upload.single('model'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未检测到上传文件' });
  }
  res.json({
    message: '上传成功',
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    url: '/uploads/' + req.file.filename
  });
});
app.use('/uploads', express.static(uploadsDir));

// 一键导出 ZIP 包 (包含 Part A、Part B 与 BOM 清单)
app.post('/api/package-zip', (req, res) => {
  const {
    partADataUrl,
    partBDataUrl,
    modelName = 'Model',
    metadata = {}
  } = req.body;

  if (!partADataUrl || !partBDataUrl) {
    return res.status(400).json({ error: '缺少切分部件数据' });
  }

  // 解码 base64
  const bufferA = Buffer.from(partADataUrl.replace(/^data:.*?;base64,/, ''), 'base64');
  const bufferB = Buffer.from(partBDataUrl.replace(/^data:.*?;base64,/, ''), 'base64');

  const cleanName = (modelName || 'Model').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_');
  const zipFileName = `${cleanName}_SnapCut_Parts.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFileName)}"`);

  // 使用 ZipArchive 实例
  const archive = new arch.ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => {
    res.status(500).send({ error: err.message });
  });
  archive.pipe(res);

  // 添加 STL 文件
  archive.append(bufferA, { name: `${cleanName}_PartA_切分件A.stl` });
  archive.append(bufferB, { name: `${cleanName}_PartB_切分件B.stl` });

  // 生成打印与装配指南 BOM
  const guideText = `=====================================================
 SnapCut 3D - 3D打印大模型分件切片与装配指南 (BOM)
=====================================================
生成时间: ${new Date().toLocaleString('zh-CN')}
源模型名称: ${cleanName}

【分件清单】
1. ${cleanName}_PartA_切分件A.stl
2. ${cleanName}_PartB_切分件B.stl

【连接件规格与装配说明】
连接件类型: ${metadata.connectorType || '磁铁沉孔 / 榫卯定位'}
定位孔/槽参数:
  - 规格: ${metadata.connectorName || '默认标准孔'}
  - 标称直径: ${metadata.diameter || 6} mm
  - 深度: ${metadata.depth || 3} mm
  - 打印公差补偿 (Clearance): +${metadata.clearance || 0.2} mm
  - 孔位数量: ${metadata.holeCount || 2} 处

【耗材与配件采购建议】
${metadata.connectorType === 'magnet' ? `
* 请采购对应规格的钕铁硼强力磁铁 (例如 N35/N52 材质):
  - 规格: 直径 ${metadata.diameter}mm × 厚度 ${metadata.depth}mm
  - 所需数量: ${metadata.holeCount * 2} 颗 (A件与B件各 ${metadata.holeCount} 颗)
* 安装技巧:
  1. 安装磁铁前，务必先测试两端磁极方向（确保 A 件与 B 件靠近时能够自动吸合，而不是相斥）！
  2. 建议在孔底点涂一小滴 401 胶水或快干环氧树脂胶，再压入磁铁。
  3. 若打印机存在轻微挤出过量导致偏紧，可用电烙铁微热或用六角扳手轻压压入。
` : `
* 榫卯定位销装配:
  1. A 件为凹槽 (Socket)，B 件为凸台 (Pin)；
  2. 已在公槽外缘加入了 45° 引导倒角，且凹槽内径预留了 0.2mm 打印间隙；
  3. 无需额外五金件，打印完成后直接对准插入即可卡紧定位；若需永久固定，可辅以适量胶水。
`}

【3D 切片与打印参数建议】
1. 摆放方向: 推荐将切面作为底面贴合在打印床 (已提供一键平放功能)，以获得最佳附着力并免去多余支撑。
2. 壁厚 / 圈数: 建议外壁圈数 >= 3 圈 (1.2mm 以上)，确保孔洞周围具有足够的力学强度。
3. 填充率: 推荐 15% ~ 25% 陀螺线 (Gyroid) 或自适应立方体填充。

感谢使用 SnapCut 3D - 让小打印机也能制作宏伟巨制！
=====================================================
`;
  archive.append(guideText, { name: '装配指南与五金采购清单_BOM.txt' });

  archive.finalize();
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SnapCut 3D] 服务已成功启动: http://localhost:${PORT}`);
  console.log(`[SnapCut 3D] 静态文件服务根目录: ${path.join(__dirname, 'public')}`);
});

export default app;
