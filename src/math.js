// Minimal vector / quaternion math for the flight model (no three.js dependency so it can be tested in Node)
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const addTo = (a, b) => { a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; return a; };
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const DEG = Math.PI / 180;

// Quaternion [x,y,z,w], rotates body -> world
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
export const qrot = (q, v) => {
  // v' = q v q*
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
};
export const qinvrot = (q, v) => qrot([-q[0], -q[1], -q[2], q[3]], v);
export const qaxis = (axis, ang) => { const s = Math.sin(ang / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)]; };
// Euler from heading (deg, clockwise from north), pitch (deg, nose up), roll (deg, right wing down)
// World: +X east, +Y up, +Z south. Body: +x forward, +y up, +z right.
export function qFromHPR(hdg, pitch, roll) {
  // body forward (+x) at heading 0 must point north (-Z world). Base rotation: yaw about Y.
  // rotation about +Y by angle a maps +X -> (cos a, 0, -sin a). North (-Z) needs a = +90deg. heading clockwise -> a = 90 - hdg
  const qy = qaxis([0, 1, 0], (90 - hdg) * DEG);
  const qp = qaxis([0, 0, 1], pitch * DEG); // about body z (right): +x -> +y nose up
  const qr = qaxis([1, 0, 0], roll * DEG); // about body x: y -> z  = right wing down
  return qnorm(qmul(qmul(qy, qp), qr));
}
export function hprFromQ(q) {
  const f = qrot(q, [1, 0, 0]);
  const u = qrot(q, [0, 1, 0]);
  const pitch = Math.asin(clamp(f[1], -1, 1)) / DEG;
  let hdg = Math.atan2(f[0], -f[2]) / DEG; // east component, north component
  if (hdg < 0) hdg += 360;
  // roll: angle of right wing below horizon
  const r = qrot(q, [0, 0, 1]);
  const roll = Math.atan2(-r[1], u[1]) / DEG;
  return { hdg, pitch, roll };
}
