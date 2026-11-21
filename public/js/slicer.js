/**
 * SnapCut 3D - 核心几何切割与磁吸/榫卯连接件算法引擎
 * 纯数学解析解与 Earcut 拓扑重建，无第三方重型依赖，毫秒级快速运行
 */

export class ModelSlicer {
  /**
   * 切割模型主入口
   * @param {Float32Array} positions - 原始模型的三角形顶点数组 (每9个float为一个三角形)
   * @param {Object} planeDef - 切割平面定义 { normal: [nx, ny, nz], point: [px, py, pz] }
   * @param {Object} connectorConfig - 连接件配置 (磁铁/榫卯规格与布局)
   * @param {Function} earcut - earcut 三角剖分函数
   */
  static slice(positions, planeDef, connectorConfig, earcut) {
    const startTime = performance.now();

    // 0. 自检容器：非法输入不再静默兜底，必须让用户看到原因
    const warnings = [];

    // 连接件配置兜底：旧实现后面直接读 connectorConfig.type，传入 null 会抛
    // 「Cannot read properties of null」，整次切分被打断，用户只看到「切割失败」，
    // 完全不知道是没选连接件。这里统一归一到 { type:'none' } 并给出提示。
    if (connectorConfig === null || connectorConfig === undefined) {
      connectorConfig = { type: 'none' };
    } else if (typeof connectorConfig !== 'object' || Array.isArray(connectorConfig)) {
      warnings.push('连接件配置格式不正确，本次按「不加工连接件」切分');
      connectorConfig = { type: 'none' };
    } else if (!connectorConfig.type) {
      // 缺 type 字段时旧实现既不打孔也不提示，用户拿到一块光面零件还以为打好了
      connectorConfig = { ...connectorConfig, type: 'none' };
    } else if (!['none', 'magnet', 'dowel'].includes(connectorConfig.type)) {
      // type 拼错（如 'magnets'）时旧实现会切出光面零件、BOM 为空，却一句提示都没有
      warnings.push(`未知的连接件类型「${connectorConfig.type}」，本次按「不加工连接件」切分`);
      connectorConfig = { ...connectorConfig, type: 'none' };
    }

    // 1. 归一化平面法向与计算截距 D
    const rawN = planeDef && Array.isArray(planeDef.normal) ? planeDef.normal : [0, 0, 1];
    const rawP = planeDef && Array.isArray(planeDef.point) ? planeDef.point : [0, 0, 0];
    const nFinite = rawN.length >= 3 && rawN.slice(0, 3).every(v => Number.isFinite(v));
    const pFinite = rawP.length >= 3 && rawP.slice(0, 3).every(v => Number.isFinite(v));

    // 平面定义非法时不能带着 NaN 往下算：NaN 会让所有带符号距离都变成 NaN，
    // 两个顶点符号全判成「共面」，结果是把整个模型原样塞进两侧零件、且不生成封盖，
    // 用户只看到「轮廓未闭合」，完全猜不到真正原因是切割点坐标非法。
    let n, p0;
    if (!nFinite) {
      warnings.push('切割平面法向无效（含非法数值或零向量），已临时按 Z 轴方向切分，请在视图里重新摆正切面');
      n = [0, 0, 1];
    } else {
      const rawLen = Math.hypot(rawN[0], rawN[1], rawN[2]);
      if (!(rawLen > 1e-8)) {
        warnings.push('切割平面法向无效（零向量），已临时按 Z 轴方向切分，请在视图里重新摆正切面');
      }
      n = this.normalize(rawN);
    }
    if (!pFinite) {
      warnings.push('切割平面位置坐标非法（含 NaN/Infinity），已临时按模型包围盒中心切分，请重新设置切面位置');
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = positions[i + k];
          if (!Number.isFinite(v)) continue;
          if (v < mn[k]) mn[k] = v;
          if (v > mx[k]) mx[k] = v;
        }
      }
      p0 = [0, 1, 2].map(k => (Number.isFinite(mn[k]) && Number.isFinite(mx[k]) ? (mn[k] + mx[k]) / 2 : 0));
    } else {
      p0 = [rawP[0], rawP[1], rawP[2]];
    }
    // 平面方程: n[0]*x + n[1]*y + n[2]*z + D = 0
    const D = -(n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2]);

    // 模型顶点非法（NaN/Infinity）：这类顶点参与运算会污染整条链路，
    // 输出里出现 NaN 坐标后 STL 会写成非法文件、切片软件直接报错。
    // 做法是统计后剔除含非法坐标的三角形，并明确告知用户有多少面被跳过。
    let badTriangles = 0;
    if (positions.length % 9 !== 0) {
      warnings.push(`模型顶点数组长度不是 9 的整数倍（${positions.length} 个分量），末尾不足一个三角形的数据已忽略`);
    }
    const rawTriCount = Math.floor(positions.length / 9);
    for (let i = 0; i < rawTriCount * 9; i++) {
      if (!Number.isFinite(positions[i])) { badTriangles = -1; break; }
    }
    let src = positions;
    if (badTriangles === -1) {
      const clean = [];
      for (let t = 0; t < rawTriCount; t++) {
        const o = t * 9;
        let ok = true;
        for (let k = 0; k < 9; k++) if (!Number.isFinite(positions[o + k])) { ok = false; break; }
        if (!ok) { badTriangles++; continue; }
        for (let k = 0; k < 9; k++) clean.push(positions[o + k]);
      }
      if (badTriangles > 0) {
        warnings.push(`模型中有 ${badTriangles} 个三角形含非法坐标（NaN/Infinity），已跳过这些面；若零件出现缺口请回建模软件检查模型`);
      }
      src = new Float32Array(clean);
    } else {
      badTriangles = 0;
    }

    const numTriangles = Math.floor(src.length / 9);

    // 临时存储正侧 (A) 和负侧 (B) 的三角面顶点
    const trianglesA = [];
    const trianglesB = [];

    // 收集截面上生成的交线段
    const cutSegments = [];

    // 共面容差按模型尺度自适应：大模型固定 1e-5 会把近似共面的顶点误判到某一侧，
    // 微型件（1mm 级）又会让真正的交点被当成共面点。取包围盒对角线的 1e-7，限制在 [1e-7, 1e-3]。
    let bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const val = positions[i + k];
        if (val < bbMin[k]) bbMin[k] = val;
        if (val > bbMax[k]) bbMax[k] = val;
      }
    }
    const diag = Math.hypot(bbMax[0] - bbMin[0], bbMax[1] - bbMin[1], bbMax[2] - bbMin[2]);
    const eps = Math.min(1e-3, Math.max(1e-7, diag * 1e-7));

    // 模型整体绕向（法线朝外 / 朝内）：用有向体积的符号判定。
    // 不少 STL 导出器、扫描件、翻转过的模型整体法线是朝内的，外壳三角面绕向全反。
    // 封盖若仍按固定方向生成，就会和外壳绕向相反 —— 切出来的零件在接缝处出现
    // 同向重复边（非流形），体积算不对，切片软件直接报错。这里先判定再据此翻转封盖。
    let signedVol = 0;
    for (let i = 0; i < numTriangles; i++) {
      const o = i * 9;
      const ax = src[o], ay = src[o + 1], az = src[o + 2];
      const bx = src[o + 3], by = src[o + 4], bz = src[o + 5];
      const cx = src[o + 6], cy = src[o + 7], cz = src[o + 8];
      signedVol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    const modelOutward = signedVol >= 0;
    if (numTriangles > 0 && !modelOutward) {
      warnings.push('模型三角面绕向整体朝内（法线反了，常见于部分 STL 导出器或翻转过的模型）：已自动按朝内绕向生成切面封盖以保证零件水密，如打印出现内外翻转请在建模软件里统一法线方向');
    }

    // 两侧零件沿切面法向的实际厚度：连接件（磁铁沉孔、榫卯销）不能比零件还厚，
    // 否则孔底/销尖会穿出零件外表面，打印出来是个对穿孔或穿模的销子。
    let thickA = 0, thickB = 0;
    // 恰好与切面共面的三角形（模型自身的面落在切面上），归属等厚度统计完再定
    const coplanarTris = [];
    // 该侧是否真的有实体紧贴切面。多实体叠放时（薄板压在方块上、切面只切薄板），
    // 另一侧实体的厚度会把 thickB 撑到 21.4mm，封盖会凭空长在那侧的空处，
    // 体积多出 1300 多 mm³ 的悬空面片。必须按侧判断有没有实体贴面。
    let touchA = false, touchB = false;
    // 切面与模型表面几乎重合的判定阈值：这一侧没有实体厚度，封盖不能再生成
    // （封盖会与外表面重合，体积算虚高、切片软件报非流形），零件本身也应当为空。
    const nearZero = Math.max(eps * 10, 1e-6);
    // 用于非水密检测：统计原始网格的边使用情况。
    // 量化精度固定 1μm：按 eps 量化会随模型尺度变化，大模型上同一顶点会被舍入到相邻
    // 格子里，凭空造出大量「开放边」（288mm 的样例模型曾误报 2240 条）。
    const edgeUse = new Map();
    const vkey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;

    for (let i = 0; i < numTriangles; i++) {
      const idx = i * 9;
      // 必须读清理后的 src：上面已把含 NaN/Infinity 的三角形剔除，
      // 若这里仍读原始 positions，非法坐标会一路穿透到裁剪、插值、封盖，
      // 导出 STL 里出现 NaN 顶点，切片软件直接打不开文件。
      const v0 = [src[idx], src[idx + 1], src[idx + 2]];
      const v1 = [src[idx + 3], src[idx + 4], src[idx + 5]];
      const v2 = [src[idx + 6], src[idx + 7], src[idx + 8]];

      // 计算三点到平面的带符号距离
      const d0 = n[0] * v0[0] + n[1] * v0[1] + n[2] * v0[2] + D;
      const d1 = n[0] * v1[0] + n[1] * v1[1] + n[2] * v1[2] + D;
      const d2 = n[0] * v2[0] + n[1] * v2[1] + n[2] * v2[2] + D;

      const s0 = d0 > eps ? 1 : (d0 < -eps ? -1 : 0);
      const s1 = d1 > eps ? 1 : (d1 < -eps ? -1 : 0);
      const s2 = d2 > eps ? 1 : (d2 < -eps ? -1 : 0);

      // 两侧厚度：正侧顶点到平面的最大距离就是 A 的厚度，负侧为 B 的厚度
      if (d0 > thickA) thickA = d0;
      if (d1 > thickA) thickA = d1;
      if (d2 > thickA) thickA = d2;
      if (-d0 > thickB) thickB = -d0;
      if (-d1 > thickB) thickB = -d1;
      if (-d2 > thickB) thickB = -d2;

      // 非水密检测：每条有向边记一次，配对成对才算封闭
      for (const [a, b] of [[v0, v1], [v1, v2], [v2, v0]]) {
        const key = vkey(a) + '|' + vkey(b);
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      }

      // 注意：只有「三个顶点都严格在同一侧」才能直接归档。
      // 旧实现用 s>=0 / s<=0，会把「两个顶点在平面上、一个在正侧」的三角形整片塞进 A 侧，
      // 而它那条棱正是截面边界 —— 边界被吞掉，斜切（切面穿过棱边）时环就闭合不了。
      if (s0 > 0 && s1 > 0 && s2 > 0) {
        trianglesA.push(...v0, ...v1, ...v2);
        continue;
      }
      if (s0 < 0 && s1 < 0 && s2 < 0) {
        trianglesB.push(...v0, ...v1, ...v2);
        continue;
      }
      // 整片贴在切割平面上：这是模型自身的面，正好与切面重合
      // （典型场景：一块 1.2mm 薄板底面正好落在切面上）。
      // 归属要等两侧厚度都统计完才能定，先收集起来。
      if (s0 === 0 && s1 === 0 && s2 === 0) {
        for (const v of [v0, v1, v2]) coplanarTris.push(v[0], v[1], v[2]);
        continue;
      }

      // 三角形被切割: 找出孤立点和对侧两个点
      const pts = [v0, v1, v2];
      const dists = [d0, d1, d2];
      const signs = [s0, s1, s2];

      // 这个三角形横跨切面或贴着切面，说明它所在的那一侧确实有实体紧贴切面
      const hasPos = s0 > 0 || s1 > 0 || s2 > 0;
      const hasNeg = s0 < 0 || s1 < 0 || s2 < 0;
      if (hasPos) touchA = true;
      if (hasNeg) touchB = true;

      this.splitTriangle(pts, dists, signs, trianglesA, trianglesB, cutSegments, eps);
    }

    // 共面三角形归属：
    // - 切面正好贴在模型外表面（某一侧厚度≈0）时，这一面就是实体的边界，
    //   必须保留给有实体那一侧，否则零件开口、有向体积算成 2000（应为 480）；
    // - 两侧都有实体时（多实体叠放，切面穿过其中一块的端面），封盖会在同一位置
    //   重建这一层表面，原始面必须丢弃，否则重复面让体积翻倍/变负（实测 -1051.88）。
    if (coplanarTris.length > 0) {
      const target = thickA <= nearZero ? trianglesB : (thickB <= nearZero ? trianglesA : null);
      if (target) {
        for (let i = 0; i < coplanarTris.length; i += 4096) {
          target.push(...coplanarTris.slice(i, i + 4096));
        }
      }
    }

    // 2. 建立切割平面的局部 2D 坐标系 (U, V)
    const { uAxis, vAxis } = this.createPlaneBasis(n);

    // 3. 将 3D 交线段投影为 2D 线段，并缝合为闭合多边形环 (Polygon Loops)
    //    切面穿过模型棱边时同一条棱会被相邻三角形各收集一次，先去重再拼接
    const uniqueSegments = this.dedupeSegments(cutSegments, eps);
    const loops = this.stitchSegmentsToLoops(uniqueSegments, p0, uAxis, vAxis);

    // 4. 计算连接件的锚点 (Anchor Points)
    const connectorPoints = this.determineConnectorPositions(loops, connectorConfig);

    // 4.1 每个孔位处的局部壁厚：沿切面法向从孔位打一条射线到零件外表面。
    // 斜切件（刀身、斜角壳体、梯形块）沿法向的局部厚度可能只有 1~2mm，
    // 而全局最大厚度有十几毫米；孔深若按全局厚度算，孔底会直接挖穿零件，
    // 打印出来是对穿孔、磁铁从背面露出来。实测 45° 斜切 20³ 打 φ6×3 磁铁，
    // 孔底顶点 z 达 10.13（模型只到 10），零件上被捅了个洞。
    const localThickA = new Map();
    const localThickB = new Map();
    const kkey = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    // 不能只测孔中心：孔腔是半径 r 的圆柱，孔壁边缘可能比中心早 2mm 就撞到斜边。
    // 实测 45° 斜切 20³ 打 φ6 磁铁，中心线到外表面还有 6.2mm（够深），
    // 但孔底圆盘边缘的 z 达 10.13（模型只到 10），零件上被捅了个小洞。
    // 因此在孔位周围按半径采样一圈，取最小壁厚作为该孔可用深度。
    const probeR = (connectorConfig && connectorConfig.type === 'magnet'
      ? (connectorConfig.magnet?.diameter || 6)
      : (connectorConfig?.dowel?.diameter || 6)) / 2 + 0.2;
    for (const [cu, cv] of connectorPoints) {
      let tA = Infinity, tB = Infinity;
      for (let a = 0; a < 9; a++) {
        const ang = (a * Math.PI) / 4;
        const su = a === 8 ? cu : cu + Math.cos(ang) * probeR;
        const sv = a === 8 ? cv : cv + Math.sin(ang) * probeR;
        const o = this.to3D(su, sv, p0, uAxis, vAxis);
        tA = Math.min(tA, this.rayThickness(trianglesA,
          [o[0] + n[0] * 1e-4, o[1] + n[1] * 1e-4, o[2] + n[2] * 1e-4], n));
        tB = Math.min(tB, this.rayThickness(trianglesB,
          [o[0] - n[0] * 1e-4, o[1] - n[1] * 1e-4, o[2] - n[2] * 1e-4],
          [-n[0], -n[1], -n[2]]));
      }
      localThickA.set(kkey([cu, cv]), tA);
      localThickB.set(kkey([cu, cv]), tB);
    }

    // 5. 生成切面封盖网格与连接件孔洞/凸台
    //    厚度≈0 的那一侧（切面正好贴在模型表面）传 0，让封盖生成逻辑整侧跳过：
    //    否则封盖会与模型外表面重合，出现重复面、体积虚高、切片软件报非流形。
    const { capFacesA, capFacesB, connectorBOM, connWarnings } = this.generateCapsAndConnectors(
      loops,
      connectorPoints,
      connectorConfig,
      p0,
      n,
      uAxis,
      vAxis,
      earcut,
      { A: thickA <= nearZero ? 0 : thickA, B: thickB <= nearZero ? 0 : thickB },
      modelOutward,
      { A: touchA, B: touchB },
      { A: localThickA, B: localThickB }
    );

    // 6. 合并所有表面生成最终的 Part A 与 Part B
    //    大模型（十万面）的封盖数组可达数十万个分量，用 push(...arr) 展开传参会爆栈，
    //    改为按块拷贝。
    const appendFaces = (target, faces) => {
      const chunk = 4096;
      for (let i = 0; i < faces.length; i += chunk) {
        target.push(...faces.slice(i, i + chunk));
      }
    };
    appendFaces(trianglesA, capFacesA);
    appendFaces(trianglesB, capFacesB);

    // 切面贴在模型表面时，那一侧只剩被「共面保留」的外表面壳子，不是实体，
    // 必须置空，否则用户拿到一个体积虚高、面片重叠的假零件。
    const posArrayA = thickA <= nearZero ? new Float32Array(0) : new Float32Array(trianglesA);
    const posArrayB = thickB <= nearZero ? new Float32Array(0) : new Float32Array(trianglesB);

    const elapsed = Math.round(performance.now() - startTime);

    // 结果合法性自检：宁可明确告警，也不导出空壳/开口零件
    const triCountA = Math.floor(posArrayA.length / 9);
    const triCountB = Math.floor(posArrayB.length / 9);
    if (triCountA === 0 || triCountB === 0) {
      warnings.push(`有一侧零件为空（A ${triCountA} 面 / B ${triCountB} 面）：切面可能正好贴在模型表面或超出模型范围，请把切面往里挪一点`);
    }
    if (loops.length === 0) {
      warnings.push('切面与模型没有形成闭合轮廓，本次未生成切面封盖，零件不是水密实体');
    }
    if (connectorConfig && connectorConfig.type && connectorConfig.type !== 'none' && connectorPoints.length === 0) {
      // 区分「用户填的孔位本身有问题」和「切面太窄放不下」：两者的处理办法完全不同，
      // 旧实现一律提示「切面过窄」，自定义孔位填错坐标的用户会去白折腾切面。
      if (connectorConfig.placement === 'custom') {
        const raw = connectorConfig.customPoints;
        if (!Array.isArray(raw) || raw.length === 0) {
          warnings.push('自定义连接件孔位没有有效坐标（为空或格式不对），本次未打孔；请在切面上点选至少一个孔位');
        } else {
          warnings.push('自定义连接件孔位全部落在切面轮廓之外或贴着边缘（壁厚不足），已全部跳过；请把孔位拖到切面内部');
        }
      } else {
        warnings.push('切面过窄或形状特殊，没有找到能放下连接件的孔位（已自动跳过打孔），建议改用单孔或换更小的连接件');
      }
    }

    // 切面与模型表面几乎重合：这一侧零件厚度接近 0，切出来只是一张没有厚度的面片，
    // 既打不了孔也没法打印。必须提示用户把切面往里挪，而不是让用户拿到一个空壳文件。
    if (numTriangles > 0) {
      if (thickA <= nearZero && triCountB > 0) {
        warnings.push('切面与模型表面几乎重合（正侧厚度≈0）：这一侧零件没有实体厚度，请把切面往模型内部挪一点再切');
      }
      if (thickB <= nearZero && triCountA > 0) {
        warnings.push('切面与模型表面几乎重合（负侧厚度≈0）：这一侧零件没有实体厚度，请把切面往模型内部挪一点再切');
      }
    }

    // 原始模型非水密检测：有向边不配对（开放边）说明模型本身有洞，
    // 切出来的零件即便有封盖也不是封闭实体，切片软件会报非流形。
    let openEdges = 0;
    for (const [key, cnt] of edgeUse) {
      const [ka, kb] = key.split('|');
      const rev = edgeUse.get(kb + '|' + ka) || 0;
      if (cnt !== rev) openEdges += Math.abs(cnt - rev);
    }
    if (openEdges > 0) {
      warnings.push(`原始模型不是封闭网格（检测到 ${openEdges} 条开放边，常见于单面片、缺面或非流形模型）：切出的零件同样不水密，建议先在建模软件里修好模型再切`);
    }
    if (connWarnings && connWarnings.length > 0) warnings.push(...connWarnings);

    return {
      partA: posArrayA,
      partB: posArrayB,
      cutLoopsCount: loops.length,
      connectorCount: connectorPoints.length,
      connectorPoints: connectorPoints,
      bom: connectorBOM,
      elapsedMs: elapsed,
      warnings: warnings
    };
  }

  /**
   * 把三角形裁剪到切割平面两侧，并收集截面交线段。
   *
   * 旧实现假定「一个顶点单独在一侧、另两个在另一侧」。当顶点恰好落在切割平面上
   * （符号为 0，例如斜切正好穿过立方体顶点、沿对角线分件）时，插值参数 t 恒为 0，
   * 两个交点退化成同一个点，截线段长度为零 → 环拼不起来、封盖全丢、零件不水密。
   * 现改为标准 Sutherland-Hodgman 裁剪：平面上的顶点同时归属两侧，交点单独提取。
   */
  static splitTriangle(pts, dists, signs, outA, outB, cutSegments, eps = 1e-5) {
    const isPos = dists.map(d => d > eps);
    const isNeg = dists.map(d => d < -eps);
    const numPos = isPos.filter(Boolean).length;
    const numNeg = isNeg.filter(Boolean).length;

    // 三个顶点全部落在切割平面上：这个三角形是模型自身的面，正好与切面重合
    // （典型场景：把一块 1.2mm 薄板放在底板上切，切面正好是薄板的底面）。
    // 旧实现把它整片塞进 A 侧，而封盖又在同一位置重建了一个等效面 —— 同一位置两层反向/同向面，
    // 有向体积直接算成负数（20×20×1.2 薄板 + 20³ 方块实测 A 侧 -1051.88mm³），
    // 导出的 STL 在切片软件里是个内外翻转的怪壳。
    // 正确做法：整片丢弃，由封盖在切面上重建这一层表面。
    // 注意不能把它的三条边登记进 cutSegments：三角形内部的对角线会被当成截面边界，
    // 和侧壁裁剪出的真实轮廓线一起缝出「正方形 + 对角线」的怪环，封盖面积虚高
    // （实测 400mm² 的切面算出 740mm²）。截面轮廓由侧壁三角形与切面的交点负责，这里不需要补。
    if (numPos === 0 && numNeg === 0) {
      return;
    }

    // 先收集截面线段，再分配三角形。顺序很重要：
    // 「两个顶点在平面上、一个在正侧」的三角形整片属于 A 侧，但它的那条棱正是截面边界，
    // 若先做「全在一侧」的提前返回就会把这条边界漏掉，环因此闭合不了。
    if (numPos + numNeg > 0) {
      const inter = [];
      const onPlaneEdge = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        const si = isPos[i] ? 1 : (isNeg[i] ? -1 : 0);
        const sj = isPos[j] ? 1 : (isNeg[j] ? -1 : 0);
        if (si === 0 && sj === 0) {
          // 整条棱躺在切割平面上，它就是截面边界的一段
          onPlaneEdge.push([pts[i], pts[j]]);
          continue;
        }
        if (si === 0) { inter.push(pts[i]); continue; }
        if (sj === 0) continue; // 由下一轮 i=j 处理
        if (si !== sj) inter.push(this.lerp(pts[i], pts[j], dists[i] / (dists[i] - dists[j])));
      }

      const mergeEps = Math.max(eps * 10, 1e-9);
      const uniq = [];
      for (const p of inter) {
        if (!uniq.some(q => this.dist3D(p, q) < mergeEps)) uniq.push(p);
      }
      if (uniq.length >= 2) {
        cutSegments.push({ p1: uniq[0], p2: uniq[1] });
      } else if (uniq.length < 2) {
        for (const [a, b] of onPlaneEdge) cutSegments.push({ p1: a, p2: b });
      }
    }

    // 全部落在同一侧（平面上的顶点两侧共有），不产生新的裁剪面
    if (numNeg === 0) { outA.push(...pts[0], ...pts[1], ...pts[2]); return; }
    if (numPos === 0) { outB.push(...pts[0], ...pts[1], ...pts[2]); return; }

    const clip = (keepPositive) => {
      const res = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        const di = dists[i], dj = dists[j];
        const inI = keepPositive ? di >= -eps : di <= eps;
        const inJ = keepPositive ? dj >= -eps : dj <= eps;
        if (inI) res.push(pts[i]);
        if (inI !== inJ) res.push(this.lerp(pts[i], pts[j], di / (di - dj)));
      }
      return res;
    };

    const emitFan = (poly, out) => {
      if (poly.length < 3) return;
      for (let k = 1; k + 1 < poly.length; k++) {
        // 丢弃裁剪产生的零面积三角形（平面上顶点会造成共线三点）
        const a = poly[0], b = poly[k], c = poly[k + 1];
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        if (Math.hypot(cr[0], cr[1], cr[2]) * 0.5 <= eps * eps) continue;
        out.push(...a, ...b, ...c);
      }
    };
    emitFan(clip(true), outA);
    emitFan(clip(false), outB);

    // 提取截面交线段：包含「顶点恰在平面上」「整条边贴在平面上」两种情形
    const inter = [];
    const onPlaneEdge = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const si = isPos[i] ? 1 : (isNeg[i] ? -1 : 0);
      const sj = isPos[j] ? 1 : (isNeg[j] ? -1 : 0);
      if (si === 0 && sj === 0) {
        // 整条边躺在切割平面上，它就是截面边界的一段
        onPlaneEdge.push([pts[i], pts[j]]);
        continue;
      }
      if (si === 0) { inter.push(pts[i]); continue; }
      if (sj === 0) continue; // 由下一轮 i=j 处理
      if (si !== sj) inter.push(this.lerp(pts[i], pts[j], dists[i] / (dists[i] - dists[j])));
    }

    const mergeEps = Math.max(eps * 10, 1e-9);
    const uniq = [];
    for (const p of inter) {
      if (!uniq.some(q => this.dist3D(p, q) < mergeEps)) uniq.push(p);
    }
    if (uniq.length >= 2) {
      cutSegments.push({ p1: uniq[0], p2: uniq[1] });
    } else if (onPlaneEdge.length > 0) {
      for (const [a, b] of onPlaneEdge) cutSegments.push({ p1: a, p2: b });
    }
  }

  static dist3D(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /**
   * 沿方向 n 从 origin 射线与三角网格求最近交点距离（Möller–Trumbore）。
   * 用于算「孔位处的局部壁厚」：斜切件（刀身、斜角壳体）沿切面法向的局部厚度
   * 可能远小于全局最大厚度，孔深若按全局厚度算，孔底会直接挖穿零件外表面。
   */
  static rayThickness(tris, origin, n) {
    const EPS = 1e-7;
    let best = Infinity;
    const ox = origin[0], oy = origin[1], oz = origin[2];
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const px = n[1] * e2z - n[2] * e2y;
      const py = n[2] * e2x - n[0] * e2z;
      const pz = n[0] * e2y - n[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -EPS && det < EPS) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (n[0] * qx + n[1] * qy + n[2] * qz) * inv;
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-5 && t < best) best = t;
    }
    return best;
  }

  /**
   * 去掉重复的截面线段：切面穿过模型棱边时，同一条棱会被相邻两个三角形各收集一次，
   * 重复线段会让环拼接提前闭合或串错环。
   */
  static dedupeSegments(segments, eps) {
    if (segments.length === 0) return segments;
    const q = Math.max(eps * 100, 1e-9);
    const key = (p) => `${Math.round(p[0] / q)},${Math.round(p[1] / q)},${Math.round(p[2] / q)}`;
    const seen = new Set();
    const out = [];
    for (const s of segments) {
      const ka = key(s.p1), kb = key(s.p2);
      if (ka === kb) continue; // 退化成一个点，丢掉
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }

  /**
   * 构造平面的正交基向量 (uAxis, vAxis)
   */
  static createPlaneBasis(n) {
    let temp = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = this.cross(temp, n);
    u = this.normalize(u);
    let v = this.cross(n, u);
    v = this.normalize(v);
    return { uAxis: u, vAxis: v };
  }

  /**
   * 将 3D 交线段投影并拼接为闭合的多边形外环与内孔 (Loops)
   */
  static stitchSegmentsToLoops(segments, p0, uAxis, vAxis) {
    if (segments.length === 0) return [];

    // 转换为 2D 坐标
    const lines2D = segments.map(seg => ({
      a: this.to2D(seg.p1, p0, uAxis, vAxis),
      b: this.to2D(seg.p2, p0, uAxis, vAxis),
      used: false
    }));

    const loops = [];

    // 动态连接容差：按截面尺度自适应。固定 0.15mm 在细分密集的模型上会把相邻但不同
    // 的交点误连成一条边（环被串错），在超大截面上又可能因浮点误差拼不上环。
    let spanMax = 0;
    for (const l of lines2D) {
      spanMax = Math.max(spanMax, Math.abs(l.a[0]), Math.abs(l.a[1]), Math.abs(l.b[0]), Math.abs(l.b[1]));
    }
    const tol = Math.min(0.2, Math.max(0.006, spanMax * 0.0012));

    // 端点空间哈希：旧实现每接一段都要把所有剩余线段扫一遍找最近端点，
    // 复杂度 O(n²)。十万面的真实打印模型截面能有两三万条线段，切片要卡 25 秒以上，
    // 用户以为软件死了。这里把线段端点按容差大小的网格分桶，只在当前端点
    // 的 3×3 邻域里找候选，复杂度降到接近 O(n)。
    const cellSize = Math.max(tol, 1e-9);
    const buckets = new Map();
    const bucketKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    const registerEnd = (idx, pt) => {
      const k = bucketKey(pt[0], pt[1]);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(idx);
    };
    lines2D.forEach((l, idx) => { registerEnd(idx, l.a); registerEnd(idx, l.b); });

    const candidatesNear = (pt) => {
      const cx = Math.floor(pt[0] / cellSize);
      const cy = Math.floor(pt[1] / cellSize);
      const set = new Set();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = buckets.get(`${cx + dx},${cy + dy}`);
          if (arr) for (const idx of arr) set.add(idx);
        }
      }
      return set;
    };

    for (let i = 0; i < lines2D.length; i++) {
      if (lines2D[i].used) continue;

      const currentLoop = [lines2D[i].a, lines2D[i].b];
      lines2D[i].used = true;

      let loopClosed = false;
      let iterations = 0;

      while (!loopClosed && iterations < lines2D.length) {
        iterations++;
        const currentEnd = currentLoop[currentLoop.length - 1];
        let foundNext = false;

        // 在邻域候选里取「最近的一个」而不是第一个落在容差内的，
        // 否则多个交点聚集处会被贪婪匹配串错，导致环自交、封盖三角剖分翻面
        let bestJ = -1;
        let bestDist = tol;
        let bestFlip = false;
        for (const j of candidatesNear(currentEnd)) {
          if (lines2D[j].used) continue;
          const dA = this.dist2D(currentEnd, lines2D[j].a);
          if (dA < bestDist) { bestDist = dA; bestJ = j; bestFlip = false; }
          const dB = this.dist2D(currentEnd, lines2D[j].b);
          if (dB < bestDist) { bestDist = dB; bestJ = j; bestFlip = true; }
        }

        if (bestJ >= 0) {
          currentLoop.push(bestFlip ? lines2D[bestJ].a : lines2D[bestJ].b);
          lines2D[bestJ].used = true;
          foundNext = true;
        }

        if (!foundNext) {
          // 检查首尾是否能够闭合
          if (this.dist2D(currentLoop[0], currentLoop[currentLoop.length - 1]) < tol * 3) {
            loopClosed = true;
          }
          break;
        }

        if (this.dist2D(currentLoop[0], currentLoop[currentLoop.length - 1]) < tol) {
          loopClosed = true;
          break;
        }
      }

      // 闭合环且点数充足
      if (currentLoop.length >= 4) {
        // 保证首尾点严格一致
        currentLoop[currentLoop.length - 1] = currentLoop[0];
        const area = this.polygonArea(currentLoop);
        // 忽略面积极小的杂散微多边形。
        // 旧实现硬编码 1.0 mm²，1mm 级微缩件的整个截面才 1 mm²，会被当成碎片丢掉，
        // 导致封盖为空却不报警。改为按截面尺度取相对阈值。
        const areaFloor = Math.max(1e-9, (spanMax * 2) * (spanMax * 2) * 1e-6);
        if (Math.abs(area) > areaFloor) {
          loops.push({
            points: currentLoop.slice(0, -1), // 去除重复末尾
            area: area,
            isHole: area < 0
          });
        }
      }
    }

    return this.classifyLoops(loops);
  }

  /**
   * 判定环的嵌套关系（外轮廓 / 内孔）
   * 旧实现仅凭「面积符号」判断 isHole，而环的绕向取决于三角形朝向，
   * STL 法线不统一时会把外轮廓误判成孔丢弃、把内孔当外轮廓填成实心，
   * 空心件（管件、带空腔的手办）切面因此被封错。
   */
  static classifyLoops(loops) {
    if (loops.length === 0) return loops;

    // 统一绕向：面积取绝对值，外轮廓逆时针(正)、孔顺时针(负)
    for (const l of loops) {
      l.absArea = Math.abs(l.area);
      l.area = l.absArea;
      l.isHole = false;
      l.parent = null;
      l.children = [];
    }

    // 按面积降序，只有更大的环才可能包含当前环
    const sorted = loops.slice().sort((a, b) => b.absArea - a.absArea);

    for (let i = 0; i < sorted.length; i++) {
      const inner = sorted[i];
      const probe = this.polygonCentroid(inner.points);
      let parent = null;
      for (let j = 0; j < i; j++) {
        const outer = sorted[j];
        if (this.pointInPolygon(probe, outer.points)) {
          parent = outer; // 最近的（面积最小的）包含者为父
        }
      }
      if (parent) {
        inner.parent = parent;
        inner.isHole = true;
        inner.area = -inner.absArea;
        parent.children.push(inner);
      }
    }

    // 只保留最外层环作为封盖入口，孔环挂在 children 上
    const roots = sorted.filter(l => !l.parent);

    // 方向规范化：外轮廓逆时针、内孔顺时针，保证 earcut 与封盖法线一致
    const fixWinding = (loop, wantCCW) => {
      const isCCW = loop.area > 0;
      if (isCCW !== wantCCW) {
        loop.points.reverse();
        loop.area = -loop.area;
      }
    };
    for (const r of roots) {
      fixWinding(r, true);
      for (const c of r.children) fixWinding(c, false);
    }

    return roots;
  }

  /** 多边形质心（用于嵌套判定，退化时回退为顶点均值） */
  static polygonCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
      a += cross;
      cx += (pts[i][0] + pts[j][0]) * cross;
      cy += (pts[i][1] + pts[j][1]) * cross;
    }
    if (Math.abs(a) < 1e-9) {
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p[0]; sy += p[1]; }
      return [sx / pts.length, sy / pts.length];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  /** 射线法：点是否在多边形内部 */
  static pointInPolygon(pt, poly) {
    let inside = false;
    const x = pt[0], y = pt[1];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** 点到多边形边界的最短距离（用于孔位安全边距校验） */
  static distanceToPolygonEdge(pt, poly) {
    let min = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      min = Math.min(min, this.pointToSegmentDistance(pt, poly[i], poly[j]));
    }
    return min;
  }

  static pointToSegmentDistance(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = p[0] - a[0], wy = p[1] - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 1e-12 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p[0] - (a[0] + t * vx), dy = p[1] - (a[1] + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 自动计算连接件在切面 2D 平面上的放置坐标。
   *
   * 旧实现只取「面积最大的那个外环」撒点，一次切出多个独立实体时（一个模型里并排
   * 两个零件、或分件后出现多个截面），只有最大的那块有孔，其余实体一个孔都没有，
   * 打印出来没法对接。现改为每个外环各自撒点，孔位按所属环归属。
   */
  static determineConnectorPositions(loops, config) {
    if (!config || config.type === 'none' || loops.length === 0) return [];

    const roots = loops.filter(l => !l.isHole);
    if (roots.length === 0) return [];

    const all = [];
    for (const root of roots) {
      all.push(...this.positionsForLoop(root, loops, config));
    }
    return all;
  }

  /** 针对单个外环计算孔位（含合法性校验与收缩降级） */
  static positionsForLoop(mainLoop, loops, config) {
    // 计算包围盒与中心
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    let sumU = 0, sumV = 0;
    for (const pt of mainLoop.points) {
      minU = Math.min(minU, pt[0]);
      maxU = Math.max(maxU, pt[0]);
      minV = Math.min(minV, pt[1]);
      maxV = Math.max(maxV, pt[1]);
      sumU += pt[0];
      sumV += pt[1];
    }
    const centerU = sumU / mainLoop.points.length;
    const centerV = sumV / mainLoop.points.length;
    const spanU = maxU - minU;
    const spanV = maxV - minV;

    const positions = [];

    // 用户自定义点：同样要过合法性校验，越界孔会打出悬空孔腔（自定义点不做收缩，只过滤）
    if (config.placement === 'custom') {
      // 自定义点可能是 null / 非数组 / 元素不是 [u,v]，直接解构会抛异常把整次切分打断
      const raw = Array.isArray(config.customPoints) ? config.customPoints : [];
      const valid = raw.filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (valid.length === 0) return [];
      const inside = valid.filter(([u, v]) => this.pointInPolygon([u, v], mainLoop.points));
      if (inside.length === 0) return [];
      // 用户可能把同一个点加了两次（或两点间距小于孔径）：同一位置打两次孔会把孔壁挖穿
      const minGap = Math.max(0.5, ((config.type === 'magnet' ? config.magnet?.diameter : config.dowel?.diameter) || 6) * 0.5);
      const deduped = [];
      for (const pt of inside) {
        if (!deduped.some(q => this.dist2D(pt, q) < minGap)) deduped.push(pt);
      }
      return this.validateConnectorPositions(deduped, loops, mainLoop, config, false);
    }

    // 根据模式生成点位
    if (config.placement === 'single') {
      positions.push([centerU, centerV]);
    } else if (config.placement === 'dual' || !config.placement) {
      // 沿长轴对称分布
      if (spanU >= spanV) {
        const offset = Math.min(spanU * 0.28, Math.max(spanU * 0.2, 10));
        positions.push([centerU - offset, centerV]);
        positions.push([centerU + offset, centerV]);
      } else {
        const offset = Math.min(spanV * 0.28, Math.max(spanV * 0.2, 10));
        positions.push([centerU, centerV - offset]);
        positions.push([centerU, centerV + offset]);
      }
    } else if (config.placement === 'quad') {
      // 四孔矩阵
      const offU = Math.min(spanU * 0.25, Math.max(spanU * 0.15, 8));
      const offV = Math.min(spanV * 0.25, Math.max(spanV * 0.15, 8));
      positions.push([centerU - offU, centerV - offV]);
      positions.push([centerU + offU, centerV - offV]);
      positions.push([centerU + offU, centerV + offV]);
      positions.push([centerU - offU, centerV + offV]);
    }

    // 环形截面（管件、薄壁头盔壳、空心收纳盒）：包围盒中心落在内孔空腔里。
    // 注意：不能只查 mainLoop.points，因为外轮廓包围着内孔，空心处的点对外轮廓也是 inside。
    // 必须确认质心「落在实体肉里（在 mainLoop 内且不在任一 child 孔内）」。
    const inOuter = this.pointInPolygon([centerU, centerV], mainLoop.points);
    const inHole = (mainLoop.children || []).some(c => this.pointInPolygon([centerU, centerV], c.points));
    const centerInMeat = inOuter && !inHole;

    if (!centerInMeat && mainLoop.children && mainLoop.children.length > 0) {
      const mids = [];
      // 环带取点原来是「外环点数 × 内孔点数」的全量双重循环：细分密集的圆管/头盔壳
      // （外环 5000 点、内孔 5000 点）要算 2500 万次距离，切一次卡十几秒。
      // 这里对外环做等距抽样（最多 240 个），孔位只需大致分散在环带上，精度不受影响。
      const outerPts = mainLoop.points;
      const stepOuter = Math.max(1, Math.ceil(outerPts.length / 240));
      for (const child of mainLoop.children) {
        for (let pi = 0; pi < outerPts.length; pi += stepOuter) {
          const p = outerPts[pi];
          let best = null, bd = Infinity;
          for (const q of child.points) {
            const d = this.dist2D(p, q);
            if (d < bd) { bd = d; best = q; }
          }
          if (best && bd > 1e-6) mids.push([(p[0] + best[0]) / 2, (p[1] + best[1]) / 2]);
        }
      }
      if (mids.length > 0) {
        // 按相对质心的角度排序，再均匀抽 1/2/4 个，保证孔位分散在环带上
        const ang = (pt) => Math.atan2(pt[1] - centerV, pt[0] - centerU);
        mids.sort((a, b) => ang(a) - ang(b));
        const want = config.placement === 'single' ? 1 : (config.placement === 'quad' ? 4 : 2);
        const picked = [];
        for (let k = 0; k < want; k++) {
          picked.push(mids[Math.floor((k * mids.length) / want) % mids.length]);
        }
        positions.length = 0;
        positions.push(...picked);
      }
    }

    // 孔位合法性校验：必须完全落在轮廓内、且离边界留足壁厚。
    // 旧实现只按包围盒比例撒点，窄长截面（如 120×10 的刀身）会把 φ10 孔甩到轮廓外，
    // 切出来的零件上出现悬空孔腔。
    return this.validateConnectorPositions(positions, loops, mainLoop, config);
  }

  /**
   * 过滤越界孔位，必要时逐步收缩偏移量；实在放不下就降级为单孔/无孔
   */
  static validateConnectorPositions(positions, loops, mainLoop, config, allowShrink = true) {
    const dia = config.type === 'magnet'
      ? (config.magnet?.diameter || 6)
      : (config.dowel?.diameter || 8);
    const clearance = (config.type === 'magnet' ? config.magnet?.clearance : config.dowel?.clearance) || 0.2;
    const radius = (dia + clearance) / 2.0;
    const wall = Math.max(1.2, radius * 0.35); // 孔壁最小安全厚度
    const need = radius + wall;

    // 孔不能落进内孔（孔环）里
    const holePolys = [];
    for (const l of loops) {
      if (l.children) holePolys.push(...l.children);
    }

    const isValid = (pt) => {
      if (!this.pointInPolygon(pt, mainLoop.points)) return false;
      if (this.distanceToPolygonEdge(pt, mainLoop.points) < need) return false;
      for (const h of holePolys) {
        if (this.pointInPolygon(pt, h.points)) return false;
        if (this.distanceToPolygonEdge(pt, h.points) < need) return false;
      }
      return true;
    };

    let valid = positions.filter(isValid);
    if (valid.length === positions.length || !allowShrink) return valid;

    // 收缩：以轮廓质心为基准，把偏移量按 0.75 递减重试
    const center = this.polygonCentroid(mainLoop.points);
    let scale = 0.75;
    while (valid.length < Math.min(2, positions.length) && scale > 0.2) {
      const shrunk = positions.map(([u, v]) => [center[0] + (u - center[0]) * scale, center[1] + (v - center[1]) * scale]);
      valid = shrunk.filter(isValid);
      scale *= 0.75;
    }

    // 仍不足：退化为质心单孔（若质心本身合法）
    if (valid.length === 0 && isValid(center)) valid = [center];

    // 收缩重试会把两孔越挤越近，间距小于一个孔径时等于同一个孔打两遍，
    // BOM 数量虚高、孔壁被削薄，这里合并成一个。
    const minGap = radius * 2.05;
    const merged = [];
    for (const pt of valid) {
      if (!merged.some(q => this.dist2D(pt, q) < minGap)) merged.push(pt);
    }

    return merged;
  }

  /**
   * 生成封闭切面三角网格与连接件（沉头孔 / 公母榫卯）
   */
  static generateCapsAndConnectors(loops, connectorPoints, config, p0, n, uAxis, vAxis, earcut, thickness = { A: Infinity, B: Infinity }, modelOutward = true, touch = { A: true, B: true }, localThick = { A: null, B: null }) {
    const capFacesA = [];
    const capFacesB = [];
    const connWarnings = [];
    // 某一侧压根没有实体贴切面（多实体叠放时切面只穿过其中一个实体）：
    // 那一侧不能生成封盖，否则会在空处凭空长出一张面片（实测体积多出 1324mm³）。
    const doA = touch.A !== false;
    const doB = touch.B !== false;
    // count / totalQty 必须跨「所有外环」累加：一次切出多个独立实体时，
    // 旧实现在每个环末尾直接赋值，后一个环会把前一个环的孔数覆盖掉，
    // 两个实体各 2 孔最终只报 2 个磁铁（实际要 8 个），用户照着 BOM 买会少一半。
    const connectorBOM = {
      type: config.type || 'none',
      count: 0,
      details: {}
    };

    if (loops.length === 0 || thickness.A <= 0 || thickness.B <= 0) {
      // 只要有一侧厚度 <= 0，说明切面正好贴在模型外表面、根本没有切入模型内部。
      // 模型原本的外表面已经封闭了实体，再生成封盖会产生双层重叠面、破坏水密性，
      // 此处直接返回空封盖。
      return { capFacesA, capFacesB, connectorBOM, connWarnings };
    }

    const type = config.type || 'none'; // 'none' | 'magnet' | 'dowel'

    // 1. 遍历每个闭合回路，为切面封盖
    for (const loop of loops) {
      if (loop.isHole) continue; // 先处理外环

      // 孔位按所属外环归属：一次切出多个独立实体时，不能把 A 块的孔也打到 B 块上，
      // 否则孔会落到 B 块轮廓之外，earcut 收到非法 holes，封盖面积和形状都会错。
      const loopPoints = connectorPoints.filter(([cu, cv]) => this.pointInPolygon([cu, cv], loop.points));

      // 准备剖分多边形
      // flatCoords: [x0, y0, x1, y1, ...]
      // holeIndices: [startIndexHole1, ...]
      const flatCoordsA = [];
      const holeIndicesA = [];

      const flatCoordsB = [];
      const holeIndicesB = [];

      // 加入外环顶点 (需保证为顺时针或逆时针)
      // earcut 期望外轮廓点
      for (const pt of loop.points) {
        flatCoordsA.push(pt[0], pt[1]);
        flatCoordsB.push(pt[0], pt[1]);
      }

      // 模型本身的几何空心内环 (children)
      if (loop.children && loop.children.length > 0) {
        for (const child of loop.children) {
          holeIndicesA.push(flatCoordsA.length / 2);
          holeIndicesB.push(flatCoordsB.length / 2);
          for (const pt of child.points) {
            flatCoordsA.push(pt[0], pt[1]);
            flatCoordsB.push(pt[0], pt[1]);
          }
        }
      }

      // 如果启用了磁铁沉孔或定位凹槽
      const holePolygonsA = [];
      const holePolygonsB = [];
      // 榫卯公榫底环：只作为 B 侧封盖的孔（不挖腔），保证凸台与封盖焊接成水密实体
      const pinHolesB = [];

      if (type === 'magnet') {
        const dia = config.magnet?.diameter || 6.0;
        const depth = config.magnet?.depth || 3.0;
        const clearance = config.magnet?.clearance || 0.2;
        const radius = (dia + clearance) / 2.0;
        const totalDepth = depth + 0.3; // 深度预留胶水与沉头公差

        // 盲孔深度不能超过零件在该侧的厚度，否则孔底会穿出零件外表面，
        // 打印出来是个对穿孔，磁铁从背面露出来。每侧至少留 1.0mm 底壁。
        const minWall = 1.0;
        const capA = thickness.A === Infinity ? totalDepth : thickness.A - minWall;
        const capB = thickness.B === Infinity ? totalDepth : thickness.B - minWall;
        const depthA = Math.max(0, Math.min(totalDepth, capA));
        const depthB = Math.max(0, Math.min(totalDepth, capB));

        if (depthA < totalDepth - 1e-6 || depthB < totalDepth - 1e-6) {
          const thin = depthA < depthB ? 'A' : 'B';
          const realDepth = Math.min(depthA, depthB);
          if (realDepth <= 0.05) {
            connWarnings.push(`零件在切面处太薄（A ${thickness.A.toFixed(2)}mm / B ${thickness.B.toFixed(2)}mm），放不下 φ${dia}×${depth}mm 磁铁沉孔，本次未打磁铁孔；请换更薄的磁铁或加大零件厚度`);
          } else {
            connWarnings.push(`零件偏薄（${thin} 侧仅 ${(thin === 'A' ? thickness.A : thickness.B).toFixed(2)}mm），φ${dia}×${depth}mm 磁铁沉孔已自动减浅到 ${realDepth.toFixed(2)}mm（每侧留 1.0mm 底壁），如需完整孔深请加厚零件或改用 φ${dia}×2mm 薄磁铁`);
          }
        }

        // 规格只写一次：每个外环重复赋值会把前面累加的 totalQty 清零
        if (!connectorBOM.details.name) {
          connectorBOM.details = {
            name: `φ${dia} × ${depth}mm 强磁沉头盲孔`,
            diameter: dia,
            depth: Math.min(depthA, depthB) > 0 ? +(Math.min(depthA, depthB) - 0.3).toFixed(2) : 0,
            clearance: clearance,
            // 真实用量在函数末尾按实际生成的孔腔数回填：某一侧太薄没打孔时
            // 不能再按「孔位 ×2」报数量，否则用户会照着 BOM 多买一半磁铁。
            totalQty: 0
          };
        }

        // 在每个孔位生成圆形内孔多边形 (20边形)
        // 每个孔按自己的局部壁厚单独定深：斜切件不同孔位到外表面的距离差别很大，
        // 统一按全局厚度会把靠近斜边的孔挖穿（实测孔底顶点跑到模型外 0.13mm）。
        const kk = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
        let clampedByLocal = false;
        let minRealDepth = Infinity;
        for (const [cu, cv] of loopPoints) {
          const la = localThick.A ? localThick.A.get(kk([cu, cv])) : Infinity;
          const lb = localThick.B ? localThick.B.get(kk([cu, cv])) : Infinity;
          const tA = Math.min(thickness.A, Number.isFinite(la) ? la : Infinity);
          const tB = Math.min(thickness.B, Number.isFinite(lb) ? lb : Infinity);
          const dA = Math.max(0, Math.min(totalDepth, tA === Infinity ? totalDepth : tA - minWall));
          const dB = Math.max(0, Math.min(totalDepth, tB === Infinity ? totalDepth : tB - minWall));
          if (dA < depthA - 1e-6 || dB < depthB - 1e-6) clampedByLocal = true;
          if (doA && dA > 0.05) {
            minRealDepth = Math.min(minRealDepth, dA);
            const circlePtsA = this.generateCircle2D(cu, cv, radius, 20, false);
            holePolygonsA.push({ center: [cu, cv], radius, depth: dA, pts: circlePtsA });
          }
          if (doB && dB > 0.05) {
            minRealDepth = Math.min(minRealDepth, dB);
            const circlePtsB = this.generateCircle2D(cu, cv, radius, 20, false);
            holePolygonsB.push({ center: [cu, cv], radius, depth: dB, pts: circlePtsB });
          }
        }
        // BOM 里必须写「实际最浅的孔深」：旧实现写的是全局标称深度，
        // 斜切件上局部减浅到 0.4mm 时 BOM 仍报 3mm，用户按 3mm 买磁铁装不进去。
        if (minRealDepth < Infinity && connectorBOM.details) {
          connectorBOM.details.depth = +(Math.max(0, minRealDepth - 0.3)).toFixed(2);
        }
        // 全局厚度已经不够时，上一条警告已经说明原因，不再重复提示局部减浅
        if (clampedByLocal && depthA >= totalDepth - 1e-6 && depthB >= totalDepth - 1e-6) {
          connWarnings.push(`切面是斜的或零件局部较薄：部分孔位到外表面的实际壁厚不足，φ${dia}×${depth}mm 磁铁沉孔已按各孔位的局部厚度分别减浅（每侧仍留 1.0mm 底壁），避免孔底挖穿零件；如需完整孔深请加厚零件或把孔位往零件中心挪`);
        }
      } else if (type === 'dowel') {
        const shape = config.dowel?.shape || 'd-shape';
        const dia = config.dowel?.diameter || 8.0;
        const length = config.dowel?.length || 12.0;
        const clearance = config.dowel?.clearance || 0.2;
        const halfLen = length / 2.0;

        if (!connectorBOM.details.name) {
          connectorBOM.details = {
            name: `${shape === 'd-shape' ? 'D型防呆销' : '圆柱销'} (φ${dia}×${length}mm)`,
            diameter: dia,
            length: length,
            clearance: clearance,
            shape: shape,
            totalQty: 0
          };
        }

        // 榫卯也要看零件厚度：公榫凸出长度不能超过 B 侧厚度（否则销子从背面穿出来），
        // 母槽深度不能超过 A 侧厚度。两侧各留 1.0mm 余量。
        // 关键：公榫与母槽必须成对定长。旧实现两者各自取 min，A 侧薄时出现
        // 「母槽深 1.00mm、公榫凸出 6.00mm」—— 凸榫比槽深 5mm，装配时直接顶死对不上。
        // 现在先求两侧共同能容纳的长度，槽再比榫深 0.3mm 留装配余量。
        const minWall = 1.0;
        const socketRadius = (dia + clearance) / 2.0;
        const kkD = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

        // 榫卯同样必须按「每个孔位自己的局部壁厚」定长。
        // 旧实现只用全局最大厚度算一次 pinLen/socketDepth：斜切面、曲面、渐变壁上
        // 靠边的孔位实际只有 1~2mm 肉，母槽照挖 6.3mm 会直接挖穿零件背面，
        // 公榫照长 6mm 会从零件外表面戳出来。实测 45° 斜切 20³，A 块顶点跑到 z=12.95
        //（模型只到 10），打出来零件背面多出一根销、正面多一个洞。
        let minPinLen = Infinity, minSocketDepth = Infinity, skippedByThin = 0;
        for (const [cu, cv] of loopPoints) {
          const la = localThick.A ? localThick.A.get(kkD([cu, cv])) : Infinity;
          const lb = localThick.B ? localThick.B.get(kkD([cu, cv])) : Infinity;
          const tA = Math.min(thickness.A, Number.isFinite(la) ? la : Infinity);
          const tB = Math.min(thickness.B, Number.isFinite(lb) ? lb : Infinity);
          const pinCapL = tB === Infinity ? halfLen : Math.max(0, tB - minWall);
          const socketCapL = tA === Infinity ? halfLen + 0.5 : Math.max(0, tA - minWall);
          const commonL = Math.max(0, Math.min(pinCapL, socketCapL));
          const pinLenL = Math.min(halfLen, commonL);
          const socketDepthL = Math.min(pinLenL + 0.3, Math.max(socketCapL, pinLenL));

          if (pinLenL <= 0.1 || socketDepthL <= 0.1) {
            skippedByThin++;
            continue;
          }
          minPinLen = Math.min(minPinLen, pinLenL);
          minSocketDepth = Math.min(minSocketDepth, socketDepthL);

          // Part A: 凹槽 Socket（半径加大 clearance，深度比公榫深 0.3mm 留装配余量）
          // Part B: 凸台 Pin（基准面保留，向外生长凸柱）
          if (doA) {
            const circleSocket = this.generateDowel2D(cu, cv, socketRadius, shape, 24, false);
            holePolygonsA.push({ center: [cu, cv], radius: socketRadius, depth: socketDepthL, pts: circleSocket, shape });
          }

          // Part B 的凸台：底面圆环必须同时作为 B 侧封盖上的孔，
          // 否则凸台底部是一圈悬空边（每根销 24 条开放边），零件不水密，
          // 切片软件会报「非流形 / 模型有洞」。
          if (doB) {
            const pinPts = this.generateDowel2D(cu, cv, dia / 2.0, shape, 24, false);
            pinHolesB.push({ pts: pinPts });
            this.generatePinBoss(capFacesB, pinPts, cu, cv, dia / 2.0, pinLenL, shape, p0, n, uAxis, vAxis, modelOutward);
          }
        }

        if (skippedByThin > 0) {
          connWarnings.push(`有 ${skippedByThin} 个榫卯孔位所在处零件太薄（不足 ${(minWall + 0.1).toFixed(1)}mm），已跳过这些孔位；请加厚零件或把孔位往零件中心挪`);
        }
        if (minPinLen < Infinity && (minPinLen < halfLen - 1e-6 || minSocketDepth < halfLen + 0.5 - 1e-6)) {
          connWarnings.push(`零件偏薄或切面是斜的，φ${dia}×${length}mm 榫卯已按各孔位实际壁厚自动缩短为公榫 ${minPinLen.toFixed(2)}mm / 母槽 ${minSocketDepth.toFixed(2)}mm（两侧配对，各留 1.0mm 余量），如需完整长度请加厚零件`);
        }
      }

      // BOM 用量按「实际打出来的孔腔数」回填：某一侧太薄没打孔时，
      // 孔位仍在（connectorPoints 有值），但零件上并没有孔，不能按孔位×2 报数量。
      // 多个独立实体时要跨环累加，不能覆盖前一个环的用量。
      if (connectorBOM.details) {
        connectorBOM.details.totalQty = (connectorBOM.details.totalQty || 0) + holePolygonsA.length + holePolygonsB.length;
      }
      connectorBOM.count += holePolygonsA.length + holePolygonsB.length;

      // 将内孔加入 Earcut 输入
      for (const hp of holePolygonsA) {
        holeIndicesA.push(flatCoordsA.length / 2);
        for (const p of hp.pts) {
          flatCoordsA.push(p[0], p[1]);
        }
      }
      for (const hp of holePolygonsB) {
        holeIndicesB.push(flatCoordsB.length / 2);
        for (const p of hp.pts) {
          flatCoordsB.push(p[0], p[1]);
        }
      }
      // 公榫底环不参与封盖开孔：实测开孔后孔边界与凸台侧壁底边的绕向无法稳定对齐，
      // 反而多出几十条未配对边。改为凸台自带底面圆盘（与侧壁共用底环顶点），
      // 凸台本身是闭合壳，与封盖面贴合即可，水密性由凸台自己保证。
      if (pinHolesB.length > 0) pinHolesB.length = 0;

      // 执行三角剖分
      const trianglesA = earcut(flatCoordsA, holeIndicesA, 2);
      const trianglesB = earcut(flatCoordsB, holeIndicesB, 2);
      // 封盖三角形的绕向不能靠「earcut 输出 + 固定逆序」硬猜：
      // earcut 的输出绕向取决于输入环点的绕向（环点顺序又由线段拼接方向决定，可能正也可能反），
      // 叠加模型本身法线可能整体朝内，最终很容易和外壳绕向相反 —— 接缝处出现同向重复边（非流形）。
      // 这里改为逐个三角形按「期望的外法线方向」实测校正，无论输入怎么绕都能保证与外壳一致。
      // A 侧零件位于 +n 侧，其切面外法线朝 -n；B 侧反之。模型整体朝内时两者同时反向。
      const dirA = modelOutward ? -1 : 1;
      const dirB = modelOutward ? 1 : -1;
      const emitCap = (faces, p, q, r, dir) => {
        const ab = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const ac = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        const cr = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0]
        ];
        const dot = (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]) * dir;
        if (dot < 0) faces.push(...p, ...r, ...q);
        else faces.push(...p, ...q, ...r);
      };

      // Part A 封盖（该侧没有实体贴切面时整侧跳过）
      if (doA) {
        for (let i = 0; i < trianglesA.length; i += 3) {
          const i0 = trianglesA[i] * 2;
          const i1 = trianglesA[i + 1] * 2;
          const i2 = trianglesA[i + 2] * 2;

          const pA0 = this.to3D(flatCoordsA[i0], flatCoordsA[i0 + 1], p0, uAxis, vAxis);
          const pA1 = this.to3D(flatCoordsA[i1], flatCoordsA[i1 + 1], p0, uAxis, vAxis);
          const pA2 = this.to3D(flatCoordsA[i2], flatCoordsA[i2 + 1], p0, uAxis, vAxis);

          emitCap(capFacesA, pA0, pA1, pA2, dirA);
        }
      }

      // Part B 封盖
      if (doB) {
        for (let i = 0; i < trianglesB.length; i += 3) {
          const i0 = trianglesB[i] * 2;
          const i1 = trianglesB[i + 1] * 2;
          const i2 = trianglesB[i + 2] * 2;

          const pB0 = this.to3D(flatCoordsB[i0], flatCoordsB[i0 + 1], p0, uAxis, vAxis);
          const pB1 = this.to3D(flatCoordsB[i1], flatCoordsB[i1 + 1], p0, uAxis, vAxis);
          const pB2 = this.to3D(flatCoordsB[i2], flatCoordsB[i2 + 1], p0, uAxis, vAxis);

          emitCap(capFacesB, pB0, pB1, pB2, dirB);
        }
      }

      // 孔腔必须挖进「自己这块零件的肉里」：
      // Part A 是 +n 侧那一块，孔底要沿 +n 方向下沉；Part B 是 -n 侧，沿 -n 下沉。
      // 旧实现把两者写反了，A 侧磁铁沉孔挖到了切面另一侧（零件外面），
      // 打出来的 A 块表面是个光面、孔腔悬空在 B 块空间里，磁铁根本装不进去。
      // 孔腔与凸榫的绕向同样要跟随模型整体朝向：封盖已按 modelOutward 校正，
      // 若孔腔仍按固定方向生成，法线朝内的模型（CAD 导出/扫描件常见）上孔腔会与外壳反向，
      // 表现为「打了磁铁孔体积反而变大」（孔变成外凸柱）并产生大量未配对边。
      for (const hp of holePolygonsA) {
        this.generateHoleCavity(capFacesA, hp, 1, p0, n, uAxis, vAxis, modelOutward);
      }
      for (const hp of holePolygonsB) {
        this.generateHoleCavity(capFacesB, hp, -1, p0, n, uAxis, vAxis, modelOutward);
      }
    }

    return { capFacesA, capFacesB, connectorBOM, connWarnings };
  }

  /**
   * 生成盲孔内侧壁和孔底圆盘 (Cavity Mesh)
   * dir: -1 表示向 Part A 内部凹陷，+1 表示向 Part B 内部凹陷
   */
  static generateHoleCavity(faces, holeDef, dir, p0, n, uAxis, vAxis, modelOutward = true) {
    const pts = holeDef.pts;
    const numPts = pts.length;
    const depth = holeDef.depth;
    // 期望外法线的整体翻转系数：模型三角面整体朝内时，封盖绕向已整体反转，
    // 孔腔（侧壁指向孔轴、孔底朝孔口）必须同步反转，否则孔腔与外壳绕向相反。
    const outSign = modelOutward ? 1 : -1;

    // 沿 n 方向的位移向量
    const shift = [n[0] * depth * dir, n[1] * depth * dir, n[2] * depth * dir];

    const rim3D = pts.map(p => this.to3D(p[0], p[1], p0, uAxis, vAxis));
    const bot3D = rim3D.map(p => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
    const botCenter = this.to3D(holeDef.center[0], holeDef.center[1], p0, uAxis, vAxis);
    botCenter[0] += shift[0];
    botCenter[1] += shift[1];
    botCenter[2] += shift[2];

    // 侧壁圆柱面
    // 绕向不再按 dir 硬编码：孔腔是「空腔」，侧壁外法线必须指向孔轴、孔底外法线必须朝孔口，
    // 一旦与封盖的孔边界绕向相反，接缝处就出现同向重复边，零件不水密。
    // 这里逐个三角形按期望外法线实测校正，dir 怎么变都不会接错。
    const axisMid = [
      (rim3D[0][0] + bot3D[0][0]) / 2,
      (rim3D[0][1] + bot3D[0][1]) / 2,
      (rim3D[0][2] + bot3D[0][2]) / 2
    ];
    const axisCenter = this.to3D(holeDef.center[0], holeDef.center[1], p0, uAxis, vAxis);
    const axisMidExact = [
      axisCenter[0] + shift[0] / 2,
      axisCenter[1] + shift[1] / 2,
      axisCenter[2] + shift[2] / 2
    ];
    const pushOriented = (p, q, r, desired) => {
      const ab = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const ac = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const cr = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]
      ];
      const dot = cr[0] * desired[0] + cr[1] * desired[1] + cr[2] * desired[2];
      if (dot < 0) faces.push(...p, ...r, ...q);
      else faces.push(...p, ...q, ...r);
    };
    // 侧壁期望法线：由三角形质心指向孔轴
    const radialDir = (p, q, r) => {
      const cx = (p[0] + q[0] + r[0]) / 3;
      const cy = (p[1] + q[1] + r[1]) / 3;
      const cz = (p[2] + q[2] + r[2]) / 3;
      // 投影到切面上再指向轴心
      let dx = axisMidExact[0] - cx, dy = axisMidExact[1] - cy, dz = axisMidExact[2] - cz;
      const dn = dx * n[0] + dy * n[1] + dz * n[2];
      dx -= dn * n[0]; dy -= dn * n[1]; dz -= dn * n[2];
      if (Math.hypot(dx, dy, dz) < 1e-9) return [0, 0, 0];
      return [dx * outSign, dy * outSign, dz * outSign];
    };
    const floorDir = [-n[0] * dir * outSign, -n[1] * dir * outSign, -n[2] * dir * outSign];

    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      const r1 = rim3D[i], r2 = rim3D[next];
      const b1 = bot3D[i], b2 = bot3D[next];

      pushOriented(r1, r2, b2, radialDir(r1, r2, b2));
      pushOriented(r1, b2, b1, radialDir(r1, b2, b1));
    }

    // 孔底封盖
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      pushOriented(botCenter, bot3D[next], bot3D[i], floorDir);
    }
  }

  /**
   * 生成凸台插销 (Pin Boss with Chamfer) - 为 Part B 凸起
   * basePts2D：凸台底面圆环（与 Part B 封盖上开的孔共用同一组顶点，
   *            这样侧壁与封盖孔边共享边，零件才是水密实体）
   */
  static generatePinBoss(faces, basePts2D, cu, cv, radius, length, shape, p0, n, uAxis, vAxis, modelOutward = true) {
    const segments = basePts2D.length;
    if (!(length > 0.05) || !(radius > 0.05) || segments < 3) return;

    // 倒角必须按销子实际尺寸自适应：
    // 旧实现固定 1mm，销径小于 2mm 时「radius - 1」变成负数，倒角环翻到轴心另一侧；
    // 公榫长度被薄侧截到 1mm 以下时「length - 1」变负数，圆柱高度为负、几何自交。
    // 两种都会在接缝处产生大量未配对边，切片软件报非流形。
    let chamfer = Math.min(1.0, radius * 0.35, length * 0.35);
    if (chamfer < 0.05) chamfer = 0; // 极小的销子直接做平顶直柱

    // 顶点顺序固定按「外法线朝外」的右手系生成，不再逐面按法线纠正绕向。
    // 逐面纠正会让共享边在两个面里同向，接缝处永远配不上（每根销几十条开放边）。
    // 模型整体朝内时，最后统一反转每个三角形即可，内部接缝方向天然一致。
    //
    // 注意：base3D 由 generateDowel2D(..., ccw=false) 生成，在 u-v 平面上是顺时针，
    // 与 u×v 基的右手关系相反；若照抄「p,q,r」顺序，整个凸台壳会整体朝内
    // （有向体积为负，φ8×6 实测 -255.71mm³ 而理论 +301.59mm³）。切片软件会把这种
    // 「法线朝内的闭合壳」当成负体积/挖空，公榫在 B 零件上根本印不出来，装配时对不上。
    // 因此这里统一输出反向三角形（p,r,q），使凸台壳外法线朝外、有向体积为正。
    const start = faces.length;
    const pushTri = (p, q, r) => { faces.push(...p, ...r, ...q); };

    const base3D = basePts2D.map(p => this.to3D(p[0], p[1], p0, uAxis, vAxis));
    const numPts = base3D.length;

    const axisBase = this.to3D(cu, cv, p0, uAxis, vAxis);
    const shiftTop = [n[0] * length, n[1] * length, n[2] * length];
    const tipCenter = [axisBase[0] + shiftTop[0], axisBase[1] + shiftTop[1], axisBase[2] + shiftTop[2]];

    if (chamfer <= 0) {
      // 无倒角直柱
      const top3D = base3D.map(p => [p[0] + shiftTop[0], p[1] + shiftTop[1], p[2] + shiftTop[2]]);
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        pushTri(base3D[i], base3D[next], top3D[next]);
        pushTri(base3D[i], top3D[next], top3D[i]);
      }
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        pushTri(tipCenter, top3D[i], top3D[next]);
      }
    } else {
      const chamferPts2D = this.generateDowel2D(cu, cv, radius - chamfer, shape, segments, true);
      const hCylinder = length - chamfer;
      const shiftCyl = [n[0] * hCylinder, n[1] * hCylinder, n[2] * hCylinder];
      const topCyl3D = base3D.map(p => [p[0] + shiftCyl[0], p[1] + shiftCyl[1], p[2] + shiftCyl[2]]);
      const topChamfer3D = chamferPts2D.map(p => {
        const p3 = this.to3D(p[0], p[1], p0, uAxis, vAxis);
        return [p3[0] + shiftTop[0], p3[1] + shiftTop[1], p3[2] + shiftTop[2]];
      });

      // 1. 直身圆柱侧壁
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        pushTri(base3D[i], base3D[next], topCyl3D[next]);
        pushTri(base3D[i], topCyl3D[next], topCyl3D[i]);
      }
      // 2. 倒角斜面
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        pushTri(topCyl3D[i], topCyl3D[next], topChamfer3D[next]);
        pushTri(topCyl3D[i], topChamfer3D[next], topChamfer3D[i]);
      }
      // 3. 顶端平盘
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        pushTri(tipCenter, topChamfer3D[i], topChamfer3D[next]);
      }
    }

    // 4. 底面圆盘（与侧壁共用底环顶点，法线朝 -n）
    // 凸台必须自带底面：否则底部是一圈悬空边（每根销 24 条开放边），零件不水密。
    // 底面与切面封盖贴合（共面），凸台自身构成闭合壳。
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      pushTri(axisBase, base3D[next], base3D[i]);
    }

    // 模型整体朝内时统一反转每个三角形（含底面），内部接缝方向保持一致
    if (!modelOutward) {
      for (let i = start; i < faces.length; i += 9) {
        for (let k = 0; k < 3; k++) {
          const t = faces[i + 3 + k];
          faces[i + 3 + k] = faces[i + 6 + k];
          faces[i + 6 + k] = t;
        }
      }
    }
  }

  static generateCircle2D(cu, cv, r, segments, ccw = true) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const angle = (2 * Math.PI * i) / segments * (ccw ? 1 : -1);
      pts.push([cu + Math.cos(angle) * r, cv + Math.sin(angle) * r]);
    }
    return pts;
  }

  static generateDowel2D(cu, cv, r, shape, segments, ccw = true) {
    if (shape === 'd-shape') {
      // D型截面防呆销：圆弧截掉一侧平面
      const pts = [];
      const flatCutX = r * 0.45; // 一侧切平
      for (let i = 0; i < segments; i++) {
        const th = (2 * Math.PI * i) / segments;
        let x = Math.cos(th) * r;
        let y = Math.sin(th) * r;
        if (x > flatCutX) x = flatCutX; // 截平
        pts.push([cu + x, cv + y]);
      }
      return ccw ? pts : pts.reverse();
    } else if (shape === 'square') {
      const half = r * 0.9;
      const pts = [
        [cu - half, cv - half],
        [cu + half, cv - half],
        [cu + half, cv + half],
        [cu - half, cv + half]
      ];
      return ccw ? pts : pts.reverse();
    } else {
      return this.generateCircle2D(cu, cv, r, segments, ccw);
    }
  }

  // --- 基础向量几何工具函数 ---
  static normalize(v) {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return len > 1e-8 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
  }

  static cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  static lerp(a, b, t) {
    return [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      a[2] + t * (b[2] - a[2])
    ];
  }

  static to2D(p, p0, u, v) {
    const dx = p[0] - p0[0];
    const dy = p[1] - p0[1];
    const dz = p[2] - p0[2];
    return [
      dx * u[0] + dy * u[1] + dz * u[2],
      dx * v[0] + dy * v[1] + dz * v[2]
    ];
  }

  static to3D(uVal, vVal, p0, u, v) {
    return [
      p0[0] + uVal * u[0] + vVal * v[0],
      p0[1] + uVal * u[1] + vVal * v[1],
      p0[2] + uVal * u[2] + vVal * v[2]
    ];
  }

  static dist2D(p1, p2) {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  static polygonArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i][0] * pts[j][1];
      area -= pts[j][0] * pts[i][1];
    }
    return area / 2.0;
  }
}
