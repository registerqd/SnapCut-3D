import * as THREE from '../lib/three.module.js';
import { OrbitControls } from '../lib/controls/OrbitControls.js';

export class ModelViewer {
  constructor(canvasContainerId) {
    this.container = document.getElementById(canvasContainerId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;

    // 核心对象容器
    this.printerBedGroup = new THREE.Group();
    this.modelGroup = new THREE.Group();
    this.slicePlaneHelper = null;
    this.partAGroup = new THREE.Group();
    this.partBGroup = new THREE.Group();
    this.connectorMarkersGroup = new THREE.Group();

    // 状态
    this.currentPrinterSize = { x: 180, y: 180, z: 180 };
    this.currentModelBBox = null;
    this.planeParams = {
      axis: 'Z',
      offset: 0,
      tiltX: 0,
      tiltY: 0
    };
    this.isExploded = false;
    this.explodeDistance = 25; // mm

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;

    // 1. 场景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x131720);

    // 2. 相机
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    this.camera.position.set(220, 240, 320);

    // 3. 渲染器
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // 4. 控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.05; // 限制不能看到地平面完全下方

    // 5. 灯光
    this.setupLights();

    // 6. 添加层级组
    this.scene.add(this.printerBedGroup);
    this.scene.add(this.modelGroup);
    this.scene.add(this.partAGroup);
    this.scene.add(this.partBGroup);
    this.scene.add(this.connectorMarkersGroup);

    // 7. 构建初始打印床
    this.updatePrinterBed(this.currentPrinterSize);

    // 8. 创建初始切面指示器
    this.createSlicePlaneHelper();

    // 9. 窗口尺寸自适应
    window.addEventListener('resize', () => this.onResize());

    // 10. 循环渲染
    this.animate();
  }

  setupLights() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(250, 400, 300);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.bias = -0.0001;
    this.scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x7090b0, 0.6);
    fillLight.position.set(-200, 200, -200);
    this.scene.add(fillLight);

    const bottomBounce = new THREE.DirectionalLight(0x304050, 0.4);
    bottomBounce.position.set(0, -100, 0);
    this.scene.add(bottomBounce);
  }

  /**
   * 绘制 3D 打印机打印床与透明成型空间立方体框
   */
  updatePrinterBed(size) {
    this.currentPrinterSize = size;
    // 清除旧床
    while (this.printerBedGroup.children.length > 0) {
      const obj = this.printerBedGroup.children[0];
      this.printerBedGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }

    const { x, y, z } = size;

    // 1. 底板网格 (以 Y 为高度轴，X 和 Z 为床面)
    const gridHelper = new THREE.GridHelper(Math.max(x, y), Math.max(x, y) / 10, 0x00e5a3, 0x2e384d);
    gridHelper.position.y = 0;
    this.printerBedGroup.add(gridHelper);

    // 2. 打印床边框
    const bedGeo = new THREE.BoxGeometry(x, 2, y);
    const bedMat = new THREE.MeshStandardMaterial({
      color: 0x1e2430,
      metalness: 0.2,
      roughness: 0.8
    });
    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.position.y = -1;
    bedMesh.receiveShadow = true;
    this.printerBedGroup.add(bedMesh);

    // 3. 成型空间透明虚线框 (高度为 Z)
    const boxGeo = new THREE.BoxGeometry(x, z, y);
    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.45
    });
    const chamberLines = new THREE.LineSegments(edgesGeo, edgeMat);
    chamberLines.position.y = z / 2;
    this.printerBedGroup.add(chamberLines);
  }

  /**
   * 创建切面动态指示器 (切割刀)
   */
  createSlicePlaneHelper() {
    if (this.slicePlaneHelper) {
      this.scene.remove(this.slicePlaneHelper);
    }
    const group = new THREE.Group();

    // 半透明切片板 (宽 400 x 400)
    const planeGeo = new THREE.PlaneGeometry(360, 360);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x00e5a3,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);

    // 高亮边缘线
    const edges = new THREE.EdgesGeometry(planeGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00e5a3, linewidth: 2 });
    const lineMesh = new THREE.LineSegments(edges, lineMat);

    // 法向量箭头
    const dir = new THREE.Vector3(0, 0, 1);
    const origin = new THREE.Vector3(0, 0, 0);
    const arrow = new THREE.ArrowHelper(dir, origin, 30, 0xff6b4a, 8, 4);

    group.add(planeMesh);
    group.add(lineMesh);
    group.add(arrow);

    this.slicePlaneHelper = group;
    this.scene.add(this.slicePlaneHelper);
    this.updateSlicePlaneTransform();
  }

  /**
   * 更新切刀的位置与朝向
   */
  setSlicePlane(axis, offset, tiltX = 0, tiltY = 0) {
    this.planeParams = { axis, offset, tiltX, tiltY };
    this.updateSlicePlaneTransform();
  }

  updateSlicePlaneTransform() {
    if (!this.slicePlaneHelper) return;

    const { axis, offset, tiltX, tiltY } = this.planeParams;
    const radX = (tiltX * Math.PI) / 180;
    const radY = (tiltY * Math.PI) / 180;

    // 重置变换
    this.slicePlaneHelper.position.set(0, 0, 0);
    this.slicePlaneHelper.rotation.set(0, 0, 0);

    // 默认 PlaneGeometry 位于 XY 平面，法线沿 +Z
    // 我们将 Three.js 世界坐标系设定为: Y 为竖直高度，X/Z 为水平切面
    if (axis === 'Y' || axis === 'height') {
      // 水平切刀: 法线沿竖直 Y 轴
      this.slicePlaneHelper.rotation.x = Math.PI / 2;
      this.slicePlaneHelper.position.y = offset;
      this.slicePlaneHelper.rotation.z += radX;
      this.slicePlaneHelper.rotation.x += radY;
    } else if (axis === 'X') {
      // 沿 X 轴竖切: 法线沿 X 轴
      this.slicePlaneHelper.rotation.y = Math.PI / 2;
      this.slicePlaneHelper.position.x = offset;
      this.slicePlaneHelper.rotation.z += radX;
      this.slicePlaneHelper.rotation.y += radY;
    } else {
      // 沿 Z 轴竖切: 法线沿 Z 轴
      this.slicePlaneHelper.position.z = offset;
      this.slicePlaneHelper.rotation.x += radX;
      this.slicePlaneHelper.rotation.y += radY;
    }
  }

  /**
   * 获取当前的切面数学定义 { normal: [nx, ny, nz], point: [px, py, pz] }
   */
  getPlaneDefinition() {
    const normal = new THREE.Vector3(0, 0, 1);
    const euler = this.slicePlaneHelper.rotation;
    normal.applyEuler(euler).normalize();

    const point = this.slicePlaneHelper.position;

    return {
      normal: [normal.x, normal.y, normal.z],
      point: [point.x, point.y, point.z]
    };
  }

  /**
   * 显示/隐藏切面指示器
   */
  setSlicePlaneVisible(visible) {
    if (this.slicePlaneHelper) {
      this.slicePlaneHelper.visible = visible;
    }
  }

  /**
   * 加载并展示原模型网格
   */
  displayOriginalModel(positions) {
    this.clearModel();
    this.clearCutParts();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    // 调整模型使其底面贴紧地面 Y=0，中心对准 (0, 0)
    const bbox = geometry.boundingBox;
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // 将几何体平移到床面中心
    geometry.translate(-center.x, -bbox.min.y, -center.z);
    geometry.computeBoundingBox();
    this.currentModelBBox = geometry.boundingBox;

    const material = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.4,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // 添加优雅的线框辅助
    const wireMat = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.3 });
    const wireframe = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), wireMat);

    this.modelGroup.add(mesh);
    this.modelGroup.add(wireframe);

    // 自动聚焦
    this.fitCameraToBox(geometry.boundingBox);

    return {
      size: {
        x: bbox.max.x - bbox.min.x,
        y: bbox.max.y - bbox.min.y,
        z: bbox.max.z - bbox.min.z
      },
      center: center,
      min: bbox.min,
      max: bbox.max
    };
  }

  /**
   * 展示切片后生成的 Part A 与 Part B
   */
  displayCutParts(positionsA, positionsB, connectorPoints, planeDef) {
    this.modelGroup.visible = false;
    this.setSlicePlaneVisible(false);
    this.clearCutParts();

    // Part A (科技青色)
    const geoA = new THREE.BufferGeometry();
    geoA.setAttribute('position', new THREE.BufferAttribute(positionsA, 3));
    geoA.computeVertexNormals();
    const matA = new THREE.MeshStandardMaterial({
      color: 0x00e5a3,
      roughness: 0.35,
      metalness: 0.15
    });
    const meshA = new THREE.Mesh(geoA, matA);
    meshA.castShadow = true;
    meshA.receiveShadow = true;
    this.partAGroup.add(meshA);

    // Part B (活力橙色)
    const geoB = new THREE.BufferGeometry();
    geoB.setAttribute('position', new THREE.BufferAttribute(positionsB, 3));
    geoB.computeVertexNormals();
    const matB = new THREE.MeshStandardMaterial({
      color: 0xff6b4a,
      roughness: 0.35,
      metalness: 0.15
    });
    const meshB = new THREE.Mesh(geoB, matB);
    meshB.castShadow = true;
    meshB.receiveShadow = true;
    this.partBGroup.add(meshB);

    // 默认开启爆开分离动效以供用户清晰检视切面与孔洞
    this.setExplode(true, planeDef.normal, this.explodeDistance);
  }

  /**
   * 爆炸视图动效：沿切面法向两向分离
   */
  setExplode(enabled, normalVec, distance = 25) {
    this.isExploded = enabled;
    const n = new THREE.Vector3(...normalVec).normalize();
    const dist = enabled ? distance : 0;

    this.partAGroup.position.set(n.x * dist, n.y * dist, n.z * dist);
    this.partBGroup.position.set(-n.x * dist, -n.y * dist, -n.z * dist);
  }

  /**
   * 一键平放至打印床：将 A/B 两件以切面朝下，平铺并排放置在打印床上
   */
  layFlatOnBed(normalVec) {
    this.setExplode(false, normalVec, 0);

    const n = new THREE.Vector3(...normalVec).normalize();

    // 计算旋转四元数：将法线 n 对齐到 -Y (使切面成为底面)
    const targetA = new THREE.Vector3(0, -1, 0);
    const qA = new THREE.Quaternion().setFromUnitVectors(n, targetA);

    // 对 B 件，由于其切面法向相反，对齐到 -Y
    const targetB = new THREE.Vector3(0, -1, 0);
    const nB = n.clone().negate();
    const qB = new THREE.Quaternion().setFromUnitVectors(nB, targetB);

    this.partAGroup.setRotationFromQuaternion(qA);
    this.partBGroup.setRotationFromQuaternion(qB);

    // 左右错开摆放
    this.partAGroup.position.set(-50, 0, 0);
    this.partBGroup.position.set(50, 0, 0);
  }

  /**
   * 重置回组装贴合状态
   */
  resetAssembleState() {
    this.partAGroup.rotation.set(0, 0, 0);
    this.partBGroup.rotation.set(0, 0, 0);
    this.partAGroup.position.set(0, 0, 0);
    this.partBGroup.position.set(0, 0, 0);
  }

  fitCameraToBox(box) {
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.8;
    cameraZ = Math.max(cameraZ, 180);

    this.camera.position.set(cameraZ * 0.8, cameraZ * 0.9, cameraZ * 1.1);
    this.camera.lookAt(0, size.y / 2, 0);
    this.controls.target.set(0, size.y / 2, 0);
    this.controls.update();
  }

  clearModel() {
    while (this.modelGroup.children.length > 0) {
      const obj = this.modelGroup.children[0];
      this.modelGroup.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    this.modelGroup.visible = true;
  }

  clearCutParts() {
    [this.partAGroup, this.partBGroup].forEach(group => {
      while (group.children.length > 0) {
        const obj = group.children[0];
        group.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
      group.position.set(0, 0, 0);
      group.rotation.set(0, 0, 0);
    });
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
