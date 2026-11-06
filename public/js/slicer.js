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

    // 1. 归一化平面法向与计算截距 D
    const n = this.normalize(planeDef.normal);
    const p0 = planeDef.point;
    // 平面方程: n[0]*x + n[1]*y + n[2]*z + D = 0
    const D = -(n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2]);

    const numTriangles = Math.floor(positions.length / 9);

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

    for (let i = 0; i < numTriangles; i++) {
      const idx = i * 9;
      const v0 = [positions[idx], positions[idx + 1], positions[idx + 2]];
      const v1 = [positions[idx + 3], positions[idx + 4], positions[idx + 5]];
      const v2 = [positions[idx + 6], positions[idx + 7], positions[idx + 8]];

      // 计算三点到平面的带符号距离
      const d0 = n[0] * v0[0] + n[1] * v0[1] + n[2] * v0[2] + D;
      const d1 = n[0] * v1[0] + n[1] * v1[1] + n[2] * v1[2] + D;
      const d2 = n[0] * v2[0] + n[1] * v2[1] + n[2] * v2[2] + D;

      const s0 = d0 > eps ? 1 : (d0 < -eps ? -1 : 0);
      const s1 = d1 > eps ? 1 : (d1 < -eps ? -1 : 0);
      const s2 = d2 > eps ? 1 : (d2 < -eps ? -1 : 0);

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
      // 整片贴在切割平面上：两侧零件都保留这一面
      if (s0 === 0 && s1 === 0 && s2 === 0) {
        trianglesA.push(...v0, ...v1, ...v2);
        trianglesB.push(...v0, ...v1, ...v2);
        continue;
      }

      // 三角形被切割: 找出孤立点和对侧两个点
      const pts = [v0, v1, v2];
      const dists = [d0, d1, d2];
      const signs = [s0, s1, s2];

      this.splitTriangle(pts, dists, signs, trianglesA, trianglesB, cutSegments, eps);
    }

    // 2. 建立切割平面的局部 2D 坐标系 (U, V)
    const { uAxis, vAxis } = this.createPlaneBasis(n);

    // 3. 将 3D 交线段投影为 2D 线段，并缝合为闭合多边形环 (Polygon Loops)
    //    切面穿过模型棱边时同一条棱会被相邻三角形各收集一次，先去重再拼接
    const uniqueSegments = this.dedupeSegments(cutSegments, eps);
    const loops = this.stitchSegmentsToLoops(uniqueSegments, p0, uAxis, vAxis);

    // 4. 计算连接件的锚点 (Anchor Points)
    const connectorPoints = this.determineConnectorPositions(loops, connectorConfig);

    // 5. 生成切面封盖网格与连接件孔洞/凸台
    const { capFacesA, capFacesB, connectorBOM } = this.generateCapsAndConnectors(
      loops,
      connectorPoints,
      connectorConfig,
      p0,
      n,
      uAxis,
      vAxis,
      earcut
    );

    // 6. 合并所有表面生成最终的 Part A 与 Part B
    trianglesA.push(...capFacesA);
    trianglesB.push(...capFacesB);

    const posArrayA = new Float32Array(trianglesA);
    const posArrayB = new Float32Array(trianglesB);

    const elapsed = Math.round(performance.now() - startTime);

    // 结果合法性自检：宁可明确告警，也不导出空壳/开口零件
    const warnings = [];
    const triCountA = Math.floor(posArrayA.length / 9);
    const triCountB = Math.floor(posArrayB.length / 9);
    if (triCountA === 0 || triCountB === 0) {
      warnings.push(`有一侧零件为空（A ${triCountA} 面 / B ${triCountB} 面）：切面可能正好贴在模型表面或超出模型范围，请把切面往里挪一点`);
    }
    if (loops.length === 0) {
      warnings.push('切面与模型没有形成闭合轮廓，本次未生成切面封盖，零件不是水密实体');
    }
    if (connectorConfig && connectorConfig.type !== 'none' && connectorPoints.length === 0) {
      warnings.push('切面过窄或形状特殊，没有找到能放下连接件的孔位（已自动跳过打孔），建议改用单孔或换更小的连接件');
    }

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

        // 在所有候选端点中取「最近的一个」而不是第一个落在容差内的，
        // 否则多个交点聚集处会被贪婪匹配串错，导致环自交、封盖三角剖分翻面
        let bestJ = -1;
        let bestDist = tol;
        let bestFlip = false;
        for (let j = 0; j < lines2D.length; j++) {
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
    const n = poly.length;
    // 当点数过多时做均匀跨步采样，保证交互流畅（最多采样 240 段边）
    const step = n > 240 ? Math.ceil(n / 240) : 1;
    for (let i = 0; i < n; i += step) {
      const j = (i + step) % n;
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
    if (config.placement === 'custom' && config.customPoints && config.customPoints.length > 0) {
      const inside = config.customPoints.filter(([u, v]) => this.pointInPolygon([u, v], mainLoop.points));
      if (inside.length === 0) return [];
      return this.validateConnectorPositions(inside, loops, mainLoop, config, false);
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
  static generateCapsAndConnectors(loops, connectorPoints, config, p0, n, uAxis, vAxis, earcut) {
    const capFacesA = [];
    const capFacesB = [];
    const connectorBOM = {
      type: config.type || 'none',
      count: 0,
      details: {}
    };

    if (loops.length === 0) {
      return { capFacesA, capFacesB, connectorBOM };
    }

    const type = config.type || 'none'; // 'none' | 'magnet' | 'dowel'

    // 1. 遍历每个闭合回路，为切面封盖
    for (const loop of loops) {
      if (loop.isHole) continue; // 先处理外环

      // 孔位按所属外环归属：一次切出多个独立实体时，不能把 A 块的孔也打到 B 块上，
      // 否则孔会落到 B 块轮廓之外，earcut 收到非法 holes，封盖面积和形状都会错。
      const loopPoints = connectorPoints.filter(([cu, cv]) => this.pointInPolygon([cu, cv], loop.points));
      connectorBOM.count += loopPoints.length;

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

      if (type === 'magnet') {
        const dia = config.magnet?.diameter || 6.0;
        const depth = config.magnet?.depth || 3.0;
        const clearance = config.magnet?.clearance || 0.2;
        const radius = (dia + clearance) / 2.0;
        const totalDepth = depth + 0.3; // 深度预留胶水与沉头公差

        if (!connectorBOM.details.name) {
          connectorBOM.details = {
            name: `φ${dia} × ${depth}mm 强磁沉头盲孔`,
            diameter: dia,
            depth: depth,
            clearance: clearance
          };
        }

        // 在每个孔位生成圆形内孔多边形 (20边形)
        for (const [cu, cv] of loopPoints) {
          const circlePtsA = this.generateCircle2D(cu, cv, radius, 20, false);
          const circlePtsB = this.generateCircle2D(cu, cv, radius, 20, false);
          holePolygonsA.push({ center: [cu, cv], radius, depth: totalDepth, pts: circlePtsA });
          holePolygonsB.push({ center: [cu, cv], radius, depth: totalDepth, pts: circlePtsB });
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
            shape: shape
          };
        }

        // Part A: 凹槽 Socket (半径加大 clearance，深度加 0.5mm)
        // Part B: 凸台 Pin (基准面保留，向外生长凸柱)
        for (const [cu, cv] of loopPoints) {
          const socketRadius = (dia + clearance) / 2.0;
          const socketDepth = halfLen + 0.5;
          const circleSocket = this.generateDowel2D(cu, cv, socketRadius, shape, 24, false);
          holePolygonsA.push({ center: [cu, cv], radius: socketRadius, depth: socketDepth, pts: circleSocket, shape });

          // Part B 将生成凸台 Pin
          this.generatePinBoss(capFacesB, cu, cv, dia / 2.0, halfLen, shape, p0, n, uAxis, vAxis);
        }
      }

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

      // 执行三角剖分
      const trianglesA = earcut(flatCoordsA, holeIndicesA, 2);
      const trianglesB = earcut(flatCoordsB, holeIndicesB, 2);

      // Part A 封盖：法向量指向负 n (-n)，顶点顺序调整以保证法向正确
      for (let i = 0; i < trianglesA.length; i += 3) {
        const i0 = trianglesA[i] * 2;
        const i1 = trianglesA[i + 1] * 2;
        const i2 = trianglesA[i + 2] * 2;

        const pA0 = this.to3D(flatCoordsA[i0], flatCoordsA[i0 + 1], p0, uAxis, vAxis);
        const pA1 = this.to3D(flatCoordsA[i1], flatCoordsA[i1 + 1], p0, uAxis, vAxis);
        const pA2 = this.to3D(flatCoordsA[i2], flatCoordsA[i2 + 1], p0, uAxis, vAxis);

        // 负法向: 逆序写入保证法向量朝向 -n
        capFacesA.push(...pA0, ...pA2, ...pA1);
      }

      // Part B 封盖：法向量指向正 n (+n)
      for (let i = 0; i < trianglesB.length; i += 3) {
        const i0 = trianglesB[i] * 2;
        const i1 = trianglesB[i + 1] * 2;
        const i2 = trianglesB[i + 2] * 2;

        const pB0 = this.to3D(flatCoordsB[i0], flatCoordsB[i0 + 1], p0, uAxis, vAxis);
        const pB1 = this.to3D(flatCoordsB[i1], flatCoordsB[i1 + 1], p0, uAxis, vAxis);
        const pB2 = this.to3D(flatCoordsB[i2], flatCoordsB[i2 + 1], p0, uAxis, vAxis);

        // 正法向
        capFacesB.push(...pB0, ...pB1, ...pB2);
      }

      // 为 Part A 生成孔洞侧壁与底盖 (沿 -n 凹陷)
      for (const hp of holePolygonsA) {
        this.generateHoleCavity(capFacesA, hp, -1, p0, n, uAxis, vAxis);
      }
      // 为 Part B 生成孔洞侧壁与底盖 (沿 +n 凹陷，对于磁铁沉孔)
      for (const hp of holePolygonsB) {
        this.generateHoleCavity(capFacesB, hp, 1, p0, n, uAxis, vAxis);
      }
    }

    if (type === 'magnet') {
      connectorBOM.details.totalQty = connectorBOM.count * 2;
    } else if (type === 'dowel') {
      connectorBOM.details.totalQty = connectorBOM.count;
    }

    return { capFacesA, capFacesB, connectorBOM };
  }

  /**
   * 生成盲孔内侧壁和孔底圆盘 (Cavity Mesh)
   * dir: -1 表示向 Part A 内部凹陷，+1 表示向 Part B 内部凹陷
   */
  static generateHoleCavity(faces, holeDef, dir, p0, n, uAxis, vAxis) {
    const pts = holeDef.pts;
    const numPts = pts.length;
    const depth = holeDef.depth;

    // 沿 n 方向的位移向量
    const shift = [n[0] * depth * dir, n[1] * depth * dir, n[2] * depth * dir];

    const rim3D = pts.map(p => this.to3D(p[0], p[1], p0, uAxis, vAxis));
    const bot3D = rim3D.map(p => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
    const botCenter = this.to3D(holeDef.center[0], holeDef.center[1], p0, uAxis, vAxis);
    botCenter[0] += shift[0];
    botCenter[1] += shift[1];
    botCenter[2] += shift[2];

    // 侧壁圆柱面
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      const r1 = rim3D[i], r2 = rim3D[next];
      const b1 = bot3D[i], b2 = bot3D[next];

      if (dir === -1) {
        // Part A 内部法向
        faces.push(...r1, ...r2, ...b2);
        faces.push(...r1, ...b2, ...b1);
      } else {
        // Part B 内部法向
        faces.push(...r1, ...b2, ...r2);
        faces.push(...r1, ...b1, ...b2);
      }
    }

    // 孔底封盖
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      if (dir === -1) {
        faces.push(...botCenter, ...bot3D[next], ...bot3D[i]);
      } else {
        faces.push(...botCenter, ...bot3D[i], ...bot3D[next]);
      }
    }
  }

  /**
   * 生成凸台插销 (Pin Boss with Chamfer) - 为 Part B 凸起
   */
  static generatePinBoss(faces, cu, cv, radius, length, shape, p0, n, uAxis, vAxis) {
    const segments = 24;
    // 自适应倒角：不超过半径的 35%，且不超过长度的 35%，最大不超过 1.0mm
    let chamfer = Math.min(1.0, radius * 0.35, length * 0.35);
    if (chamfer < 0.05) chamfer = 0; // 过小时不做倒角，直接平顶直柱

    const basePts2D = this.generateDowel2D(cu, cv, radius, shape, segments, true);
    const chamferPts2D = chamfer > 0 ? this.generateDowel2D(cu, cv, Math.max(0.01, radius - chamfer), shape, segments, true) : null;

    const base3D = basePts2D.map(p => this.to3D(p[0], p[1], p0, uAxis, vAxis));

    // 主圆柱顶部 (到达倒角处)
    const hCylinder = Math.max(0, length - chamfer);
    const shiftCyl = [n[0] * hCylinder, n[1] * hCylinder, n[2] * hCylinder];
    const topCyl3D = base3D.map(p => [p[0] + shiftCyl[0], p[1] + shiftCyl[1], p[2] + shiftCyl[2]]);

    const shiftTop = [n[0] * length, n[1] * length, n[2] * length];
    const tipCenter = this.to3D(cu, cv, p0, uAxis, vAxis);
    tipCenter[0] += shiftTop[0];
    tipCenter[1] += shiftTop[1];
    tipCenter[2] += shiftTop[2];

    const numPts = base3D.length;

    // 1. 直身圆柱侧壁
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      faces.push(...base3D[i], ...topCyl3D[next], ...base3D[next]);
      faces.push(...base3D[i], ...topCyl3D[i], ...topCyl3D[next]);
    }

    if (chamfer > 0 && chamferPts2D) {
      // 2. 倒角斜面
      const topChamfer3D = chamferPts2D.map(p => {
        const p3 = this.to3D(p[0], p[1], p0, uAxis, vAxis);
        return [p3[0] + shiftTop[0], p3[1] + shiftTop[1], p3[2] + shiftTop[2]];
      });
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        faces.push(...topCyl3D[i], ...topChamfer3D[next], ...topCyl3D[next]);
        faces.push(...topCyl3D[i], ...topChamfer3D[i], ...topChamfer3D[next]);
      }
      // 3. 顶端平盘
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        faces.push(...tipCenter, ...topChamfer3D[i], ...topChamfer3D[next]);
      }
    } else {
      // 无倒角平顶盘
      for (let i = 0; i < numPts; i++) {
        const next = (i + 1) % numPts;
        faces.push(...tipCenter, ...topCyl3D[i], ...topCyl3D[next]);
      }
    }

    // 4. 凸台底面封闭盘（法向朝 -n，与侧壁共用底环顶点，构成完全封闭的水密壳体）
    const baseCenter = this.to3D(cu, cv, p0, uAxis, vAxis);
    for (let i = 0; i < numPts; i++) {
      const next = (i + 1) % numPts;
      faces.push(...baseCenter, ...base3D[next], ...base3D[i]);
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
