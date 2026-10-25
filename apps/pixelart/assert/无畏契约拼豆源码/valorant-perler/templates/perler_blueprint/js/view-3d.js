/* =====================================================================
 * [VIEW-3D] 3D 看法 BEGIN
 * 图纸视图的第二种看法：把当前 grid 渲染成 3D 豆板（空心豆、烫豆模拟），侧栏、色板、色数档位、编辑态、存档与平面看法完全共用。
 * 3D 只负责渲染与拾格：draw() 在 3D 看法下调用 V3.sync() 把矩阵（含编辑预览）写进豆板纹理；cellAt() 调用 V3.cell() 射线拾格，
 * 编辑态的画笔 / 填充 / 橡皮 / 吸管、撤销重做、保存照常走编辑态模块。
 * 编辑中被改动的格子（含撤销、放弃）重新落一颗豆，再局部熨烫回当前熔化度：uStamp 纹理记每格改动时刻，大片改动按离光标的距离依次落下。
 * 指针：浏览时左键环视、右键平移；编辑时左键归工具，板外左键 / 右键环视，中键平移，按住空格左键临时环视。
 * three 0.160 + OrbitControls 由构建脚本内联进页面；浏览器不支持 WebGL2 时 3D 按钮置灰。
 * ===================================================================== */
const V3 = (() => {
  const THREE = window.THREE, OrbitControls = window.OrbitControls;
  if (!THREE || !OrbitControls) return null;
  const QS3 = new URLSearchParams(location.search);
  const wrap = document.getElementById('v3Wrap');
  const S = { n: 0, w: 0, h: 0, shown: null, orbiting: false, hintCtx: null, hintSeen: {}, top: QS3.get('cam') === 'top', failed: false };
  let renderer = null, scene = null, camera = null, controls = null, boardGroup = null, boardParts = [], ground = null, gridHelp = null;
  let beadMesh = null, gridTex = null, gridData = null, stampTex = null, stampData = null, stateTex = null, stateData = null;
  const tmpMat4 = new THREE.Matrix4();

  // ---- 豆子：参数化空心管 + GPU 熔化 ----
  // 几何只存 (u=绕轴角度, v=截面轮廓位置) 参数；真实形状由顶点着色器按熔化度 m 与邻格占用实时生成。
  // 截面轮廓 v：内壁 [0,.2] → 内沿倒角 [.2,.35] → 顶面 [.35,.6] → 外沿倒角 [.6,.8] → 外壁 [.8,1]
  const PROFILE_V = [0, 0.2, 0.25, 0.3, 0.35, 0.6, 0.65, 0.7, 0.75, 0.8, 1.0];
  function makeBeadGeo(radial) {
    const P = PROFILE_V.length, cols = radial + 1;
    const uv = new Float32Array(cols * P * 2);
    for (let i = 0; i < cols; i++) for (let j = 0; j < P; j++) {
      const k = (i * P + j) * 2; uv[k] = i / radial; uv[k + 1] = PROFILE_V[j];
    }
    const idx = [];
    for (let i = 0; i < radial; i++) for (let j = 0; j < P - 1; j++) {
      const a = i * P + j, b = (i + 1) * P + j, c = i * P + j + 1, d = (i + 1) * P + j + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cols * P * 3), 3));
    g.setAttribute('aUV', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  const U = {
    uGrid: { value: null },
    uDims: { value: new THREE.Vector2(1, 1) },   // 板格数 (列, 行)
    uProgress: { value: 0 },
    uHole: { value: 0.14 }, // 内径 / 外径 = 35%，贴近实物
    uStamp: { value: null },
    uTime: { value: 0 },
    uState: { value: null },   // [3D-PROGRESS] 每格施工状态：0 成品 / 1 已拼 / 2 正在拼 / 3 还没拼
    uHasCur: { value: 0 },     // [3D-PROGRESS] 有在拼色时为 1：已拼的也退后，注意力只给在拼色
    uIron: { value: new THREE.Vector4(0, 0, 1, 1) }, // [IRON] 烫法：x 0无孔/1澡巾/2毛巾/3细闪与粗闪、y 纹理强度、z 纹理尺度（格）、w 全局熔化度
    uIronP: { value: new THREE.Vector3(0, 0, 0) },   // [IRON] 烫法专属参数（与平面 iron-gl.js 的 uP 同口径）
    uGlit: { value: new THREE.Vector4(1, 0, 0, 140) },
    uIronOn: { value: 0 },                              // [IRON] 1 = 烫豆预览中：朝上的豆面改按平面同一套公式出色（平面为准）
    uIronMat: { value: new THREE.Vector4(.56, .48, .12, 22) }, // [IRON] 当前烫法的材质：漫反射底、漫反射、高光强度、高光锐度（IRON_STYLES.mat）    // [IRON] 细闪 / 粗闪：闪片格边长（格）、有闪片比例、常亮程度（与平面 uGlit 同口径）
  };

  const GLSL_COMMON = /* glsl */`
  uniform float uHasCur;
  uniform sampler2D uGrid;
  uniform vec2 uDims;   // 板格数 (宽, 高)
  uniform float uProgress;
  uniform sampler2D uStamp;   // 每格最近一次被编辑的时刻（秒，0 = 未编辑）
  uniform float uTime;
  uniform sampler2D uState;
  uniform vec4 uIron; uniform vec3 uIronP; uniform vec4 uGlit; uniform float uIronOn; uniform vec4 uIronMat;
  float cellState(vec2 c) { return floor(texelFetch(uState, ivec2(c), 0).r * 255.0 + 0.5); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float cellStamp(vec2 c) { return texelFetch(uStamp, ivec2(clamp(c, vec2(0.0), uDims - 1.0)), 0).r; }
  // 熨斗从左上角斜向扫过：每格的开始熔化时刻 = 扫描位置 + 少量随机（受热不均）
  float cellMelt(vec2 c) {
    float s = (c.x + c.y) / max(uDims.x + uDims.y - 2.0, 1.0);
    float st = s * 0.55 + hash12(c) * 0.08;
    float m = clamp((uProgress - st) / 0.35, 0.0, 1.0);
    m = m * m * (3.0 - 2.0 * m);
    // 被编辑过的格：新豆落下后局部重新熨烫，熔化度不超过全局进度
    float e = cellStamp(c);
    if (e > 0.0) { float a = clamp((uTime - e - 0.14) / 0.55, 0.0, 1.0); m = min(m, a * a * (3.0 - 2.0 * a)); }
    return m;
  }
  float occ(vec2 c) {
    if (c.x < 0.0 || c.y < 0.0 || c.x > uDims.x - 1.0 || c.y > uDims.y - 1.0) return 0.0;
    return texelFetch(uGrid, ivec2(c), 0).a > 0.5 ? 1.0 : 0.0;
  }
  `;

  const VERT_DECL = /* glsl */`
  ${GLSL_COMMON}
  uniform float uHole;
  attribute vec2 aUV;
  attribute vec2 aCell;
  varying vec2 vCell;
  varying vec2 vLocal;
  varying float vHeat;
  varying float vMelt;
  varying float vState;
  float gM, gNE, gNW, gNS, gNN;
  // 该方向上邻格的熔合程度（有邻豆且双方都在熔化 → 向邻格铺开并方化）
  float nfAt(float cs, float sn) { return cs * cs * (cs > 0.0 ? gNE : gNW) + sn * sn * (sn > 0.0 ? gNS : gNN); }
  vec3 beadPos(vec2 uv) {
    float th = uv.x * 6.28318530718;
    float cs = cos(th), sn = sin(th);
    float m = gM;
    float nf = nfAt(cs, sn);
    float f  = m * nf;                                   // 该方向的熔合度
    float h  = mix(0.92, 0.50, m);                       // 压扁
    float ri = mix(uHole, 0.0, pow(m, 0.7));             // 孔收缩直至完全闭合
    float bi = mix(0.045, 0.0, m);
    float Rr = mix(0.40, 0.445, m);                      // 无邻豆一侧：保持圆，轻微外扩
    float Rs = 0.505 / max(abs(cs), abs(sn));            // 熔合一侧：铺满到格边的正方形（略微重叠，消除缝）
    float Ro = mix(Rr, Rs, f);
    float bo = mix(0.11, mix(0.12, 0.001, nf), m);       // 熔合侧外沿倒角收没
    float v = uv.y, rho, y;
    if (v < 0.2)       { rho = ri; y = mix(mix(0.0, h, m), h - bi, v / 0.2); }
    else if (v < 0.35) { float p = (v - 0.2) / 0.15 * 1.5707963; rho = ri + bi - bi * cos(p); y = h - bi + bi * sin(p); }
    else if (v < 0.6)  { rho = mix(ri + bi, Ro - bo, (v - 0.35) / 0.25); y = h; }
    else if (v < 0.8)  { float p = (v - 0.6) / 0.2 * 1.5707963; rho = Ro - bo + bo * sin(p); y = h - bo + bo * cos(p); }
    else               { rho = Ro; y = mix(h - bo, 0.0, (v - 0.8) / 0.2); }
    return vec3(cs * rho, y, sn * rho);
  }
  `;

  const VERT_BODY = /* glsl */`
  vec2 cell = floor(aCell + 0.5);
  // 每个格位都有实例，空格（A = 0）收成板下的退化点，编辑增删豆不用重建几何
  vec3 bpPos = vec3(0.0, -60.0, 0.0);
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  gM = 0.0;
  if (occ(cell) > 0.5) {
    gM = cellMelt(cell);
    gNE = occ(cell + vec2( 1.0, 0.0)) * min(gM, cellMelt(cell + vec2( 1.0, 0.0)));
    gNW = occ(cell + vec2(-1.0, 0.0)) * min(gM, cellMelt(cell + vec2(-1.0, 0.0)));
    gNS = occ(cell + vec2( 0.0, 1.0)) * min(gM, cellMelt(cell + vec2( 0.0, 1.0)));
    gNN = occ(cell + vec2( 0.0,-1.0)) * min(gM, cellMelt(cell + vec2( 0.0,-1.0)));
    bpPos = beadPos(aUV);
    vec3 dpu = beadPos(aUV + vec2(0.002, 0.0)) - beadPos(aUV - vec2(0.002, 0.0));
    vec3 dpv = beadPos(vec2(aUV.x, min(aUV.y + 0.003, 1.0))) - beadPos(vec2(aUV.x, max(aUV.y - 0.003, 0.0)));
    vec3 nrm = cross(dpu, dpv);
    // 孔闭合时孔心几何退化（叉积为 0）；烫透后顶面（含原孔口）法线收拢为竖直
    objectNormal = dot(nrm, nrm) > 1e-12 ? normalize(nrm) : vec3(0.0, 1.0, 0.0);
    objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), step(aUV.y, 0.6) * smoothstep(0.8, 1.0, gM)));
    // 熔合一侧的外沿倒角与邻豆顶面相接：烫透后法线同样收拢为竖直，否则倾斜的倒角在格缝上打出一道细暗线，看起来没熔成一片
    float thN = aUV.x * 6.28318530718;
    objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), step(aUV.y, 0.8) * smoothstep(0.6, 1.0, gM * nfAt(cos(thN), sin(thN)))));
    // 刚被编辑的豆：从上方落进钉位
    float e = cellStamp(cell);
    if (e > 0.0) bpPos.y += 1.1 * (1.0 - smoothstep(0.0, 0.14, uTime - e));
    // [3D-PROGRESS] 进度态：还没拼的压成贴着钉子的矮环（钉子从中间露出来，像空钉位上的铅笔稿）；正在拼的轻轻上下浮动
    float st = cellState(cell);
    if (st > 3.5) bpPos.y += st > 4.5 ? 0.30 : 0.18;   // [3D-HOVER] 编辑态悬停色块 / 工具落点：豆抬起（橡皮目标抬得更高）
    else if (st > 2.5) { bpPos.xz *= 0.72; bpPos.y *= 0.40; }
    else if (st > 1.5) bpPos.y += 0.45 + 0.12 * sin(uTime * 3.0 + (cell.x + cell.y) * 0.35);
  }
  vState = cellState(cell);
  vCell = cell; vLocal = bpPos.xz; vMelt = gM; vHeat = sin(3.14159 * gM);
  `;

  const FRAG_DECL = /* glsl */`
  ${GLSL_COMMON}
  varying vec2 vCell;
  varying vec2 vLocal;
  varying float vHeat;
  varying float vMelt;
  varying float vState;
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }
  vec3 cellRGB(vec2 c) { return texelFetch(uGrid, ivec2(c), 0).rgb; }
  float vn3(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }
  float fbm3(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vn3(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
  vec2 h22(vec2 p) { float n = hash12(p * 12.9898); return vec2(n, hash12(p * 12.9898 + n + 17.1)); }
  float fiber3(vec2 p) { // 毛巾：三组方向的拉长脊状噪声叠成毛圈（与平面 iron-gl.js 的 fiber 同式）
    float dens = mix(5.0, 14.0, uIronP.z), len = mix(1.4, 5.0, uIronP.x), s = 0.0;
    for (int k = 0; k < 3; k++) {
      float a = float(k) * 2.094 + 0.4; mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
      vec2 q = R * p * dens; q.x /= len;
      s += pow(1.0 - abs(vn3(q + float(k) * 13.0) * 2.0 - 1.0), 3.0);
    }
    return s / 3.0;
  }
  float towelBlob3(vec2 p) { // 毛巾：毛圈压进豆面留下的一团团圆鼓凸起（每格约 3 团，大小不一，与平面 towelBlob 同式）
    float b = 0.62 * vn3(p * 3.4 + 5.1) + 0.38 * vn3(p * 7.1 + 1.3);
    return smoothstep(0.30, 0.80, b);
  }
  float ironTexAll(vec2 g); // 定义在 ironTexH 之后
  float ironTexH(vec2 g) { // 澡巾 / 毛巾的表面高度纹理（格坐标，与平面 texH 同式），细闪与粗闪不需要高度
    vec2 p = g / uIron.z;
    if (uIron.x < 1.5) return (0.5 + 2.5 * uIronP.x) * (0.016 * vn3(p * 16.0) + 0.007 * vn3(p * 37.0)); // 澡巾：细密均匀小颗粒，无纹路
    return 0.11 * towelBlob3(p) + 0.04 * fiber3(p) - 0.05 * uIronP.y * fbm3(p * 0.8); // 毛巾：毛圈压出的一团团凸起 + 表面绒毛
  }
  float ironTexAll(vec2 g) { return (uIron.x > 0.5 && uIron.x < 2.5) ? ironTexH(g) : 0.008 * fbm3(g / uIron.z * 5.0); } // 与平面 texH 同式
  `;

  // 颜色揉合：靠近格边时与邻豆颜色混合，混合带宽随双方熔化度变宽，边界用噪声扰动成不规则的"揉"痕
  const FRAG_COLOR = /* glsl */`
  vec2 cell = floor(vCell + 0.5);
  vec3 own = cellRGB(cell);
  vec2 wp = cell + vLocal;
  float wob = (vnoise(wp * 4.5) - 0.5) * 0.22 + (vnoise(wp * 11.0) - 0.5) * 0.08;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 d = k == 0 ? vec2(1, 0) : k == 1 ? vec2(-1, 0) : k == 2 ? vec2(0, 1) : vec2(0, -1);
    vec2 nc = cell + d;
    if (occ(nc) < 0.5) continue;
    float mn = min(vMelt, cellMelt(nc));
    float w = 0.2 * mn + 1e-4;
    float dist = 0.5 - dot(vLocal, d) + wob * mn;
    float wt = 0.5 * (1.0 - smoothstep(0.0, w, dist)) * step(1e-3, mn);
    acc += wt * cellRGB(nc); wsum += wt;
  }
  if (wsum > 0.75) { acc *= 0.75 / wsum; wsum = 0.75; }
  diffuseColor.rgb *= own * (1.0 - wsum) + acc;
  float ironH0 = (uIron.x > 0.5 && uIron.x < 2.5) ? ironTexH(vCell + vLocal) : 0.0; // [IRON] 取色、粗糙度、法线共用，每片元只算一次
  if (uIron.x > 1.5 && uIron.x < 2.5) { // [IRON] 毛巾：凹缝压暗、凸起顶上的绒毛泛白，读得出一团团鼓起来的毛绒
    float tb = towelBlob3((vCell + vLocal) / uIron.z), Mt = smoothstep(0.0, 0.5, vMelt) * min(uIron.y, 1.2);
    // 明暗围绕 1 起伏（团块噪声均值约 0.40），整面不变暗；浅色豆压暗幅度收小（与平面同式）
    float tk = mix(0.14, 0.34, smoothstep(0.95, 0.55, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b))));
    diffuseColor.rgb *= mix(1.0, 1.0 + tk * (tb - 0.4), Mt);
    diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * 1.6 + 0.06, vec3(1.0)), (0.10 + 0.35 * fiber3((vCell + vLocal) / uIron.z) * tb) * Mt); // 绒毛尖提亮本色，深色豆不发灰
  }
  // [3D-PROGRESS] 还没拼：褪成低饱和的暗色，只留个位置感
  if (vState > 2.5 && vState < 3.5) { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.35) * (uHasCur > 0.5 ? 0.28 : 0.42); }
  // [3D-PROGRESS] 有在拼色时已拼轻退一点（保留大部分颜色），仍和压扁变灰的未拼暗环拉得开
  if (vState > 0.5 && vState < 1.5 && uHasCur > 0.5) { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.75) * 0.8; }
  vec3 ironAlb = diffuseColor.rgb; // [IRON] 烫后豆面底色（含邻豆揉色、毛巾明暗与进度退色），平面同式打光用
  `;

  /* [IRON] 烫后豆面以平面为准：朝上的面不走场景灯光与色调映射，按 iron-gl.js main() 同一套公式出色
   * （同一移动光源 uL、同一材质 uMat、同一高度纹理求法线、同一闪粒），侧面仍走 3D 打光，保留立体感 */
  const IRON_FLAT_MATCH = /* glsl */`
  if (uIronOn > 0.5) {
    float wI = ironTop * smoothstep(0.0, 0.5, vMelt);
    if (wI > 0.001) {
      vec2 g = vCell + vLocal;
      float Mc = smoothstep(0.0, 0.5, vMelt);
      vec3 alb = sRGBTransferOETF(vec4(ironAlb, 1.0)).rgb;
      vec3 col = alb; // 无孔：平面是平涂色块
      if (uIron.x > 0.5) {
        if (uIron.x < 1.5) alb *= mix(1.0, 0.97 + 0.05 * vn3(g / uIron.z * 16.0), Mc);
        float e = 0.02;
        float h0 = uIron.y * Mc * ironTexAll(g), hx = uIron.y * Mc * ironTexAll(g + vec2(e, 0.0)), hy = uIron.y * Mc * ironTexAll(g + vec2(0.0, e));
        vec3 n = normalize(vec3(-(hx - h0) / e, (hy - h0) / e, 1.0));
        vec3 L = normalize(vec3(-0.45 + 0.28 * sin(uTime * 0.6), 0.6 + 0.22 * sin(uTime * 0.43), 0.75)), Hh = normalize(L + vec3(0.0, 0.0, 1.0));
        float ndl = max(dot(n, L), 0.0);
        col = alb * (uIronMat.x + uIronMat.y * ndl) / (uIronMat.x + uIronMat.y * L.z) + uIronMat.z * pow(max(dot(n, Hh), 0.0), uIronMat.w);
        if (uIron.x > 2.5) {
          vec2 q = mat2(0.89, -0.45, 0.45, 0.89) * g / uGlit.x, i = floor(q), f = fract(q) - 0.5 - (h22(i + 2.0) - 0.5) * 0.5;
          if (h22(i + 3.1).x < uGlit.y) {
            vec2 rn = h22(i + 11.7); float a = rn.x * 6.283, t = sqrt(rn.y) * 0.9;
            vec3 fn = vec3(sin(t) * cos(a), sin(t) * sin(a), cos(t));
            vec3 fc = mix(vec3(1.0, 0.98, 0.94), 0.6 + 0.4 * cos(6.283 * (h22(i + 5.0).x + vec3(0.0, 0.33, 0.67))), uIronP.x);
            float sp = pow(max(dot(fn, Hh), 0.0), uGlit.w), d0 = 1.0 - smoothstep(0.12, 0.3, length(f));
            col = mix(col, mix(col, fc, 0.35), uGlit.z * d0 * uIron.y * Mc) + fc * sp * 2.4 * d0 * uIron.y * Mc;
          }
        }
      }
      gl_FragColor.rgb = mix(gl_FragColor.rgb, min(col, vec3(1.0)), wI);
    }
  }
  `;
  const beadMat = new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0.0 });
  beadMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <beginnormal_vertex>', VERT_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = bpPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n' +
        'float ironTop = smoothstep(0.75, 0.95, dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))); // [IRON] 朝上的豆面\n' +
        'if (uIron.x > 0.5 && uIron.x < 2.5 && vHeat < 0.98) { // [IRON] 澡巾/毛巾：正面罩烫布纹理，扰动法线\n' +
        '  vec2 g2 = vCell + vLocal; float e2 = 0.03 * uIron.z;\n' +
        '  float h0 = ironH0; float hx2 = ironTexH(g2 + vec2(e2, 0.0)), hy2 = ironTexH(g2 + vec2(0.0, e2));\n' +
        '  vec3 tN = normalize(vec3(-(hx2 - h0) / e2, (hy2 - h0) / e2, 1.0 / (0.6 * uIron.y)));\n' +
        '  float upW = smoothstep(0.55, 0.9, dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))); // 纹理只压在朝上的豆面，侧壁不起皱\n' +
        '  float kN = uIron.x > 1.5 ? 0.75 : 0.45; // 毛巾凸起更鼓\n' +
        '  normal = normalize(mix(normal, normalize((viewMatrix * vec4(tN, 0.0)).xyz), min(uIron.y, 1.5) * kN * upW));\n' +
        '}')
      .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n' + IRON_FLAT_MATCH)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n' +
        'if (uIron.x > 0.5 && uIron.x < 1.5) roughnessFactor = clamp(roughnessFactor + (ironH0 * 2.0 + 0.15) * uIron.y, 0.05, 1.0);\n' +
        'if (uIron.x > 1.5 && uIron.x < 2.5) roughnessFactor = mix(roughnessFactor, 0.92, smoothstep(0.0, 0.5, vMelt)); // 毛巾：绒面全哑光，不出塑料高光\n' +
        'if (uIron.x > 2.5) roughnessFactor = max(0.05, roughnessFactor * (1.0 - 0.75 * uIron.y));')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        // [IRON] 细闪 / 粗闪：闪片朝向在豆面「上方」（世界 +y）附近随机倾斜，按主光与视线的半程向量算镜面闪光；
        // 主光随时间缓慢摆动（与平面同节奏），不转镜头也能看到闪片明灭。只画朝上的顶面、随熔化度出现
        'if (uIron.x > 2.5) {\n' +
        '  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\n' +
        '  float topM = smoothstep(0.75, 0.95, dot(normal, upV)) * smoothstep(0.0, 0.5, vMelt);\n' +
        '  vec2 g3 = vCell + vLocal;\n' +
        '  vec2 q = mat2(0.89, -0.45, 0.45, 0.89) * g3 / uGlit.x, i = floor(q), f = fract(q) - 0.5 - (h22(i + 2.0) - 0.5) * 0.5;\n' +
        '  if (topM > 0.01 && h22(i + 3.1).x < uGlit.y) { float dot0 = 1.0 - smoothstep(0.12, 0.3, length(f));\n' +
        '    if (dot0 > 0.0) { vec2 rn = h22(i + 11.7); float a = rn.x * 6.283, t = sqrt(rn.y) * 0.9;\n' +
        '      vec3 fnW = vec3(sin(t) * cos(a), cos(t), sin(t) * sin(a));\n' +
        '      vec3 fc = mix(vec3(1.0, 0.98, 0.94), 0.6 + 0.4 * cos(6.283 * (h22(i + 5.0).x + vec3(0.0, 0.33, 0.67))), uIronP.x);\n' +
        '      vec3 Lw = normalize(vec3(1.2 + 0.9 * sin(uTime * 0.6), 2.0, 0.9 + 0.9 * sin(uTime * 0.43)));\n' +
        '      vec3 Hv = normalize(normalize((viewMatrix * vec4(Lw, 0.0)).xyz) + normalize(vViewPosition));\n' +
        '      float sp = pow(max(dot(normalize((viewMatrix * vec4(fnW, 0.0)).xyz), Hv), 0.0), uGlit.w * 0.79);\n' +
        '      totalEmissiveRadiance += (own * 0.25 * uGlit.z + fc * 2.6 * sp) * dot0 * uIron.y * topM;\n' +
        '    } } }\nif (uIron.x > 1.5 && uIron.x < 2.5) { float nv = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0); totalEmissiveRadiance += (diffuseColor.rgb * 0.9 + 0.04) * pow(nv, 2.5) * 0.4 * smoothstep(0.0, 0.5, vMelt) * min(uIron.y, 1.2); } // [IRON] 毛巾绒面掠射泛白\ntotalEmissiveRadiance += vHeat * vec3(1.0, 0.32, 0.06) * 0.22;' +
'\nif (vState > 3.5 && vState < 4.5) totalEmissiveRadiance += mix(own, vec3(1.0), 0.5) * 0.5;' +
'\nif (vState > 4.5 && vState < 5.5) totalEmissiveRadiance += vec3(1.0, 0.18, 0.25) * (0.55 + 0.25 * sin(uTime * 8.0));' +
'\nif (vState > 1.5 && vState < 2.5) { vec3 hue = own / max(max(own.r, own.g), max(own.b, 0.05)); totalEmissiveRadiance += hue * (0.75 + 0.3 * sin(uTime * 3.0)); }');
        // 4 = 工具落点提亮；5 = 橡皮目标红闪（豆还在，告诉你点下去这颗会没）；2 正在拼 / 6 选色反馈不改豆面，荧光只在豆底四周的光环上
  };
  beadMat.customProgramCacheKey = () => 'bead-melt-v5-towel-blob';

  // [3D-PROGRESS / 3D-HOVER] 高亮颜色的荧光环：平铺在豆底四周的底板上，光从豆的外沿向外散开、往外渐隐。
  // 豆身照常渲染并遮住环的内圈，所以豆面颜色不变；同色相邻的豆之间环被豆身挡住，只在这片区域的外轮廓与格缝露光。
  // 与平面同一口径：光色是本色的提亮版（深色豆也发亮光），instanceColor 里已乘好强度
  const glowGeo = new THREE.RingGeometry(0.42, 1.1, 40, 1);
  glowGeo.rotateX(-Math.PI / 2); glowGeo.translate(0, 0.03, 0);
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vCol; varying float vR;
      void main() {
        vCol = instanceColor; vR = length(position.xz);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec3 vCol; varying float vR;
      void main() {
        float a = pow(1.0 - smoothstep(0.42, 1.1, vR), 1.3) * (0.85 + 0.15 * sin(uTime * 3.0));
        gl_FragColor = vec4(vCol * a, a);
        #include <colorspace_fragment>
      }`,
  });
  let glowMesh = null;


  const pegGeo = new THREE.CylinderGeometry(0.095, 0.11, 0.42, 8);
  const pegMat = new THREE.MeshStandardMaterial({ color: 0x3d4f63, roughness: 0.75 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x1f2a37, roughness: 0.9 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xff4655, roughness: 0.5, emissive: 0x40010a });

  function init() {
    if (renderer || S.failed) return !!renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: QS3.has('shot') }); }
    catch (e) { S.failed = true; return false; }
    if (!renderer.capabilities.isWebGL2) { renderer.dispose(); renderer = null; S.failed = true; return false; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    wrap.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1118);
    scene.fog = new THREE.Fog(0x0b1118, 180, 420); // 起止距离在 frame() 里按板子尺寸重设
    camera = new THREE.PerspectiveCamera(42, 1, 0.3, 1000);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxDistance = 400; // frame() 里按板子尺寸重设
    controls.minDistance = 3;
    controls.maxPolarAngle = Math.PI * 0.47; // 豆子底面不建模，不允许钻到板子下面
    controls.zoomToCursor = true; // 滚轮朝指针所指处推进：鼠标也能像双指那样切到局部
    controls.screenSpacePanning = true;
    // 操作提示：一句话；浏览 / 编辑各说一次，在 3D 画面里一按下或滚轮就收起，同一情境本次打开页面内不再出现
    const hintDone = () => { S.hintSeen[S.hintCtx] = true; document.body.classList.add('v3-moved'); };
    wrap.addEventListener('pointerdown', hintDone, true);
    wrap.addEventListener('wheel', hintDone, { capture: true, passive: true });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x16202c, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.2, 2.0, 0.9); scene.add(key);
    const rim = new THREE.DirectionalLight(0xff4655, 0.8); rim.position.set(-1.6, 0.7, -1.2); scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35); fill.position.set(-0.5, 1.5, 1.8); scene.add(fill);
    ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ color: 0x0d151e, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    gridHelp = new THREE.GridHelper(900, 90, 0x1c2836, 0x141d29); scene.add(gridHelp);
    peeled(false);
    boardGroup = new THREE.Group(); scene.add(boardGroup);
    bindPointer();
    return true;
  }

  // 板子：底板 + 红边 + 柱钉 + 每个格位常驻一颗豆（空格在着色器里收成板下退化点，增删豆只改纹理）
  function build(w, h) {
    while (boardGroup.children.length) {
      const m = boardGroup.children.pop();
      if (m.geometry && m.geometry !== pegGeo && m.geometry !== glowGeo) m.geometry.dispose();
    }
    if (gridTex) gridTex.dispose();
    if (stampTex) stampTex.dispose();
    if (stateTex) stateTex.dispose();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.5, h + 1.2), plateMat);
    plate.position.y = -0.25; boardGroup.add(plate);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(w + 1.45, 0.14, h + 1.45), edgeMat);
    edge.position.y = -0.49; boardGroup.add(edge);
    const pegs = new THREE.InstancedMesh(pegGeo, pegMat, w * h);
    let pi = 0;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { tmpMat4.makeTranslation(c - (w - 1) / 2, 0.21, r - (h - 1) / 2); pegs.setMatrixAt(pi++, tmpMat4); }
    boardGroup.add(pegs);
    boardParts = [plate, edge, pegs]; peeled(state.meltOn);
    gridData = new Uint8Array(w * h * 4);
    gridTex = new THREE.DataTexture(gridData, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    gridTex.colorSpace = THREE.SRGBColorSpace;
    gridTex.magFilter = gridTex.minFilter = THREE.NearestFilter;
    U.uGrid.value = gridTex; U.uDims.value.set(w, h);
    stampData = new Float32Array(w * h);
    stampTex = new THREE.DataTexture(stampData, w, h, THREE.RedFormat, THREE.FloatType);
    stampTex.magFilter = stampTex.minFilter = THREE.NearestFilter;
    stampTex.needsUpdate = true;
    U.uStamp.value = stampTex;
    stateData = new Uint8Array(w * h);
    stateTex = new THREE.DataTexture(stateData, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    stateTex.magFilter = stateTex.minFilter = THREE.NearestFilter;
    stateTex.needsUpdate = true;
    U.uState.value = stateTex;
    const cells = [];
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells.push(c, r);
    const geo = makeBeadGeo(Math.max(w, h) > 100 ? 16 : 24); // 角向分段须为 8 的倍数，让 45° 方角恰好落在顶点上；大板降分段控制顶点量
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
    beadMesh = new THREE.InstancedMesh(geo, beadMat, w * h);
    for (let i = 0; i < w * h; i++) { tmpMat4.makeTranslation(cells[i * 2] - (w - 1) / 2, 0, cells[i * 2 + 1] - (h - 1) / 2); beadMesh.setMatrixAt(i, tmpMat4); }
    beadMesh.instanceMatrix.needsUpdate = true;
    beadMesh.frustumCulled = false;
    boardGroup.add(beadMesh);
    glowMesh = new THREE.InstancedMesh(glowGeo, glowMat, w * h);
    glowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(w * h * 3), 3);
    glowMesh.count = 0; glowMesh.frustumCulled = false; glowMesh.renderOrder = 2;
    boardGroup.add(glowMesh);
    S.n = Math.max(w, h); S.w = w; S.h = h; S.shown = null;
  }

  function fitDist(half) {
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    return half / Math.tan(Math.min(vHalf, hHalf));
  }
  // 远景雾：起止距离按默认展示视角的镜头距离换算，开场薄雾（板心约 20%），放大靠近后逐渐清晰
  const FOG_NEAR = 0.6, FOG_FAR = 2.6;
  // 拖动后阻尼惯性还在时点「俯视 / 展示视角」，残余转动会接着把相机带偏：先关阻尼走一帧把惯性清零
  function stopCoast() { controls.enableDamping = false; controls.update(); controls.enableDamping = true; }
  function frame(n, top) {
    stopCoast();
    S.top = top;
    const dShow = fitDist(n * 0.72 + 3) * 1.1;
    S.dShow = dShow; controls.maxDistance = dShow * 3; // 与平面同口径：最远拉到默认展示距离的 3 倍
    scene.fog.near = dShow * FOG_NEAR; scene.fog.far = dShow * FOG_FAR;
    controls.target.set(0, 0.4, 0);
    if (top) camera.position.set(0, fitDist(n * 0.5 + 3) * 1.05, 0.001);
    else camera.position.copy(new THREE.Vector3(0.55, 0.63, 0.55).normalize().multiplyScalar(dShow));
    camera.updateProjectionMatrix();
    controls.update();
  }
  function resize() {
    if (!renderer) return;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }

  // 矩阵 → 豆板纹理（RGB = 豆色，A = 有无豆）；编辑中新落的豆记下时刻，着色器据此落豆 + 局部重烫
  function hint() {
    const ctx = ed.on ? 'edit' : 'browse';
    if (ctx === S.hintCtx) return;
    S.hintCtx = ctx;
    const zoom = isCoarse() ? '双指缩放' : (ed.on ? '滚轮缩放' : '滚轮对准想看的地方缩放 · 右键拖动平移');
    document.getElementById('v3Hint').textContent = (ed.on ? '按住豆板外拖动旋转 · ' : '拖动旋转 · ') + zoom;
    document.body.classList.toggle('v3-moved', !!S.hintSeen[ctx]);
  }
  function sync() {
    if (!renderer) return;
    const w = GW, h = GH;
    if (S.w !== w || S.h !== h) { build(w, h); frame(S.n, S.top); }
    hint();
    const pv = ed.on ? ed.preview : null, hl = ed.on ? null : state.highlight;
    // [3D-PROGRESS] 进度 = 手里那块半成品：已拼的实打实、正在拼的发光、还没拼的退成空钉位上的暗环。
    // 不在编辑、并且已经开始拼（选了在拼色或打过卡）时自动生效，烫前烫后都一样；否则就是成品原样（不再整板压暗）
    const prog = progOn();
    boardGroup.scale.x = state.mirror ? -1 : 1; // [MIRROR] 镜像 = 豆板左右翻转（拾格在 castCell 里同步翻回）
    document.body.classList.toggle('v3-prog-live', prog);
    // [3D-HOVER] 编辑态悬停 / 刚选中色块：同色豆发光抬起，其余豆保持原样（与平面同一个 edColorFeedback）
    const fb = ed.on ? edColorFeedback() : trackHover !== null && PAL[trackHover] ? { code: trackHover, strength: 1, glow: 1 } : null, // [TRACK-HOVER hook] 进度表悬停：与编辑选色同一反馈
      fbGlow = fb && fb.strength > 0.05 ? Math.max(1, fb.glow || 1) : 0;
    if (fb && ed.on && !ed.stroke) edRequestDraw();
    const fresh = !S.shown;
    if (fresh) S.shown = new Array(w * h);
    const now = performance.now() / 1000, dropped = [];
    for (let k = 0; k < w * h; k++) {
      const code = grid[(k / w) | 0][k % w];
      if (!fresh && ed.on && code && S.shown[k] !== code) dropped.push(k);
      S.shown[k] = code;
      // [3D-TOOL] 工具落点（画笔 / 橡皮 / 填充 / 取色的悬停预览格）：抬起发光；橡皮预览不再让豆消失，保留原豆并标红
      const inPv = !!(pv && pv.has(k)), eraseT = inPv && ed.tool === 'eraser' && !ed.stroke;
      const show = inPv ? (eraseT ? code : pv.get(k)) : code, o = k * 4;
      if (!show) { gridData[o] = gridData[o + 1] = gridData[o + 2] = gridData[o + 3] = 0; stateData[k] = 0; continue; }
      const rgb = (PAL[show] || { rgb: [255, 0, 255] }).rgb;
      gridData[o] = rgb[0]; gridData[o + 1] = rgb[1]; gridData[o + 2] = rgb[2]; gridData[o + 3] = 255;
      stateData[k] = inPv ? (eraseT || (ed.stroke && ed.stroke.erase) ? 5 : 4) : fbGlow && (fb.codes ? fb.codes.has(show) : show === fb.code) ? 6 : !prog ? 0 : show === hl ? 2 : state.done.has(show) ? 1 : 3;
    }
    gridTex.needsUpdate = true;
    stateTex.needsUpdate = true;
    // 荧光环：进度态套在在拼格位上，编辑态套在被指颜色的格位上（与平面荧光边同一口径）
    const hov = !!(fbGlow && PAL[fb.code]); // [TRACK-HOVER] 悬停色（编辑选色 / 进度表）优先于在拼色
    const glowCode = hov ? fb.code : prog && hl ? hl : null;
    U.uHasCur.value = prog && hl ? 1 : 0;
    let gn = 0;
    if (glowCode) {
      const k = !hov ? 1 : Math.min(fbGlow, 2.2), gc = glowEdgeColor(PAL[glowCode].rgb).map(v => v / 255 * Math.min(2.4, 1.4 * k));
      const col = new THREE.Color().setRGB(gc[0], gc[1], gc[2], THREE.SRGBColorSpace), want = hov ? 6 : 2;
      const multi = hov && fb.codes && fb.codes.size > 1, cols = new Map(); // 按色圈选多色：光环各取各的色
      const colOf = code => { if (!cols.has(code)) { const g = glowEdgeColor(PAL[code].rgb).map(v => v / 255 * Math.min(2.4, 1.4 * k)); cols.set(code, new THREE.Color().setRGB(g[0], g[1], g[2], THREE.SRGBColorSpace)); } return cols.get(code); };
      for (let q = 0; q < w * h; q++) if (stateData[q] === want) {
        tmpMat4.makeScale(1 + .12 * (k - 1), 1, 1 + .12 * (k - 1));     // 点选那一下光环略外扩
        tmpMat4.setPosition(q % w - (w - 1) / 2, 0, ((q / w) | 0) - (h - 1) / 2);
        glowMesh.setMatrixAt(gn, tmpMat4); glowMesh.setColorAt(gn, multi ? colOf(S.shown[q]) : col); gn++;
      }
    }
    glowMesh.count = gn; glowMesh.instanceMatrix.needsUpdate = true; glowMesh.instanceColor.needsUpdate = true;
    if (dropped.length) {
      const o = ed.hoverCell != null && ed.hoverCell >= 0 ? ed.hoverCell : dropped[0], or = (o / w) | 0, oc = o % w;
      for (const k of dropped) stampData[k] = now + (dropped.length > 8 ? Math.min(Math.hypot(((k / w) | 0) - or, k % w - oc) * 0.012, 0.5) : 0);
      stampTex.needsUpdate = true;
    }
  }

  // 与着色器 cellMelt 同式的 CPU 熔化度；global = 只算熨斗进度，不计编辑后的落豆重烫
  function meltAt(r, c, global) {
    const fr = x => x - Math.floor(x), w = S.w, hh = S.h;
    let p3 = [fr(c * .1031), fr(r * .1031), fr(c * .1031)];
    const d = p3[0] * (p3[1] + 33.33) + p3[1] * (p3[2] + 33.33) + p3[2] * (p3[0] + 33.33);
    p3 = p3.map(v => v + d);
    const h = fr((p3[0] + p3[1]) * p3[2]);
    const st = (c + r) / Math.max(w + hh - 2, 1) * 0.55 + h * 0.08;
    let m = Math.min(Math.max((U.uProgress.value - st) / 0.35, 0), 1); m = m * m * (3 - 2 * m);
    const e = stampData[r * w + c];
    if (!global && e > 0) { const a = Math.min(Math.max((performance.now() / 1000 - e - 0.14) / 0.55, 0), 1); m = Math.min(m, a * a * (3 - 2 * a)); }
    return m;
  }
  // 每个格位柱体的顶面高度：有豆 = 该格豆顶（随该格熔化度压扁），空格 = 柱钉顶
  const PEG_TOP = 0.42, BEAD_TOP = 0.92;
  const topY = (r, c) => grid[r][c] ? BEAD_TOP - 0.42 * meltAt(r, c, true) : PEG_TOP;
  // 拾格：射线在豆板上逐格前进（格子遍历），返回第一个被射线碰到的格位柱体 [列, 行]，与 cellAt 同约定。
  // 不能只和一张水平面求交：斜看时空格（柱钉）比豆顶低，落点会被算到光标前方的格子上。每次最多走 2N 格，16k 豆也无压力。
  const ray = new THREE.Raycaster(), mv = new THREE.Vector2();
  function cell(e) {
    if (!renderer || !S.n) return null;
    const b = renderer.domElement.getBoundingClientRect();
    mv.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(mv, camera);
    return castCell(ray.ray.origin, ray.ray.direction);
  }
  function castCell(o, d) {
    if (state.mirror) { o = { x: -o.x, y: o.y, z: o.z }; d = { x: -d.x, y: d.y, z: d.z }; } // [MIRROR] 射线换到翻转前的豆板坐标
    const w = S.w, h = S.h, halfX = w / 2, halfZ = h / 2;
    if (d.y >= 0) return null;
    // 板面坐标 u = x + W/2、w = z + H/2，格 (r,c) 占 [c,c+1)×[r,r+1)；只看 y ∈ [0, 豆顶] 这一层
    let t0 = o.y > BEAD_TOP ? (BEAD_TOP - o.y) / d.y : 0, t1 = -o.y / d.y;
    for (const [oa, da, dn] of [[o.x + halfX, d.x, w], [o.z + halfZ, d.z, h]]) {
      if (Math.abs(da) < 1e-9) { if (oa < 0 || oa >= dn) return null; continue; }
      let ta = (0 - oa) / da, tb = (dn - oa) / da;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 >= t1) return null;
    const eps = 1e-6;
    let c = Math.min(w - 1, Math.max(0, Math.floor(o.x + halfX + d.x * (t0 + eps))));
    let r = Math.min(h - 1, Math.max(0, Math.floor(o.z + halfZ + d.z * (t0 + eps))));
    const sx = d.x > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const nextX = cc => Math.abs(d.x) < 1e-9 ? Infinity : ((sx > 0 ? cc + 1 : cc) - (o.x + halfX)) / d.x;
    const nextZ = rr => Math.abs(d.z) < 1e-9 ? Infinity : ((sz > 0 ? rr + 1 : rr) - (o.z + halfZ)) / d.z;
    let t = t0;
    for (let k = 0; k < 4 * (w + h) + 4; k++) {
      const tx = nextX(c), tz = nextZ(r), tOut = Math.min(tx, tz, t1);
      if (o.y + d.y * tOut <= topY(r, c)) return [c, r];  // 射线在这一格里降到了柱体顶面以下
      if (tOut >= t1) return null;
      t = tOut;
      if (tx <= tz) { c += sx; if (c < 0 || c >= w) return null; }
      else { r += sz; if (r < 0 || r >= h) return null; }
    }
    return null;
  }

  /* 触屏编辑（与平面 touch.js 同一套手势口径）：
   *   手指落在豆板上 + 画笔 / 橡皮 = 一笔滑豆；填充 / 吸管 = 抬指生效；落在豆板外、手掌工具或双指 = 交给 OrbitControls 旋转 / 缩放。
   *   落指先等 TOUCH_WAIT 毫秒：期间第二根手指落下就当双指手势（把两根手指补发给 OrbitControls），不会先画上一颗豆。
   *   一笔进行中第二根手指落下：撤回这一笔、本次手势不再画。 */
  function bindTouchEdit() {
    const dom = renderer.domElement, TOUCH_WAIT = 90, MOVE_TOL = 8;
    let T = null; // { mode: wait|stroke|tap|orbit|dead, id, x, y, down: PointerEvent, timer }
    const fwd = ev => dom.dispatchEvent(new PointerEvent('pointerdown', { // 补发给 OrbitControls（isTrusted=false，本监听会放行）
      pointerId: ev.pointerId, pointerType: 'touch', clientX: ev.clientX, clientY: ev.clientY, button: 0, buttons: 1, isPrimary: true, bubbles: true }));
    const revert = () => {
      if (!ed.stroke) return;
      for (let k = ed.stroke.changes.length - 1; k >= 0; k--) edSetCell(ed.stroke.changes[k][0], ed.stroke.changes[k][1]);
      ed.stroke = null; edAfterChange();
    };
    const begin = () => {
      clearTimeout(T.timer);
      if (ed.tool === 'brush' || ed.tool === 'eraser') { edPointerDown(T.down); T.mode = ed.stroke ? 'stroke' : 'dead'; }
      else T.mode = 'tap';
    };
    wrap.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !ed.on || !e.isTrusted) return;
      if (T) {                                             // 第二根手指
        if (T.mode === 'wait') { clearTimeout(T.timer); T.mode = 'orbit'; fwd(T.down); return; } // 放行这根，补发第一根
        if (T.mode === 'stroke') { revert(); T.mode = 'dead'; }
        if (T.mode !== 'orbit') { e.stopImmediatePropagation(); e.preventDefault(); }
        return;
      }
      if (ed.tool === 'hand' || !cell(e)) return;          // 豆板外 / 手掌：交给环视
      e.stopImmediatePropagation(); e.preventDefault();
      T = { mode: 'wait', id: e.pointerId, x: e.clientX, y: e.clientY, down: e };
      T.timer = setTimeout(() => { if (T && T.mode === 'wait') begin(); }, TOUCH_WAIT);
    }, true);
    window.addEventListener('pointermove', e => {
      if (!T || e.pointerType !== 'touch' || e.pointerId !== T.id) return;
      if (T.mode === 'wait' && Math.abs(e.clientX - T.x) + Math.abs(e.clientY - T.y) > MOVE_TOL) begin();
      if (T.mode === 'stroke') edStrokeMove(e);
      else if (T.mode === 'tap' && Math.abs(e.clientX - T.x) + Math.abs(e.clientY - T.y) > MOVE_TOL) T.mode = 'dead';
    });
    const up = e => {
      if (!T || e.pointerType !== 'touch' || e.pointerId !== T.id) return;
      clearTimeout(T.timer);
      if (T.mode === 'wait' && e.type === 'pointerup') begin(); // 很快的一点：画一颗 / 填充 / 吸管
      if (T.mode === 'stroke') { if (e.type === 'pointercancel') revert(); else edStrokeEnd(); } // 系统打断（如转双指）：撤回这一笔
      else if (T.mode === 'tap' && e.type === 'pointerup') edPointerDown(T.down);
      T = null;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function bindPointer() {
    bindTouchEdit(); // 须先于下方的捕获监听注册，才能在 OrbitControls 之前截住落在豆板上的手指
    const dom = renderer.domElement;
    // 捕获阶段先于 OrbitControls：按浏览 / 编辑定按键分工；编辑中左键落在板外（或按住空格）这一次拖动交给环视
    wrap.addEventListener('pointerdown', e => {
      controls.mouseButtons = ed.on ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
                                    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      if (!ed.on || e.button !== 0) return;
      S.orbiting = ed.space || ed.tool === 'hand' || !cell(e);
      if (S.orbiting) {
        controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        ed.preview = null; ed.hoverCell = null; ed.previewInfo = ''; edRequestDraw();
        dom.style.cursor = 'grabbing';
      }
    }, true);
    window.addEventListener('pointerup', () => {
      if (!S.orbiting) return;
      S.orbiting = false;
      if (ed.on) controls.mouseButtons.LEFT = null;
      if (!ed.on) dom.style.cursor = 'grab';
    });
    dom.addEventListener('mousedown', e => { if (ed.on && e.button === 0 && !S.orbiting) edPointerDown(e); });
    dom.addEventListener('mousemove', e => {
      if (S.orbiting || (e.buttons && !ed.stroke)) { edBrowseTip(null); return; }
      if (ed.on) { if (!ed.stroke) edHover(e); else dom.style.cursor = 'crosshair'; return; }
      const c = cell(e), code = c && grid[c[1]][c[0]];
      dom.style.cursor = 'grab';
      edBrowseTip(e, code ? `<b>${code}</b> ${PAL[code].name} · (${c[0] + 1}, ${c[1] + 1}) · 双击进入编辑` : null);
    });
    dom.addEventListener('mouseleave', () => {
      edBrowseTip(null);
      if (ed.on && !ed.stroke) { ed.preview = null; ed.hoverCell = null; ed.lastMouse = null; ed.previewInfo = ''; edRequestDraw(); }
    });
    dom.addEventListener('dblclick', e => { if (ed.on || flowNoEdit()) return; const c = cell(e); if (c) edEnter(grid[c[1]][c[0]]); });
    dom.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* [IRON] 烫豆预览看的是撕下来的成品：没有底板、红边和钉子，豆片直接放在桌面上（地面抬到豆底） */
  function peeled(on) {
    U.uIronOn.value = on ? 1 : 0;
    boardParts.forEach(m => { m.visible = !on; });
    if (ground) { ground.position.y = on ? -0.02 : -0.62; gridHelp.position.y = on ? -0.01 : -0.6; }
  }
  // 烫豆进度由 iron-flat.js 统一驱动（平面与 3D视角 共用一条控制条、一个进度），这里只接收熔化度
  function melt(p) { U.uProgress.value = Math.min(Math.max(p, 0), 1); peeled(state.meltOn); }
  /* [IRON] 烫法：把平面的烫法参数（IRON_PARAMS）带进来。着色器编号取 IRON_STYLES 的 sh：0 无孔 / 1 澡巾 / 2 毛巾 / 3 细闪与粗闪 */
  function iron(styleKey) {
    const idx = (IRON_STYLES.find(s => s.key === styleKey) || IRON_STYLES[0]).sh;
    const pr = ironParamsFor(Math.max(GW, GH), styleKey);
    U.uIron.value.set(idx, pr.amp ?? 1, pr.scale ?? 1, pr.melt);
    U.uIronP.value.set(pr.p[0] ?? 0.5, pr.p[1] ?? 0.5, pr.p[2] ?? 0.5);
    U.uGlit.value.set(...ironGlitterFor(Math.max(GW, GH), styleKey));
    U.uIronMat.value.set(...(IRON_STYLES.find(s => s.key === styleKey) || IRON_STYLES[0]).mat);
  }
  document.getElementById('v3Top').onclick = () => { if (renderer) frame(S.n, true); };
  document.getElementById('v3Show').onclick = () => { if (renderer) frame(S.n, false); };

  function loop(t) {
    if (ed.on && edColorFeedback() && !ed.stroke) sync(); // 选色闪亮回落期间每帧同步光柱高度
    U.uTime.value = t / 1000;
    controls.update();
    if (S.dShow) { // 雾：拉得比默认展示更远时，起止距离跟着镜头走（远看整板不被雾吞掉）；靠近时保持默认，放大逐渐清晰
      const d = Math.max(S.dShow, camera.position.distanceTo(controls.target));
      scene.fog.near = d * FOG_NEAR; scene.fog.far = d * FOG_FAR;
    }
    renderer.render(scene, camera);
  }
  function enter() {
    if (!init()) return false;
    resize(); S.shown = null; sync();
    renderer.setAnimationLoop(loop);
    return true;
  }
  function leave() { if (renderer) renderer.setAnimationLoop(null); S.orbiting = false; }

  // 无头自测接口：格 (r,c) 豆顶中心的页面坐标、与着色器 cellMelt 同式的 CPU 熔化度（global = 不计编辑重烫）、相机与光标状态
  const test = {
    screenOf(r, c) {
      const v = new THREE.Vector3((c - (S.w - 1) / 2) * (state.mirror ? -1 : 1), topY(r, c), r - (S.h - 1) / 2).project(camera);
      const b = renderer.domElement.getBoundingClientRect();
      return [b.left + (v.x + 1) / 2 * b.width, b.top + (1 - v.y) / 2 * b.height];
    },
    meltAt,
    boardHidden: () => boardParts.length ? boardParts.every(m => !m.visible) : null,
    pickAt: (x, y) => cell({ clientX: x, clientY: y }),
    view: () => ({ cursor: renderer.domElement.style.cursor, cam: camera.position.toArray().map(v => v.toFixed(3)).join(),
                   leftNull: controls.mouseButtons.LEFT === null, orbiting: S.orbiting, n: S.n }),
    resetCam: () => frame(S.n, true),
    showCam: () => frame(S.n, false),
    lookAt: (x, y, z, tx, ty, tz) => { stopCoast(); controls.target.set(tx, ty, tz); camera.position.set(x, y, z); controls.update(); }, // 自测与截图：直接摆镜头
    orbit: (az, pol, dist) => { stopCoast(); const t = controls.target; camera.position.set(t.x + dist * Math.sin(pol) * Math.sin(az), t.y + dist * Math.cos(pol), t.z + dist * Math.sin(pol) * Math.cos(az)); controls.update(); },
    progress: p => melt(p),
    rect: () => { const b = wrap.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; },
  };
  return { enter, leave, sync, cell, resize, melt, iron, dom: () => renderer && renderer.domElement, test };
})();
window.__v3 = V3 && V3.test;

/* 平面 / 3D 切换：编辑中也能切，改动、撤销栈、未保存状态都跟着走 */
function setMode(m) {
  if (m === state.mode) return;
  state.mode = m;
  document.body.classList.toggle('mode3d', m === '3d');
  if (m === '3d' && !(V3 && V3.enter())) {
    state.mode = '2d'; document.body.classList.remove('mode3d');
    document.querySelector('#modeSeg [data-mode="3d"]').disabled = true;
    toast('当前浏览器不支持 3D 预览', 3000);
    return;
  }
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  modeKnob();
  if (m === '3d') v3Tried();
  if (m === '3d') { V3.melt(state.meltOn ? state.melt : 0); if (state.meltOn) V3.iron(ironStyle); } // [IRON hook] 烫豆预览跨视角保留：进度、播放状态、烫法都接着走
  if (ironPlaying) ironLastT = null; // [IRON hook] 切视角那一帧要初始化 3D、会卡一下：计时从下一帧重新起算，动画不跳到结尾
  ed.preview = null; ed.hoverCell = null; ed.previewInfo = ''; edBrowseTip(null);
  if (m === '2d') { if (V3) V3.leave(); resizeCanvas(); if (!state.scale) fitView(); else draw(); }
  else refreshAll();
}
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
/* 3D 入口引导：本机进过一次 3D 就不再闪 */
try { if (localStorage.getItem('perler-3d-tried')) document.body.classList.add('v3-tried'); } catch (e) {}
function v3Tried() { document.body.classList.add('v3-tried'); try { localStorage.setItem('perler-3d-tried', '1'); } catch (e) {} }
/* 平面｜3D 拨动开关：红色滑块跟着选中的按钮滑过去 */
function modeKnob() {
  const k = document.querySelector('#modeSeg .modeseg-knob'), on = document.querySelector('#modeSeg button.on');
  if (!k || !on || !on.offsetWidth) return;
  k.style.width = on.offsetWidth + 'px';
  k.style.transform = `translateX(${on.offsetLeft}px)`;
}
requestAnimationFrame(() => { modeKnob(); requestAnimationFrame(() => document.querySelector('#modeSeg .modeseg-knob').classList.remove('no-anim')); });
window.addEventListener('resize', modeKnob);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(modeKnob);
if (!V3) document.querySelector('#modeSeg [data-mode="3d"]').disabled = true;
/* [VIEW-3D] 3D 看法 END ========================================================= */

