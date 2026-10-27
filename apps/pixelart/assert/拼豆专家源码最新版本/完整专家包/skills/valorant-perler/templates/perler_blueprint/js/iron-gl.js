/* ================= [IRON] 烫法质感渲染（WebGL2） =================
 * 平面烫豆预览的熔豆与烫布纹理：一张与图纸画布等大的透明画布叠在上面，片元着色器按屏幕像素反算格坐标，
 * 逐像素算熔豆形状与高度，叠加烫法纹理（澡巾的细密小颗粒、毛巾一团团凸起的绒面、细闪与粗闪的闪粒），
 * 由高度差求法线打光。平移、缩放、镜像沿用图纸画布的 ox / oy / scale / mirror，标尺区域不画。
 * 每格熔化时刻与 3D视角 着色器 cellMelt 同式（左上→右下斜扫 + 少量随机），改一边同步另一边。
 * 平整朝上的豆面颜色等于色板颜色（打光按平面亮度归一），色号的颜色不因烫法失真。
 * 不支持 WebGL2 时 IronGL.create 返回 null，平面预览退回 iron-flat.js 的 canvas 画法。 */
const IronGL = (() => {
  const VS = `#version 300 es
in vec2 aP; void main(){ gl_Position = vec4(aP, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uGrid; uniform vec2 uDims;
uniform float uProg, uMeltT;
uniform vec4 uView;   // ox, oy, 每格 CSS px, 镜像(0/1)
uniform vec3 uCanvas; // 画布高(CSS px), dpr, 标尺宽
uniform int uStyle; uniform vec3 uP; uniform vec2 uTex; // 烫法参数；纹理强度、纹理尺度
uniform vec4 uGlit; // 细闪 / 粗闪：闪粒位边长（格）、有闪粒比例、不对光时的提亮程度、闪光锐度（见 iron-styles.js ironGlitterFor）
uniform vec4 uMat; uniform vec3 uL; uniform vec3 uPaper;
uniform float uClear; // 1 = 透明底：空格透明、豆边按覆盖度出 alpha（分享图小图用）
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p){ float n = h21(p); return vec2(n, h21(p + n + 17.1)); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float occ(vec2 c){ if (c.x < 0. || c.y < 0. || c.x > uDims.x - 1. || c.y > uDims.y - 1.) return 0.; return step(.5, texelFetch(uGrid, ivec2(c), 0).a); }
float cellMelt(vec2 c){
  float st = (c.x + c.y) / max(uDims.x + uDims.y - 2., 1.) * .55 + hash12(c) * .08;
  float m = clamp((uProg - st) / .35, 0., 1.);
  return m * m * (3. - 2. * m) * uMeltT;
}
/* 熔豆：未熔是带孔圆豆，熔化度升高时朝「有邻豆且双方都在熔」的方向铺满到格边、孔收缩闭合。返回 (覆盖度, 豆体高度, 本格熔化度) */
vec3 bead(vec2 g, float aa){
  vec2 c = floor(g), f = fract(g) - .5;
  if (occ(c) < .5) return vec3(0.);
  float M = cellMelt(c);
  vec2 nx = c + vec2(f.x > 0. ? 1. : -1., 0.), ny = c + vec2(0., f.y > 0. ? 1. : -1.);
  float fx = occ(nx) * min(M, cellMelt(nx)), fy = occ(ny) * min(M, cellMelt(ny));
  float ux = max(abs(f.x) - fx * .5, 0.), uy = max(abs(f.y) - fy * .5, 0.);
  float p = mix(2., 7., M), R = mix(.43, .5, M);
  float d = pow(pow(ux, p) + pow(uy, p), 1. / p);
  float cov = 1. - smoothstep(R - aa, R + aa * .3, d);
  float hole = .18 * pow(max(0., 1. - M / .62), .8);
  if (hole > .005) cov *= smoothstep(hole - aa, hole + aa, length(f));
  float dome = sqrt(max(0., 1. - (d / R) * (d / R)));
  float hb = .14 * smoothstep(R, R - .1, d) + .22 * (1. - .85 * M) * dome;
  return vec3(cov, hb, M);
}
float fiber(vec2 p){ // 毛巾：三组方向的拉长脊状噪声叠成毛圈
  float dens = mix(5., 14., uP.z), len = mix(1.4, 5., uP.x), s = 0.;
  for (int k = 0; k < 3; k++){
    float a = float(k) * 2.094 + .4; mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 q = R * p * dens; q.x /= len;
    s += pow(1. - abs(vn(q + float(k) * 13.) * 2. - 1.), 3.);
  }
  return s / 3.;
}
float towelBlob(vec2 p){ // 毛巾：毛圈压进豆面留下的一团团圆鼓凸起（每格约 3 团，大小不一，与 3D towelBlob3 同式）
  float b = .62 * vn(p * 3.4 + 5.1) + .38 * vn(p * 7.1 + 1.3);
  return smoothstep(.30, .80, b);
}
float texH(vec2 g){
  vec2 p = g / uTex.y;
  if (uStyle == 1) // 澡巾：没有纹路，豆面是一层细密均匀的小颗粒，整体平整工整
    return (.5 + 2.5 * uP.x) * (.016 * vn(p * 16.) + .007 * vn(p * 37.));
  if (uStyle == 2) return .11 * towelBlob(p) + .04 * fiber(p) - .05 * uP.y * fbm(p * .8); // 毛巾：一团团凸起 + 表面绒毛
  return .008 * fbm(p * 5.);
}
float H(vec2 g, float aa){ vec3 b = bead(g, aa); return b.x * b.y + uTex.x * texH(g) * b.x * smoothstep(0., .5, b.z); }
vec3 colAt(vec2 g){ ivec2 c = clamp(ivec2(floor(g)), ivec2(0), ivec2(uDims) - 1); return texelFetch(uGrid, c, 0).rgb; }
void main(){
  float dpr = uCanvas.y;
  vec2 css = vec2(gl_FragCoord.x / dpr, uCanvas.x - gl_FragCoord.y / dpr);
  if (css.x < uCanvas.z || css.y < uCanvas.z) discard; // 标尺留给图纸画布
  float s = uView.z;
  vec2 g = vec2((css.x - uView.x) / s, (css.y - uView.y) / s);
  if (uView.w > .5) g.x = uDims.x - g.x;
  if (g.x < 0. || g.y < 0. || g.x > uDims.x || g.y > uDims.y) discard;
  float aa = .9 / (s * dpr);
  vec3 b = bead(g, aa);
  if (b.x < .002){ o = uClear > .5 ? vec4(0.) : vec4(uPaper, 1.); return; }
  float e = max(aa * .6, .004);
  float h0 = H(g, aa), hx = H(g + vec2(e, 0), aa), hy = H(g + vec2(0, e), aa);
  float sx = uView.w > .5 ? -1. : 1.; // 镜像时屏幕左右与格坐标相反
  vec3 n = normalize(vec3(-sx * (hx - h0) / e, (hy - h0) / e, 1.));
  vec3 L = normalize(uL), V = vec3(0., 0., 1.), Hh = normalize(L + V);
  float Mc = smoothstep(0., .5, b.z);
  vec3 alb = colAt(g);
  if (uStyle == 2){ // 毛巾：凹缝压暗、凸起顶上绒毛泛白（与 3D 同式）
    float tb = towelBlob(g / uTex.y), Mt = Mc * min(uTex.x, 1.2);
    // 明暗围绕 1 起伏（团块噪声均值约 .40）：凹缝压暗、凸顶提亮，整面不变暗；浅色豆凸顶提亮会被截在纯白，压暗幅度随之收小
    float k = mix(.14, .34, smoothstep(.95, .55, max(alb.r, max(alb.g, alb.b))));
    alb *= mix(1., 1. + k * (tb - .4), Mt);
    alb = mix(alb, min(alb * 1.6 + .06, vec3(1.)), (.10 + .35 * fiber(g / uTex.y) * tb) * Mt); // 绒毛尖提亮本色，深色豆不发灰
  }
  if (uStyle == 1) alb = alb * mix(1., .97 + .05 * vn(g / uTex.y * 16.), Mc);
  float ndl = max(dot(n, L), 0.);
  vec3 col = alb * (uMat.x + uMat.y * ndl) / (uMat.x + uMat.y * L.z) + uMat.z * pow(max(dot(n, Hh), 0.), uMat.w);
  if (uStyle == 3 && b.x > .5){ // 细闪 / 粗闪：豆料里混的闪粒，平时几乎看不见，转到对着光的那几粒才闪
    float cs = max(uGlit.x, 1.6 / (s * dpr)); // 闪粒最小 1.6 设备像素，大板缩小时不糊成噪点
    vec2 q = mat2(.89, -.45, .45, .89) * g / cs, i = floor(q), f = fract(q) - .5 - (h22(i + 2.) - .5) * .5;
    if (h21(i + 3.1) < uGlit.y){
      vec2 rn = h22(i + 11.7); float a = rn.x * 6.283, t = sqrt(rn.y) * .9;
      vec3 fn = vec3(sin(t) * cos(a), sin(t) * sin(a), cos(t));
      vec3 fc = mix(vec3(1., .98, .94), .6 + .4 * cos(6.283 * (h21(i + 5.) + vec3(0., .33, .67))), uP.x);
      float sp = pow(max(dot(fn, Hh), 0.), uGlit.w), dot0 = 1. - smoothstep(.12, .3, length(f));
      col = mix(col, mix(col, fc, .35), uGlit.z * dot0 * uTex.x * Mc) + fc * sp * 2.4 * dot0 * uTex.x * Mc;
    }
  }
  o = uClear > .5 ? vec4(min(col, 1.), b.x) : vec4(mix(uPaper, min(col, 1.), b.x), 1.);
}`;

  function create(cv) {
    const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const sh = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    let prog;
    try {
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.warn('[IRON] 着色器不可用，退回平面画法', e); return null; }
    gl.useProgram(prog);
    const U = {}; const u = n => U[n] || (U[n] = gl.getUniformLocation(prog, n));
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aP'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    let dims = [1, 1];
    /* grid[r][c] 为色号或空；rgbOf(code) 返回 [r,g,b] */
    function setGrid(grid, rgbOf) {
      const h = grid.length, w = h ? grid[0].length : 0, d = new Uint8Array(w * h * 4);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const code = grid[r][c]; if (!code) continue;
        const rgb = rgbOf(code), k = (r * w + c) * 4;
        d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      dims = [w, h];
    }
    /* o: { w, h (CSS px), dpr, ox, oy, s, mirror, ruler, progress, style(下标), mat, melt, amp, scale, p:[..], glit:[闪片格边长, 比例, 常亮, 锐度], time(秒), clear(透明底) } */
    function render(o) {
      const W = Math.round(o.w * o.dpr), Hd = Math.round(o.h * o.dpr);
      if (cv.width !== W || cv.height !== Hd) { cv.width = W; cv.height = Hd; }
      const pc = o.paper || [237, 233, 223];
      // 透明区清成「纸色、alpha 0」：画布被浏览器缩放插值时，板边不会混进黑色，烫后成品四周不出现一圈暗线
      gl.viewport(0, 0, W, Hd); gl.clearColor(pc[0] / 255, pc[1] / 255, pc[2] / 255, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(u('uDims'), dims[0], dims[1]);
      gl.uniform1f(u('uProg'), o.progress); gl.uniform1f(u('uMeltT'), o.melt);
      gl.uniform4f(u('uView'), o.ox, o.oy, o.s, o.mirror ? 1 : 0);
      gl.uniform3f(u('uCanvas'), o.h, o.dpr, o.ruler || 0);
      gl.uniform1i(u('uStyle'), o.style);
      const p = o.p || [];
      gl.uniform3f(u('uP'), p[0] ?? .5, p[1] ?? .5, p[2] ?? .5);
      gl.uniform2f(u('uTex'), o.amp, Math.max(o.scale, .2));
      const gq = o.glit || [.3, .3, .2, 140]; gl.uniform4f(u('uGlit'), gq[0], gq[1], gq[2], gq[3] ?? 140);
      gl.uniform4fv(u('uMat'), o.mat);
      const t = o.time || 0; // 光源缓慢摆动：闪片与毛面的明暗跟着变，平面俯视下也看得出质感
      gl.uniform3f(u('uL'), -.45 + .28 * Math.sin(t * .6), .6 + .22 * Math.sin(t * .43), .75);
      gl.uniform3f(u('uPaper'), pc[0] / 255, pc[1] / 255, pc[2] / 255);
      gl.uniform1f(u('uClear'), o.clear ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return { setGrid, render };
  }
  return { create };
})();
