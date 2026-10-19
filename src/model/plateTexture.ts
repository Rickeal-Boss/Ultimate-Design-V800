/**
 * plateTexture.ts —— R17 绿色新能源车牌（程序化 Canvas 贴花，双车前后共 4 牌）
 *
 * 用户指令（R17）：前后「绿色车牌位」（截图红框 = 尾门中央 MAEXTRO 条带下方 /
 * 前脸下部中央）。沿用 tailgate-maextro 先例：合批后运行时面片挂 body 下、
 * MeshBasic + 透明贴图 + depthWrite:false（无光照贴花，零合批交互、+1 DC/牌）。
 *
 * 中国新能源车牌视觉：绿渐变底 + 白字白框（小型车渐变绿号牌）。游戏内牌面文字
 * 取车型名（「尊界V800」/「智界R7」），纯文字性引用、商标免责见 README。
 */
import * as THREE from 'three';

/** 画布宽高比 3.5:1（标准号牌 440×140mm 口径） */
const W = 700;
const H = 200;

export function createGreenPlateTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  // 绿渐变底（左上亮 → 右下深，贴近实拍渐变绿号牌）
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#3E9A4E');
  grad.addColorStop(0.55, '#2E7D3E');
  grad.addColorStop(1, '#1F5F2E');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 白色外框（内缩 12px，圆角 18px）
  ctx.strokeStyle = '#F2F6EE';
  ctx.lineWidth = 10;
  const r = 18;
  const m = 14;
  ctx.beginPath();
  ctx.moveTo(m + r, m);
  ctx.arcTo(m, m, m, m + r, r);
  ctx.lineTo(m, H - m - r);
  ctx.arcTo(m, H - m, m + r, H - m, r);
  ctx.lineTo(W - m - r, H - m);
  ctx.arcTo(W - m, H - m, W - m, H - m - r, r);
  ctx.lineTo(W - m, m + r);
  ctx.arcTo(W - m, m, W - m - r, m, r);
  ctx.closePath();
  ctx.stroke();

  // 白字（粗体等宽观感；字距略放宽贴近号牌排版）
  ctx.fillStyle = '#F6FAF3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(H * 0.52)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  const chars = [...text];
  const adv = W / (chars.length + 1.2);
  chars.forEach((ch, i) => {
    ctx.fillText(ch, adv * (i + 1.1), H * 0.54, adv * 1.1);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface LicensePlateMount {
  body: THREE.Object3D;
  name: string;
  text: string;
  /** 面片宽×高（m，标准牌 0.44×0.126） */
  size: readonly [number, number];
  /** body 局部坐标（工厂语义：车头 +Z，与 tailgate-maextro 的 centerLocal 同系） */
  position: readonly [number, number, number];
  /** 朝向：默认 rotY(π)（面朝 -Z 车尾）；前牌传 0 面朝 +Z 车头 */
  faceRear?: boolean;
  ownedTextures: THREE.Texture[];
}

/**
 * 挂一块绿牌贴花到 body（合批后调用，天然不进合批）。
 * 位置由调用方用组件世界 bbox 实测反算（勿写死，见各 Adapter 注释）。
 */
export function mountLicensePlate(opts: LicensePlateMount): THREE.Mesh {
  const tex = createGreenPlateTexture(opts.text);
  opts.ownedTextures.push(tex);
  const geo = new THREE.PlaneGeometry(opts.size[0], opts.size[1]);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = opts.name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.position.set(opts.position[0], opts.position[1], opts.position[2]);
  mesh.rotation.y = opts.faceRear === false ? 0 : Math.PI;
  opts.body.add(mesh);
  return mesh;
}
