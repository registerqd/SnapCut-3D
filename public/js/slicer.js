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

    const eps = 1e-5;

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

      // 全部在正侧
      if (s0 >= 0 && s1 >= 0 && s2 >= 0) {
        trianglesA.push(...v0, ...v1, ...v2);
        continue;
      }
      // 全部在负侧
      if (s0 <= 0 && s1 <= 0 && s2 <= 0) {
        trianglesB.push(...v0, ...v1, ...v2);
        continue;
      }

      // 三角形被切割: 找出孤立点和对侧两个点
      const pts = [v0, v1, v2];
      const dists = [d0, d1, d2];
      const signs = [s0, s1, s2];

      this.splitTriangle(pts, dists, signs, trianglesA, trianglesB, cutSegments);
    }

    // 2. 建立切割平面的局部 2D 坐标系 (U, V)
    const { uAxis, vAxis } = this.createPlaneBasis(n);

    // 3. 将 3D 交线段投影为 2D 线段，并缝合为闭合多边形环 (Polygon Loops)
    const loops = this.stitchSegmentsToLoops(cutSegments, p0, uAxis, vAxis);

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

    return {
      partA: posArrayA,
      partB: posArrayB,
      cutLoopsCount: loops.length,
      connectorCount: connectorPoints.length,
      connectorPoints: connectorPoints,
      bom: connectorBOM,
      elapsedMs: elapsed
    };
  }

  /**
   * 将被切割的三角形分割为 1 个小三角形和 1 个四边形 (2个三角形)
   */
  static splitTriangle(pts, dists, signs, outA, outB, cutSegments) {
    // 找出处于单独一侧的顶点索引
    let singleIdx = 0;
    if (signs[0] === signs[1] && signs[0] !== signs[2]) singleIdx = 2;
    else if (signs[1] === signs[2] && signs[1] !== signs[0]) singleIdx = 0;
    else if (signs[0] === signs[2] && signs[0] !== signs[1]) singleIdx = 1;

    const i0 = singleIdx;
    const i1 = (singleIdx + 1) % 3;
    const i2 = (singleIdx + 2) % 3;

    const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2];
    const d0 = dists[i0], d1 = dists[i1], d2 = dists[i2];

    // 插值求两边与平面的交点
    const t01 = d0 / (d0 - d1);
    const e01 = this.lerp(p0, p1, t01);

    const t02 = d0 / (d0 - d2);
    const e02 = this.lerp(p0, p2, t02);

    const singleIsPos = dists[i0] > 0;

    if (singleIsPos) {
      // p0 在正侧 (A侧 1个三角，B侧 2个三角)
      outA.push(...p0, ...e01, ...e02);
      outB.push(...e01, ...p1, ...p2);
      outB.push(...e01, ...p2, ...e02);
      // 切面线段，方向从 e01 到 e02
      cutSegments.push({ p1: e01, p2: e02 });
    } else {
      // p0 在负侧 (B侧 1个三角，A侧 2个三角)
      outB.push(...p0, ...e01, ...e02);
      outA.push(...e01, ...p1, ...p2);
      outA.push(...e01, ...p2, ...e02);
      // 切面线段，方向从 e02 到 e01
      cutSegments.push({ p1: e02, p2: e01 });
    }
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
    const tol = 0.15; // 0.15mm 连接容差

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

        for (let j = 0; j < lines2D.length; j++) {
          if (lines2D[j].used) continue;

          // 检查正向相接
          if (this.dist2D(currentEnd, lines2D[j].a) < tol) {
            currentLoop.push(lines2D[j].b);
            lines2D[j].used = true;
            foundNext = true;
            break;
          }
          // 检查反向相接
          if (this.dist2D(currentEnd, lines2D[j].b) < tol) {
            currentLoop.push(lines2D[j].a);
            lines2D[j].used = true;
            foundNext = true;
            break;
          }
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
        // 忽略面积极小的杂散微多边形
        if (Math.abs(area) > 1.0) {
          loops.push({
            points: currentLoop.slice(0, -1), // 去除重复末尾
            area: area,
            isHole: area < 0
          });
        }
      }
    }

    return loops;
  }

  /**
   * 自动计算连接件在切面 2D 平面上的放置坐标
   */
  static determineConnectorPositions(loops, config) {
    if (!config || config.type === 'none' || loops.length === 0) return [];

    // 找到面积最大的外环
    let mainLoop = loops[0];
    for (const l of loops) {
      if (!l.isHole && l.area > mainLoop.area) {
        mainLoop = l;
      }
    }

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

    // 用户自定义点
    if (config.placement === 'custom' && config.customPoints && config.customPoints.length > 0) {
      return config.customPoints;
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

    return positions;
  }

  /**
   * 生成封闭切面三角网格与连接件（沉头孔 / 公母榫卯）
   */
  static generateCapsAndConnectors(loops, connectorPoints, config, p0, n, uAxis, vAxis, earcut) {
    const capFacesA = [];
    const capFacesB = [];
    const connectorBOM = {
      type: config.type || 'none',
      count: connectorPoints.length,
      details: {}
    };

    if (loops.length === 0) {
      return { capFacesA, capFacesB, connectorBOM };
    }

    const type = config.type || 'none'; // 'none' | 'magnet' | 'dowel'

    // 1. 遍历每个闭合回路，为切面封盖
    for (const loop of loops) {
      if (loop.isHole) continue; // 先处理外环

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

      // 如果启用了磁铁沉孔或定位凹槽
      const holePolygonsA = [];
      const holePolygonsB = [];

      if (type === 'magnet') {
        const dia = config.magnet?.diameter || 6.0;
        const depth = config.magnet?.depth || 3.0;
        const clearance = config.magnet?.clearance || 0.2;
        const radius = (dia + clearance) / 2.0;
        const totalDepth = depth + 0.3; // 深度预留胶水与沉头公差

        connectorBOM.details = {
          name: `φ${dia} × ${depth}mm 强磁沉头盲孔`,
          diameter: dia,
          depth: depth,
          clearance: clearance,
          totalQty: connectorPoints.length * 2
        };

        // 在每个孔位生成圆形内孔多边形 (20边形)
        for (const [cu, cv] of connectorPoints) {
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

        connectorBOM.details = {
          name: `${shape === 'd-shape' ? 'D型防呆销' : '圆柱销'} (φ${dia}×${length}mm)`,
          diameter: dia,
          length: length,
          clearance: clearance,
          shape: shape
        };

        // Part A: 凹槽 Socket (半径加大 clearance，深度加 0.5mm)
        // Part B: 凸台 Pin (基准面保留，向外生长凸柱)
        for (const [cu, cv] of connectorPoints) {
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
    const chamfer = 1.0; // 1mm 45° 倒角
    const basePts2D = this.generateDowel2D(cu, cv, radius, shape, segments, true);
    const chamferPts2D = this.generateDowel2D(cu, cv, radius - chamfer, shape, segments, true);

    const base3D = basePts2D.map(p => this.to3D(p[0], p[1], p0, uAxis, vAxis));

    // 主圆柱顶部 (到达倒角处)
    const hCylinder = length - chamfer;
    const shiftCyl = [n[0] * hCylinder, n[1] * hCylinder, n[2] * hCylinder];
    const topCyl3D = base3D.map(p => [p[0] + shiftCyl[0], p[1] + shiftCyl[1], p[2] + shiftCyl[2]]);

    // 倒角顶部
    const shiftTop = [n[0] * length, n[1] * length, n[2] * length];
    const topChamfer3D = chamferPts2D.map(p => {
      const p3 = this.to3D(p[0], p[1], p0, uAxis, vAxis);
      return [p3[0] + shiftTop[0], p3[1] + shiftTop[1], p3[2] + shiftTop[2]];
    });

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

    // 2. 倒角斜面
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
