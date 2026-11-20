/**
 * Liquid surfaces for acid, water and ice pools.
 *
 * One world-space shader draws every pool cell, so neighbouring cells join seamlessly:
 *   • a warped, drifting cell pattern (the cartoon "caustic" veins from the reference art) that slowly morphs,
 *   • a real rolling surface: the plane is displaced by travelling waves and lit with the wave normal, so the
 *     sun glints and slides across it like a liquid,
 *   • Fresnel sheen, sparkle glints, a soft foamy / crusted shoreline and shallow, see-through edges (water),
 *   • slow viscous bubbles that swell and pop (acid), ripple rings that follow Deeba as she wades (water).
 * Ice reuses the same code with the motion switched off and a hard glossy highlight.
 */

export const LIQUID = {
  acid: {
    base: '#7bd92a', deep: '#3f9a12', line: '#e3ff7e', rim: '#1f4a0a', sky: '#d8ff9a',
    speed: 0.42, scale: 1.25, glow: 0.45, wave: 0.02, waveSpeed: 0.55, spec: 0.55, specPow: 38, bubbles: 1.0, flow: 0.3, alpha: 1.0, foam: 0.0, ripple: 0.0, veins: 0.9,
  },
  water: {
    base: '#2f93f2', deep: '#1c62c4', line: '#b6e4ff', rim: '#eaf9ff', sky: '#cfeaff',
    speed: 0.55, scale: 1.05, glow: 0.0, wave: 0.028, waveSpeed: 1.0, spec: 0.6, specPow: 85, bubbles: 0.0, flow: 0.5, alpha: 0.93, foam: 1.0, ripple: 1.0, veins: 1.0,
  },
  ice: {
    base: '#bfe8f4', deep: '#8cc8dc', line: '#ffffff', rim: '#e8fbff', sky: '#ffffff',
    speed: 0.0, scale: 0.8, glow: 0.0, wave: 0.0, waveSpeed: 0.0, spec: 0.8, specPow: 120, bubbles: 0.0, flow: 0.0, alpha: 1.0, foam: 0.0, ripple: 0.0, veins: 0.8,
  },
};

export const liquidVertex = /* glsl */`
  attribute vec4 aEdge;
  uniform float time, wave, waveSpeed;
  varying vec2 vUv; varying vec4 vEdge; varying vec2 vWorld; varying vec3 vPos;
  // three travelling swells; analytic height + gradient so the fragment shader can light them
  const vec2 K1 = vec2(1.7, 0.9), K2 = vec2(-1.1, 2.1), K3 = vec2(2.6, -1.6);
  float swell(vec2 p, float t) { return sin(dot(K1, p) + t * 1.3) * 0.5 + sin(dot(K2, p) - t * 1.7) * 0.32 + sin(dot(K3, p) + t * 2.1) * 0.18; }
  void main() {
    vUv = uv; vEdge = aEdge;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    wp.y += wave * swell(wp.xz, time * waveSpeed);
    vWorld = wp.xz; vPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

export const liquidFragment = /* glsl */`
  uniform float time, speed, scale, glow, wave, waveSpeed, spec, specPow, bubbles, flow, alpha, foam, ripple, veins;
  uniform vec3 base, deep, line, rim, sky;
  uniform vec3 uPlayer;                       // x, z, activity (0..1): ripples follow Deeba through water
  uniform vec3 uSun;
  varying vec2 vUv; varying vec4 vEdge; varying vec2 vWorld; varying vec3 vPos;
  const vec2 K1 = vec2(1.7, 0.9), K2 = vec2(-1.1, 2.1), K3 = vec2(2.6, -1.6);

  vec2 hash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash1(i), hash1(i + vec2(1, 0)), f.x), mix(hash1(i + vec2(0, 1)), hash1(i + vec2(1, 1)), f.x), f.y); }

  // gradient of the swell function (matches the vertex shader)
  vec2 swellGrad(vec2 p, float t) {
    return K1 * cos(dot(K1, p) + t * 1.3) * 0.5 + K2 * cos(dot(K2, p) - t * 1.7) * 0.32 + K3 * cos(dot(K3, p) + t * 2.1) * 0.18;
  }

  void main() {
    float t = time;
    vec2 p = vWorld * scale;
    // drifting, domain-warped coordinates make the cell pattern flow and breathe like a liquid
    vec2 drift = vec2(t * 0.06, t * 0.04) * flow;
    vec2 q = p + drift + flow * 0.35 * vec2(sin(p.y * 1.3 + t * 0.7), cos(p.x * 1.1 + t * 0.6));

    // animated Voronoi: f2 - f1 is ~0 on the cell borders (the light veins)
    vec2 ip = floor(q), fp = fract(q);
    float f1 = 8.0, f2 = 8.0; vec2 cellId = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j)); vec2 o = hash2(ip + g);
      o = 0.5 + 0.5 * sin(t * speed + 6.2831 * o);
      float d = length(g + o - fp);
      if (d < f1) { f2 = f1; f1 = d; cellId = ip + g; } else if (d < f2) f2 = d;
    }
    float edgeD = f2 - f1;
    float vein = 1.0 - smoothstep(0.0, 0.13, edgeD);              // 1 on a crack
    float soft = 1.0 - smoothstep(0.0, 0.38, edgeD);              // wide glow around it (caustic light)
    float cellTone = 0.55 + 0.45 * vnoise(q * 1.7 + t * speed * 0.4);
    vec3 col = mix(deep, base, cellTone * (0.8 + 0.2 * hash1(cellId)));
    col = mix(col, line, soft * 0.28 * veins);
    col = mix(col, line, vein * veins);

    // surface normal from the swells (+ ripples that radiate from Deeba)
    vec2 g = swellGrad(vWorld, t * waveSpeed) * wave;
    float pd = distance(vWorld, uPlayer.xy);
    float ring = sin(pd * 15.0 - t * 7.0) * exp(-pd * 1.6) * uPlayer.z * ripple;
    g += normalize(vWorld - uPlayer.xy + 1e-4) * ring * 0.05;
    vec3 n = normalize(vec3(-g.x * 9.0, 1.0, -g.y * 9.0));
    vec3 V = normalize(cameraPosition - vPos);
    vec3 L = normalize(uSun);
    vec3 H = normalize(L + V);
    float sp = pow(max(dot(n, H), 0.0), specPow) * spec;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col += sky * fres * 0.22 + vec3(1.0) * sp;
    col *= 0.92 + 0.16 * dot(n, L);
    col += line * ring * 0.18 * step(0.001, uPlayer.z);

    // glitter: tiny moving glints on the swells
    float gl = vnoise(vWorld * 17.0 + vec2(t * 0.9, -t * 0.7));
    col += vec3(1.0) * smoothstep(0.93, 1.0, gl) * spec * 0.55 * (0.4 + 0.6 * sp * 4.0);

    // bubbles (acid): rings that swell, catch the light and pop
    if (bubbles > 0.0) {
      vec2 bp = vWorld * 2.0 + vec2(0.0, -t * 0.05); vec2 bid = floor(bp), bf = fract(bp) - 0.5;
      float rnd = hash1(bid);
      float life = fract(t * (0.16 + 0.12 * rnd) + rnd * 7.0);
      vec2 c = (hash2(bid + 3.7) - 0.5) * 0.45;
      float r = life * (0.22 + 0.16 * hash1(bid + 9.1));
      float d = length(bf - c);
      float on = step(0.35, rnd) * bubbles;
      float shellB = smoothstep(r + 0.025, r, d) - smoothstep(r, r - 0.03, d);
      float inner = smoothstep(r, r - 0.1, d) * 0.12;
      float hl = smoothstep(0.035, 0.0, length(bf - c - vec2(-r * 0.35, r * 0.35)));
      float pop = smoothstep(0.88, 0.95, life) * (1.0 - smoothstep(0.95, 1.0, life));
      col += (line * (shellB * 0.9 + inner) + vec3(1.0) * hl * 0.9 + vec3(1.0, 1.0, 0.7) * pop * smoothstep(0.1, 0.0, d) * 0.8) * on;
    }
    col += glow * vec3(0.55, 0.9, 0.2) * pow(soft, 2.0) * 0.35;     // acid glows faintly along its veins

    // shoreline: distance to the nearest side that has no neighbouring liquid cell, wobbled by noise
    float d = 1.0;
    d = min(d, mix(vUv.x, 1.0, vEdge.x));
    d = min(d, mix(1.0 - vUv.x, 1.0, vEdge.y));
    d = min(d, mix(vUv.y, 1.0, vEdge.z));
    d = min(d, mix(1.0 - vUv.y, 1.0, vEdge.w));
    d += (vnoise(vWorld * 3.1 + t * 0.1 * flow) - 0.5) * 0.16;
    float inside = smoothstep(0.0, 0.05, d);
    float rimBand = 1.0 - smoothstep(0.05, 0.2, d);
    float foamLace = smoothstep(0.45, 0.8, vnoise(vWorld * 9.0 + vec2(t * 0.4, 0.0))) * (1.0 - smoothstep(0.1, 0.32, d));
    col = mix(col, rim, rimBand * (foam > 0.5 ? 0.55 : 0.85));
    col = mix(col, rim, foamLace * foam * 0.8);
    if (inside < 0.02) discard;
    float a = alpha < 0.999 ? mix(0.62, alpha, smoothstep(0.02, 0.4, d)) : 1.0;   // shallow edges are see-through
    gl_FragColor = vec4(col, a * inside);
  }`;
