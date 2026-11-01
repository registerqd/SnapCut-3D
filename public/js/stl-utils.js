/**
 * SnapCut 3D - STL 解析与导出工具库
 * 支持二进制与 ASCII 格式解析，并提供高效的二进制 STL 打包导出
 */

export class STLUtils {
  /**
   * 从 ArrayBuffer 解析 STL 数据，返回包含 positions (Float32Array) 和 normals 的对象
   */
  static parse(buffer) {
    if (this.isBinary(buffer)) {
      return this.parseBinary(buffer);
    } else {
      const reader = new FileReader();
      const text = new TextDecoder().decode(buffer);
      return this.parseASCII(text);
    }
  }

  static isBinary(buffer) {
    if (buffer.byteLength < 84) return false;
    const reader = new DataView(buffer);
    const numFaces = reader.getUint32(80, true);
    const expectedSize = 84 + numFaces * 50;
    return Math.abs(expectedSize - buffer.byteLength) < 100;
  }

  static parseBinary(buffer) {
    const reader = new DataView(buffer);
    const numFaces = reader.getUint32(80, true);
    const positions = new Float32Array(numFaces * 9);
    const normals = new Float32Array(numFaces * 9);

    let offset = 84;
    let posIdx = 0;

    for (let face = 0; face < numFaces; face++) {
      if (offset + 50 > buffer.byteLength) break;

      const nx = reader.getFloat32(offset, true);
      const ny = reader.getFloat32(offset + 4, true);
      const nz = reader.getFloat32(offset + 8, true);

      const v1x = reader.getFloat32(offset + 12, true);
      const v1y = reader.getFloat32(offset + 16, true);
      const v1z = reader.getFloat32(offset + 20, true);

      const v2x = reader.getFloat32(offset + 24, true);
      const v2y = reader.getFloat32(offset + 28, true);
      const v2z = reader.getFloat32(offset + 32, true);

      const v3x = reader.getFloat32(offset + 36, true);
      const v3y = reader.getFloat32(offset + 40, true);
      const v3z = reader.getFloat32(offset + 44, true);

      // 顶点
      positions[posIdx] = v1x; positions[posIdx + 1] = v1y; positions[posIdx + 2] = v1z;
      positions[posIdx + 3] = v2x; positions[posIdx + 4] = v2y; positions[posIdx + 5] = v2z;
      positions[posIdx + 6] = v3x; positions[posIdx + 7] = v3y; positions[posIdx + 8] = v3z;

      // 法向 (若没有法向则由几何计算)
      normals[posIdx] = nx; normals[posIdx + 1] = ny; normals[posIdx + 2] = nz;
      normals[posIdx + 3] = nx; normals[posIdx + 4] = ny; normals[posIdx + 5] = nz;
      normals[posIdx + 6] = nx; normals[posIdx + 7] = ny; normals[posIdx + 8] = nz;

      posIdx += 9;
      offset += 50;
    }

    return {
      positions: positions.subarray(0, posIdx),
      normals: normals.subarray(0, posIdx),
      triangleCount: posIdx / 9
    };
  }

  static parseASCII(text) {
    const normalPattern = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
    const vertexPattern = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;

    const vertices = [];
    const normals = [];

    let normalMatch;
    let currentNormal = [0, 0, 0];

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('facet normal')) {
        const parts = line.split(/\s+/);
        currentNormal = [parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4])];
      } else if (line.startsWith('vertex')) {
        const parts = line.split(/\s+/);
        vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
        normals.push(...currentNormal);
      }
    }

    return {
      positions: new Float32Array(vertices),
      normals: new Float32Array(normals),
      triangleCount: vertices.length / 9
    };
  }

  /**
   * 将 positions (Float32Array) 打包为标准的二进制 STL 文件 ArrayBuffer
   */
  static exportBinarySTL(positions) {
    const triangleCount = Math.floor(positions.length / 9);
    const bufferSize = 84 + triangleCount * 50;
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // 80 字节头部
    const headerStr = 'SnapCut 3D Binary STL Exporter (with Snap/Magnet Connectors)';
    for (let i = 0; i < 80; i++) {
      view.setUint8(i, i < headerStr.length ? headerStr.charCodeAt(i) : 32);
    }

    // 三角面数量
    view.setUint32(80, triangleCount, true);

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
      const pIdx = i * 9;
      const v1x = positions[pIdx], v1y = positions[pIdx + 1], v1z = positions[pIdx + 2];
      const v2x = positions[pIdx + 3], v2y = positions[pIdx + 4], v2z = positions[pIdx + 5];
      const v3x = positions[pIdx + 6], v3y = positions[pIdx + 7], v3z = positions[pIdx + 8];

      // 计算三角面法向量
      const ax = v2x - v1x, ay = v2y - v1y, az = v2z - v1z;
      const bx = v3x - v1x, by = v3y - v1y, bz = v3z - v1z;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-6) {
        nx /= len; ny /= len; nz /= len;
      } else {
        nx = 0; ny = 0; nz = 1;
      }

      // 写入法向量
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);

      // 写入三顶点
      view.setFloat32(offset + 12, v1x, true);
      view.setFloat32(offset + 16, v1y, true);
      view.setFloat32(offset + 20, v1z, true);

      view.setFloat32(offset + 24, v2x, true);
      view.setFloat32(offset + 28, v2y, true);
      view.setFloat32(offset + 32, v2z, true);

      view.setFloat32(offset + 36, v3x, true);
      view.setFloat32(offset + 40, v3y, true);
      view.setFloat32(offset + 44, v3z, true);

      // 属性计数 (通常为 0)
      view.setUint16(offset + 48, 0, true);

      offset += 50;
    }

    return buffer;
  }

  /**
   * 将 ArrayBuffer 转为 Data URL (base64)
   */
  static bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return 'data:application/octet-stream;base64,' + btoa(binary);
  }

  /**
   * 触发浏览器直接下载 Blob
   */
  static downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
