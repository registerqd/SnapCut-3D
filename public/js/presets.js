/**
 * SnapCut 3D - 预设数据库 (机型、磁铁、榫卯参数)
 */

export const PRINTER_PRESETS = [
  {
    id: 'bambu-a1-mini',
    brand: '拓竹 (Bambu Lab)',
    name: 'A1 mini',
    size: { x: 180, y: 180, z: 180 },
    shape: 'box',
    color: '#00AE42',
    description: '入门爆款，180mm 尺寸受限，绝大多数大件必需切分'
  },
  {
    id: 'bambu-p1-x1-a1',
    brand: '拓竹 (Bambu Lab)',
    name: 'P1S / X1C / A1',
    size: { x: 256, y: 256, z: 256 },
    shape: 'box',
    color: '#00AE42',
    description: '主流旗舰标配 256mm 打印立方体'
  },
  {
    id: 'creality-ender3',
    brand: '创想三维 (Creality)',
    name: 'Ender-3 / V3 / KE',
    size: { x: 220, y: 220, z: 250 },
    shape: 'box',
    color: '#0066CC',
    description: '最经典的普及型 220mm 打印机'
  },
  {
    id: 'anycubic-kobra2',
    brand: '纵维立方 (Anycubic)',
    name: 'Kobra 2 / 3 系列',
    size: { x: 250, y: 250, z: 260 },
    shape: 'box',
    color: '#FF6600',
    description: '常见高性价比中型机'
  },
  {
    id: 'custom',
    brand: '自定义尺寸',
    name: '自定义打印床...',
    size: { x: 200, y: 200, z: 200 },
    shape: 'box',
    color: '#888888',
    description: '自定义 X / Y / Z 成型体积'
  }
];

export const MAGNET_PRESETS = [
  {
    id: 'mag-6x3',
    name: 'φ6 × 3 mm (圈内首选·推荐)',
    diameter: 6.0,
    depth: 3.0,
    recommendedClearance: 0.2,
    holdingForce: '中高吸力 (~0.8kg)',
    usage: '手办/面具/道具首选，淘宝/拼多多采购最方便'
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
    name: 'φ10 × 3 mm (超强吸力)',
    diameter: 10.0,
    depth: 3.0,
    recommendedClearance: 0.25,
    holdingForce: '极强吸力 (>2.0kg)',
    usage: '大宝剑/长刀切件、承重构件'
  }
];

export const DOWEL_PRESETS = [
  {
    id: 'dowel-keyed-d',
    name: 'D型截面防呆销 (推荐·防反插)',
    shape: 'd-shape',
    diameter: 8.0,
    length: 12.0,
    chamfer: 1.0,
    clearance: 0.2,
    description: '单边切平，彻底杜绝旋转与反向误装'
  },
  {
    id: 'dowel-round-8',
    name: '经典圆柱销 (φ8 × 12mm)',
    shape: 'cylinder',
    diameter: 8.0,
    length: 12.0,
    chamfer: 1.0,
    clearance: 0.2,
    description: '标准圆柱公母配合'
  },
  {
    id: 'dowel-square-8',
    name: '方榫定位榫 (8 × 8 × 12mm)',
    shape: 'square',
    width: 8.0,
    length: 12.0,
    chamfer: 1.0,
    clearance: 0.2,
    description: '高抗扭刚度方榫'
  }
];

export const SAMPLES = [
  {
    id: 'cyber-blade-hilt',
    name: '赛博短剑/光剑手柄 (长290mm)',
    filename: 'cyber-blade-hilt.stl',
    url: './samples/cyber-blade-hilt.stl',
    tag: '长轴超限',
    desc: '长度 290mm 无法放进 A1 mini(180) 和 P1S(256)，建议沿 Z 轴居中切断加配磁吸'
  },
  {
    id: 'mecha-helmet-mask',
    name: '机甲面具/头盔零件 (高230mm)',
    filename: 'mecha-helmet-mask.stl',
    url: './samples/mecha-helmet-mask.stl',
    tag: '立高超限',
    desc: '高 230mm、宽 210mm 无法放进 A1 mini，建议水平切分，切面打磁铁孔实现快拆装配'
  },
  {
    id: 'modular-storage-bin',
    name: '超宽模块收纳盒 (长270mm)',
    filename: 'modular-storage-bin.stl',
    url: './samples/modular-storage-bin.stl',
    tag: '横向超限',
    desc: '长 270mm 超出 256mm 打印机，建议从中间对称切分为左右双件，榫卯拼接'
  }
];
