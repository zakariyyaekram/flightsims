// Tower / ground controller for the AI traffic and the player.
//
// Modelled on how ATC add-ons and other sims run their AI (BeyondATC, X-Plane 12 ATC, FlightGear's
// GroundController) and on FAA JO 7110.65:
//  - runway occupancy is tracked per physical runway, including intersecting runways (SFO 1L/1R cross 28L/28R);
//  - departures hold short until released: same runway clear, no arrival inside ~75 s of the threshold,
//    preceding departure spacing (2 min behind a heavy, 7110.65 3-9-6 / wake turbulence), and for intersecting
//    runways the landing traffic must have passed the intersection or be far enough behind (3-10-4);
//  - "line up and wait" when only departure spacing is pending (3-9-4);
//  - arrivals get a landing clearance at ~4 nm, speed control keeps ~3 nm (5 nm behind a heavy) on final,
//    and a go-around is issued at ~0.8 nm if the runway (or an intersecting one) is still occupied (3-10-3);
//  - runway crossings are cleared only with no landing traffic close in and no departure rolling;
//  - the player is a participant: their takeoff clearance is delayed while traffic lands, their landing
//    clearance carries a sequence number, and while they are cleared the runway is reserved, so AI hold
//    short or go around;
//  - one transmission at a time per frequency, readbacks follow the instruction (X-Plane 12 ATC style).
import { AIRPORTS, runwayEnd } from './geo.js';
import { onRunway, alongEnd, TYPE_NAME, flowInfo } from './traffic.js?v=20261124e';
import { freqFor, facilityName, atisLetter, STATIONS } from './atc.js?v=20261124e';

const NM = 1852, FT = 0.3048, D2R = Math.PI / 180;
const f2 = (f) => (Math.round(f * 1000) % 10 ? f.toFixed(3) : f.toFixed(2));
const DIRS = ['northbound', 'northeast-bound', 'eastbound', 'southeast-bound', 'southbound', 'southwest-bound', 'westbound', 'northwest-bound'];
const typeName = (t) => TYPE_NAME[t] || t;

// centreline intersections between the runways of an airport (cached on the airport)
function intersections(a) {
  if (a._ix) return a._ix;
  const ix = [];
  const R = a.runways;
  for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
    const r = R[i], s = R[j];
    const px = r.le[0], pz = r.le[1], dx = r.he[0] - px, dz = r.he[1] - pz, qx = s.le[0], qz = s.le[1], ex = s.he[0] - qx, ez = s.he[1] - qz;
    const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-6) continue;
    const t = ((qx - px) * ez - (qz - pz) * ex) / den, w = ((qx - px) * dz - (qz - pz) * dx) / den;
    if (t < -0.02 || t > 1.02 || w < -0.02 || w > 1.02) continue;
    const x = px + dx * t, z = pz + dz * t;
    ix.push({ r, s, x, z }, { r: s, s: r, x, z });
  }
  return (a._ix = ix);
}

export class Tower {
  constructor(traffic, atc) {
    this.traffic = traffic; this.atc = atc; this.t = 0; this.acc = 0;
    this.q = new Map(); this.rs = new Map(); this.adv = new Map(); this.advT = 0; this.stats = { released: 0, goArounds: 0, holds: 0, luaw: 0, crossings: 0, landed: 0 };
    this.U = []; this.sim = null;
  }
  flow(icao) { return flowInfo(icao, this.sim?.weather); }
  rwState(r) { let s = this.rs.get(r); if (!s) this.rs.set(r, (s = { lastTO: -1e9, heavy: false })); return s; }

  // ------------------------------------------------------------- radio
  say(freq, speaker, text, cb = null, front = false) {
    let q = this.q.get(freq); if (!q) this.q.set(freq, (q = { busy: 0, items: [] }));
    const it = { speaker, text, cb };
    if (front) q.items.unshift(it); else q.items.push(it);
    if (q.items.length > 12) { const k = q.items.findIndex((x) => !x.cb); if (k >= 0) q.items.splice(k, 1); }
  }
  pump(sim) {
    for (const [f, q] of this.q) {
      if (this.t < q.busy || !q.items.length) continue;
      const it = q.items.shift();
      if (this.atc.enabled) this.atc.hear(sim, f, it.speaker, it.text);
      q.busy = this.t + 0.9 + it.text.length / 17;
      try { it.cb && it.cb(); } catch (e) { console.warn('tower cb', e); }
    }
  }

  // ------------------------------------------------------------- traffic picture
  users(sim) {
    const U = [];
    for (const fl of this.traffic.enabled ? this.traffic.flights : []) {
      if (!fl.pos) continue;
      const r = fl.r; let eta = Infinity, kind = r.kind;
      if (kind === 'arr' && fl.state === 'arrival') eta = (r.sThr - fl.s) / Math.max(50, fl.v);
      if (kind === 'pattern') { const L = r.route.len, s = ((fl.s % L) + L) % L; if (s > L * 0.55 && fl.goT == null) { eta = (L - s) / 36; kind = 'arr'; } else kind = fl.agl < 40 ? 'dep' : 'pattern'; }
      U.push({ fl, x: fl.pos.x, z: fl.pos.z, agl: fl.agl, v: fl.v, icao: r.icao, rw: r.rw, end: r.end, kind, state: fl.state, eta, heavy: !!fl.heavy, type: fl.type, takeoff: !!fl.cleared.takeoff || fl.state === 'luaw' || fl.state === 'lineup' || fl.state === 'roll' || (r.kind === 'pattern' && fl.agl < 40 && !(fl.goT != null)) });
    }
    const F = sim.fdm, A = this.atc;
    if (F) {
      const gs = Math.hypot(F.vel[0], F.vel[2]);
      const p = { player: true, x: F.pos[0], z: F.pos[2], agl: F.agl ?? 0, v: gs, icao: A.airport.icao, onGround: !!F.onGround, kind: null, state: '', eta: Infinity, type: 'C172', takeoff: false };
      const fr = (icao, id) => { const a = AIRPORTS.find((q) => q.icao === icao); if (!a) return null; for (const r of a.runways) { const e = r.rwy.indexOf(id); if (e >= 0) return { r, e }; } return null; };
      if (A.enabled && A.pdep && A.pdep.state !== 'airborne') {
        const f = fr(A.pdep.icao, A.pdep.rwy);
        if (f) { p.rw = f.r; p.end = runwayEnd(f.r, f.e); p.kind = 'dep'; p.takeoff = A.pdep.state === 'cleared' || A.pdep.state === 'luaw'; p.state = A.pdep.state; }
      } else if (A.enabled && A.parr) {
        const f = fr(A.parr.icao, A.parr.rwy);
        if (f) {
          p.rw = f.r; p.end = runwayEnd(f.r, f.e); p.kind = 'arr'; const al = alongEnd(p.end, p.x, p.z);
          p.dist = Math.max(0, -al); p.eta = p.onGround ? -1 : p.dist / Math.max(25, gs); p.state = p.onGround ? 'landing' : 'arrival'; p.along = al;
        }
      }
      U.push(p);
    }
    return U;
  }

  /** release check for a departure (AI flight or the player) on runway r from end `end` */
  depDecision(self, r, end, a0, heavy, lineup = 22) {
    // line-up time counts toward every runway check (X-Plane 12.06): an aircraft still behind the hold line needs longer
    const U = this.U, a = AIRPORTS.find((q) => q.runways.includes(r));
    let luawOK = true, luawWhy = '';
    for (const u of U) {
      if (u === self) continue;
      const onR = onRunway(r, u.x, u.z, 8) && u.agl < 35;
      if (u.rw === r && u.takeoff && u.agl < 60 && u.kind === 'dep') { luawWhy = 'traffic departing'; return { luaw: true, why: luawWhy }; }
      if (onR) {
        if (u.kind === 'arr' || u.state === 'landing' || u.state === 'vacating') return { hold: true, why: 'traffic landing', noLuaw: true };
        if (u.kind === 'missed') return { hold: true, why: 'traffic on the go-around', noLuaw: true };
        return { hold: true, why: u.player ? 'traffic on the runway' : `traffic on the runway, ${typeName(u.type)}` };
      }
      if (u.rw === r && u.kind === 'arr' && Number.isFinite(u.eta)) {
        const same = u.end.id === end.id;
        if (same && u.eta < 55 + lineup) return { hold: true, why: `traffic on ${Math.max(1, Math.round((u.dist ?? u.eta * 70) / NM))}-mile final${u.type ? ', ' + typeName(u.type) : ''}` };
        if (!same && u.eta < 180) return { hold: true, why: 'opposite direction arrival' };
        if (same && u.eta < 105 + lineup) luawOK = false;
      }
      if (u.rw === r && u.kind === 'missed' && u.agl < 300) return { hold: true, why: 'traffic on the go-around' };
    }
    // crossing runways (7110.65 3-10-4): landing traffic must have passed the intersection, or be well behind
    for (const ix of intersections(a)) {
      if (ix.r !== r) continue;
      const alI = alongEnd(end, ix.x, ix.z); if (alI < a0 - 60) continue;
      // + radio, line-up and spool-up time; heavies accelerate slower
      const tDep = Math.sqrt(2 * Math.max(0, alI - a0) / (heavy ? 1.5 : 2.0)) + lineup;
      // wake: a heavy that just departed the crossing runway (FAA 7110.65 3-9-6/3-9-8)
      const sx = this.rwState(ix.s); if (sx.heavy && this.t - sx.lastTO < 120 && !heavy) return { hold: true, why: 'wake turbulence, heavy departing crossing runway' };
      for (const u of U) {
        if (u === self || u.rw !== ix.s || !u.end) continue;
        const tA = tArr(u, ix);
        // release only once the arrival is through the intersection, or far enough out that the departure clears first
        if (tA != null && tA > -5 && tA < tDep + 40) return { hold: true, why: `landing traffic runway ${u.end.id}`, noLuaw: true };
        if (tDepIx(u, ix) != null) return { hold: true, why: `traffic departing runway ${u.end.id}` };
      }
      for (const u of U) if (u !== self && u.agl < 30 && Math.hypot(u.x - ix.x, u.z - ix.z) < 110 && onRunway(ix.s, u.x, u.z, 8)) return { hold: true, why: 'traffic crossing' };
    }
    const st = this.rwState(r), need = st.heavy && !heavy ? 120 : 55, since = this.t - st.lastTO;
    if (since < need) return luawOK ? { luaw: true, why: st.heavy ? 'wake turbulence, departing heavy' : 'traffic departing' } : { hold: true, why: st.heavy ? 'wake turbulence' : 'traffic departing' };
    return { go: true };
  }

  /** null if an arrival `u` can land now, otherwise the go-around reason */
  landingUnsafe(u) {
    const r = u.rw, a = AIRPORTS.find((q) => q.runways.includes(r));
    for (const v of this.U) {
      if (v === u || !onRunway(r, v.x, v.z, 8) || v.agl > 35) continue;
      const al = v.end ? alongEnd(u.end, v.x, v.z) : 0;
      if ((v.state === 'landing' || v.state === 'vacating') && v.rw === r && al > 1300) continue;
      if (v.kind === 'dep' && v.state === 'roll' && v.v > 35 && al > 900) continue;
      if (v.fl && v.fl.r.kind === 'pattern' && v.agl > 3 && v.v > 25) continue;
      return v.player ? 'traffic on the runway' : 'traffic on the runway';
    }
    for (const ix of intersections(a)) {
      if (ix.r !== r) continue;
      const tA = tArr(u, ix); if (tA == null) continue;
      for (const v of this.U) {
        if (v === u || v.rw !== ix.s || !v.end) continue;
        const tD = tDepIx(v, ix);
        if (tD != null && v.state !== 'luaw' && tA > tD - 6 && tA < tD + 10) return `traffic departing runway ${v.end.id}`;
      }
      // something slow (taxiing / crossing) sitting in the intersection; fast departures are covered by the timing check above
      for (const v of this.U) if (v !== u && v.agl < 30 && v.v < 22 && v.state !== 'landing' && Math.hypot(v.x - ix.x, v.z - ix.z) < 90 && onRunway(ix.s, v.x, v.z, 8) && tA < 45) return 'traffic crossing the runway';
    }
    return null;
  }
  canCross(r, x, z) {
    // crossing near an intersection: the intersecting runway must be clear too (SFO 1L/1R crossings at 28L/28R)
    const a = AIRPORTS.find((q) => q.runways.includes(r));
    if (a && x != null) for (const ix of intersections(a)) {
      if (ix.r !== r || Math.hypot(ix.x - x, ix.z - z) > 320) continue;
      for (const u of this.U) {
        if (u.rw !== ix.s || !u.end) continue;
        const tA = tArr(u, ix); if (tA != null && tA > -5 && tA < 60) return false;
        const tD = tDepIx(u, ix); if (tD != null && tD < 45) return false;
      }
    }
    for (const u of this.U) {
      if (u.rw === r && u.kind === 'arr' && u.eta < 70) return false;
      if (u.rw === r && (u.state === 'landing' || u.state === 'vacating') && onRunway(r, u.x, u.z, 8)) return false;
      if (u.rw === r && u.takeoff && u.agl < 80) return false;
      if (u.player && onRunway(r, u.x, u.z, 8) && u.agl < 30) return false;
    }
    return true;
  }
  rwName(icao, r) {
    const fl = this.flow(icao); if (fl) for (const id of r.rwy) if (fl.arr.includes(id) || fl.dep.includes(id)) return id;
    return r.rwy[0];
  }

  // ------------------------------------------------------------- main loop
  update(sim, dt) {
    this.sim = sim; this.t += dt; this.acc += dt;
    if (!sim.fdm) return;
    const F = sim.fdm;
    const V = F.vel || [0, 0, 0];
    this.traffic.player = { x: F.pos[0], y: F.pos[1], z: F.pos[2], vx: V[0], vy: V[1], vz: V[2], v: Math.hypot(V[0], V[2]), agl: F.agl ?? 0, onGround: !!F.onGround, rad: sim.playerRad || 6 };
    if (!this.hooked) {
      this.hooked = true;
      // the AI safety net (runway occupied on short final, airborne conflict) tells the tower so it's on frequency
      this.traffic.onGoAround = (fl, why) => {
        try {
          const icao = fl.r.icao, twr = freqFor(icao, 'twr', fl.r.rwy), cs = fl.ga ? fl.spoken || fl.callsign : fl.callsign;
          this.stats.goArounds++; fl.msg.ga = true;
          this.say(twr, 'TOWER', `${cs}, go around, ${why}. Fly runway heading, climb and maintain 3,000.`, () => this.say(twr, fl.ident, `Going around, ${cs}.`, null, true), true);
        } catch (e) { /* radio is cosmetic */ }
      };
    }
    this.pump(sim);
    if (this.acc < 0.5) return;
    this.acc = 0;
    this.U = this.users(sim);
    const wind = this.atc.windText(sim);
    for (const u of this.U) if (u.fl) { try { this.flight(u, wind, sim); this.giveWay(u); } catch (e) { console.warn('tower', u.fl.callsign, e); } }
    this.spacing();
    this.playerLogic(sim);
    this.advisories(sim);
  }

  /** ground: tell a taxiing flight to give way when the traffic planner holds it for crossing traffic */
  giveWay(u) {
    const fl = u.fl; if (!fl.pos || fl.agl > 3) return;
    const M = fl.msg, gnd = freqFor(fl.r.icao, 'gnd', fl.r.rwy), cs = fl.callsign;
    if (fl.yieldKind === 'cross' && fl.v < 3 && !M.gw && this.t - (this.gwT || -99) > 20) {
      const o = fl.yieldTo, what = o === 'player' ? 'traffic' : 'the ' + (TYPE_NAME[o.type] || 'traffic');
      M.gw = true; this.gwT = this.t;
      this.say(gnd, 'GROUND', `${cs}, hold position, give way to ${what} passing left to right.`.replace(' passing left to right', ''), () => this.say(gnd, fl.ident, `Holding position, ${cs}.`, null, true));
    } else if (M.gw && !fl.yieldKind && fl.v > 2) {
      M.gw = false;
      this.say(gnd, 'GROUND', `${cs}, continue taxi.`, () => this.say(gnd, fl.ident, `Continuing, ${cs}.`, null, true));
    }
  }

  flight(u, wind, sim) {
    const fl = u.fl, r = fl.r, icao = r.icao, fac = facilityName(icao), cs = fl.ga ? fl.spoken || fl.callsign : fl.callsign, id = fl.ident;
    const twr = freqFor(icao, 'twr', r.rwy), gnd = freqFor(icao, 'gnd', r.rwy), S = STATIONS[icao] || {};
    const M = fl.msg;
    // runway crossings (any phase on the ground)
    if (fl.atStop && fl.atStop.kind === 'cross' && !fl.atStop.req) {
      const st = fl.atStop, name = this.rwName(icao, st.rw);
      if (!st.told) { st.told = true; this.say(twr, id, `${fac} Tower, ${cs}, holding short runway ${name}.`); }
      if (this.canCross(st.rw, fl.pos.x, fl.pos.z)) {
        st.req = true; this.stats.crossings++;
        this.say(twr, 'TOWER', `${cs}, ${fac} Tower, cross runway ${name}.`, () => { st.ok = true; this.say(twr, id, `Crossing ${name}, ${cs}.`, null, true); });
      }
    }
    if (r.kind === 'dep') {
      if (fl.state === 'gate' && fl.wait <= 0 && !M.req) {
        M.req = true;
        const cross = r.stops.find((s) => s.kind === 'cross');
        const hs = cross ? this.rwName(icao, cross.rw) : r.rwy;
        this.say(gnd, id, `${fac} Ground, ${cs}, gate ${r.stand}, ready to taxi with ${atisLetter(icao, sim)}.`, () => {
          this.say(gnd, 'GROUND', `${cs}, ${fac} Ground, runway ${r.rwy}, taxi via ${r.via}, hold short runway ${hs}.`, () => {
            fl.state = 'taxi'; this.say(gnd, id, `Runway ${r.rwy} via ${r.via}, hold short ${hs}, ${cs}.`, null, true);
          }, true);
        });
      }
      if (fl.state === 'holding' && !M.ready) { M.ready = true; fl.holdT = 0; this.say(twr, id, `${fac} Tower, ${cs}, holding short runway ${r.rwy}, ready.`, () => (M.readyDone = true)); }
      if ((fl.state === 'holding' || fl.state === 'luaw') && M.readyDone && !fl.pend && !fl.cleared.takeoff) {
        fl.holdT += 0.5;
        const a0 = Math.max(0, alongEnd(r.end, fl.pos.x, fl.pos.z));
        const lineup = fl.state === 'luaw' ? 6 : Math.max(0, r.sLine - fl.s) / 3 + 10;
        const d = this.depDecision(u, r.rw, r.end, fl.state === 'luaw' ? a0 : r.a0, fl.heavy, lineup);
        if (d.go) {
          fl.cleared.takeoff = true; fl.pend = true; u.takeoff = true; this.stats.released++;
          const st = this.rwState(r.rw); st.lastTO = this.t; st.heavy = fl.heavy;
          this.say(twr, 'TOWER', `${cs}, runway ${r.rwy}, ${wind}, cleared for takeoff.`, () => {
            for (const s of r.stops) if (s.kind === 'hold' || s.kind === 'line') s.ok = true;
            fl.pend = false; this.say(twr, id, `Cleared for takeoff ${r.rwy}, ${cs}.`, null, true);
          });
        } else if (d.luaw && fl.state === 'holding' && !fl.cleared.luaw) {
          fl.cleared.luaw = true; fl.pend = true; this.stats.luaw++;
          this.say(twr, 'TOWER', `${cs}, runway ${r.rwy}, line up and wait${d.why ? ', ' + d.why : ''}.`, () => {
            for (const s of r.stops) if (s.kind === 'hold') s.ok = true;
            fl.pend = false; this.say(twr, id, `Line up and wait ${r.rwy}, ${cs}.`, null, true);
          });
        } else if (d.hold && fl.state === 'holding' && fl.holdT > 15 && !M.holdTold) {
          M.holdTold = true; this.stats.holds++;
          this.say(twr, 'TOWER', `${cs}, ${fac} Tower, hold short runway ${r.rwy}, ${d.why}.`, () => this.say(twr, id, `Holding short ${r.rwy}, ${cs}.`, null, true));
        }
      }
      if (fl.state === 'climb' && fl.agl > 250 && !M.handoff) {
        M.handoff = true; const dn = S.depName || 'Departure';
        this.say(twr, 'TOWER', `${cs}, contact ${dn}. Good day.`, () => this.say(twr, id, `Over to departure, ${cs}.`, null, true));
      }
      return;
    }
    if (r.kind === 'arr') {
      if (fl.state === 'arrival') {
        const eta = u.eta, dist = (r.sThr - fl.s);
        if (eta < 185 && !M.call) { M.call = true; this.say(twr, id, `${fac} Tower, ${cs}, ${Math.max(2, Math.round(dist / NM))}-mile final runway ${r.rwy}.`); }
        if (eta < 125 && !fl.cleared.land && !fl.pendLand && M.call) {
          const why = this.landingUnsafe(u);
          if (!why || eta > 60) {
            fl.pendLand = true;
            this.say(twr, 'TOWER', `${cs}, ${fac} Tower, runway ${r.rwy}, ${wind}, cleared to land.`, () => { fl.cleared.land = true; this.say(twr, id, `Cleared to land ${r.rwy}, ${cs}.`, null, true); });
          }
        }
        if (eta < 21 && !M.ga) {
          const why = this.landingUnsafe(u) || (!fl.cleared.land && !fl.pendLand ? 'no landing clearance' : null);
          if (why) {
            M.ga = true; this.stats.goArounds++;
            this.traffic.goAround(fl, why);
            this.say(twr, 'TOWER', `${cs}, go around, ${why}. Fly runway heading, climb and maintain 3,000.`, () => this.say(twr, id, `Going around, runway heading, 3,000, ${cs}.`, null, true), true);
          }
        }
      }
      if (fl.state === 'landing' && fl.v < 40 && !M.exit) {
        M.exit = true; this.stats.landed++;
        const side = r.exitSide > 0 ? 'left' : r.exitSide < 0 ? 'right' : 'off';
        this.say(twr, 'TOWER', `${cs}, turn ${side} at the next taxiway, contact Ground ${f2(gnd)}.`, () => this.say(twr, id, `${f2(gnd)}, ${cs}.`, null, true));
      }
      if (fl.state === 'taxiIn' && !M.gnd) {
        M.gnd = true;
        const cross = r.stops.find((s) => s.kind === 'cross');
        this.say(gnd, id, `${fac} Ground, ${cs}, clear of ${r.rwy}.`, () => this.say(gnd, 'GROUND', `${cs}, ${fac} Ground, taxi to gate ${r.stand} via ${r.via || 'the parallel taxiway'}${cross ? `, hold short runway ${this.rwName(icao, cross.rw)}` : ''}.`, null, true));
      }
      return;
    }
    if (r.kind === 'missed') {
      if (fl.agl > 450 && !M.missOut) { M.missOut = true; const an = S.appName || 'Approach'; this.say(twr, 'TOWER', `${cs}, contact ${an} ${f2(S.app || 120.1)}.`, () => this.say(twr, id, `${an}, ${cs}.`, null, true)); }
      return;
    }
    if (r.kind === 'pattern') {
      const L = r.route.len, s = ((fl.s % L) + L) % L;
      if (s < L * 0.3 && M.lap) { fl.msg = {}; fl.cleared.land = false; return; }
      if (s > L * 0.72 && !M.lap) {
        M.lap = true;
        const side = r.right ? 'right' : 'left';
        this.say(twr, id, `${fac} Tower, ${cs}, ${side} base runway ${r.rwy}, touch and go.`, () => {
          const why = this.landingUnsafe(u);
          this.say(twr, 'TOWER', why ? `${cs}, ${fac} Tower, runway ${r.rwy}, continue, ${why}.` : `${cs}, ${fac} Tower, runway ${r.rwy}, cleared touch-and-go.`, () => { fl.cleared.land = !why; }, true);
        });
      }
      if (u.kind === 'arr' && u.eta < 12 && !M.ga && fl.goT == null) {
        const why = this.landingUnsafe(u);
        if (why) {
          M.ga = true; this.stats.goArounds++; this.traffic.goAround(fl, why);
          this.say(twr, 'TOWER', `${cs}, go around, ${why}.`, () => this.say(twr, id, `Going around, ${cs}.`, null, true), true);
        }
      }
    }
  }

  // speed control on final: ~3 nm between arrivals to the same runway, 4-5 nm behind a heavy (7110.65 5-5-4)
  spacing() {
    const by = new Map();
    for (const u of this.U) {
      if (u.kind !== 'arr' || !u.end || !(u.eta >= 0)) continue;
      if (u.fl && u.fl.r.kind !== 'arr') continue;
      const d = u.fl ? u.fl.r.sThr - u.fl.s : u.dist; if (!(d >= 0)) continue;
      const k = u.icao + '|' + u.end.id; if (!by.has(k)) by.set(k, []); by.get(k).push([d, u]);
    }
    for (const list of by.values()) {
      list.sort((p, q) => p[0] - q[0]);
      for (let i = 0; i < list.length; i++) {
        const [d, u] = list[i]; if (!u.fl) continue;
        let k = 1;
        if (i > 0) {
          const [dl, lead] = list[i - 1], gap = d - dl;
          const req = (lead.heavy ? (u.heavy ? 4 : 5) : lead.player ? 2.5 : 3) * NM;
          if (gap < req) k = Math.max(0.72, 1 - (req - gap) / req * 1.2);
        }
        u.fl.k += (k - u.fl.k) * 0.15;
      }
    }
  }

  // ------------------------------------------------------------- player
  playerDepartureDecision(sim) {
    this.U = this.users(sim);
    const p = this.U.find((u) => u.player); if (!p || !p.rw) return { go: true };
    const a0 = Math.max(0, alongEnd(p.end, p.x, p.z));
    return this.depDecision(p, p.rw, p.end, a0, false, 30);
  }
  playerArrivalSequence(sim) {
    this.U = this.users(sim);
    const p = this.U.find((u) => u.player); if (!p || !p.rw) return { n: 1 };
    const dOf = (u) => (u.fl && u.fl.r.kind === 'arr' ? u.fl.r.sThr - u.fl.s : u.eta * 36);
    const ahead = this.U.filter((u) => !u.player && u.kind === 'arr' && u.rw === p.rw && u.end && u.end.id === p.end.id && dOf(u) < p.dist);
    ahead.sort((x, y) => dOf(y) - dOf(x));
    const lead = ahead[0];
    const why = this.landingUnsafe(p);
    return { n: ahead.length + 1, lead: lead ? typeName(lead.type) : null, leadAt: lead ? `${Math.max(1, Math.round(dOf(lead) / NM))}-mile final` : '', wait: why && p.eta < 60 ? why : null };
  }
  playerLogic(sim) {
    const A = this.atc; if (!A.enabled) return;
    const p = this.U.find((u) => u.player); if (!p) return;
    if (A.pdep) {
      if ((A.pdep.state === 'hold' || A.pdep.state === 'luaw') && A.stage === 'towerReady') {
        A.pdep.t = (A.pdep.t || 0) + 0.5;
        if (A.pdep.t > 4) {
          const d = this.depDecision(p, p.rw, p.end, Math.max(0, alongEnd(p.end, p.x, p.z)), false);
          if (d.go) { A.issueTakeoff(sim); const st = this.rwState(p.rw); st.lastTO = this.t; st.heavy = false; this.stats.released++; }
          else if (d.luaw && A.pdep.state === 'hold') A.issueLUAW(sim, d.why);
        }
      }
      if (A.pdep.state === 'cleared' && p.agl > 60) A.pdep.state = 'airborne';
    }
    if (A.parr && p.rw) {
      if (!A.parr.cleared && p.eta < 100 && p.eta >= 0 && !this.landingUnsafe(p)) A.issueLanding(sim);
      else if (A.parr.cleared && p.eta >= 0 && p.eta < 18 && !p.onGround) { const why = this.landingUnsafe(p); if (why) { A.issueGoAround(sim, why); this.stats.goArounds++; } }
      if (p.onGround && p.v < 12 && !onRunway(p.rw, p.x, p.z, 6)) A.parr = null;
    }
  }
  // traffic advisories from real AI positions (7110.65 2-1-21: clock position, distance, direction, altitude, type)
  advisories(sim) {
    const A = this.atc, F = sim.fdm; if (!A.enabled || !this.traffic.enabled || F.onGround || (F.agl ?? 0) < 60) return;
    if (this.t - this.advT < 20) return;
    const hdg = F.attitude.hdg;
    for (const t of this.traffic.list) {
      const dx = t.x - F.pos[0], dz = t.z - F.pos[2], d = Math.hypot(dx, dz), dy = t.y - F.pos[1];
      if (d > 4.5 * NM || Math.abs(dy) > 1500 * FT || t.y - (AIRPORTS.find((a) => a.icao === t.icao)?.elev ?? 0) < 60) continue;
      const last = this.adv.get(t.id) || -1e9; if (this.t - last < 150) continue;
      // closing?
      const th = t.hdg * D2R, vx = Math.sin(th) * t.gs * 0.514, vz = -Math.cos(th) * t.gs * 0.514, rr = (dx * (vx - F.vel[0]) + dz * (vz - F.vel[2])) / Math.max(d, 1);
      if (rr > 0 && d > 1.5 * NM) continue;
      const brg = (Math.atan2(dx, -dz) / D2R + 360) % 360, rel = (brg - hdg + 360) % 360, clock = Math.round(rel / 30) % 12 || 12;
      const dir = DIRS[Math.round(t.hdg / 45) % 8], alt = Math.round(t.alt / 100) * 100;
      const txt = `${A.callsign}, traffic, ${clock} o'clock, ${Math.max(1, Math.round(d / NM))} mile${d > 1.5 * NM ? 's' : ''}, ${dir}, ${alt.toLocaleString('en-US')}, ${typeName(t.type)}.`;
      A.trafficAdvisory(txt); this.adv.set(t.id, this.t); this.advT = this.t; break;
    }
  }
}

// seconds until an arriving / landing aircraft reaches intersection ix (null if it has passed or isn't arriving)
function tArr(u, ix) {
  if (!(u.kind === 'arr' || u.state === 'landing' || u.state === 'vacating')) return null;
  const ixAl = alongEnd(u.end, ix.x, ix.z), uAl = alongEnd(u.end, u.x, u.z);
  if (uAl > ixAl + 50) return null;
  if (Number.isFinite(u.eta) && u.eta >= 0) return u.eta + (ixAl > 330 ? 6 + (ixAl - 330) / 55 : Math.max(0, ixAl) / 70);
  if (u.agl < 30) return (ixAl - uAl) / Math.max(u.v, 6);
  return null;
}
// seconds until a departure cleared on its runway reaches intersection ix (null if passed / not departing)
function tDepIx(v, ix) {
  if (v.kind !== 'dep' || !v.takeoff || v.agl > 100) return null;
  const ixAl = alongEnd(v.end, ix.x, ix.z), vAl = alongEnd(v.end, v.x, v.z), d = ixAl - vAl;
  if (d < -60) return null;
  if (v.state === 'roll' && v.v > 3) return (Math.sqrt(v.v * v.v + 4 * Math.max(0, d)) - v.v) / 2;
  return Math.sqrt(Math.max(0, d)) + 10;
}
