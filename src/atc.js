// Player ATC: scripted clearance flow (ground -> tower -> departure / approach -> tower -> ground) on the
// real published frequencies (AirNav / FAA Chart Supplement), with an ATIS, and wired to the Tower
// (tower.js), which also controls the AI traffic: takeoff clearance only when the runway, crossing runways
// and the approach are clear; landing sequence ("number 2, follow the Boeing 737 on 3-mile final");
// go-arounds; traffic advisories built from the actual AI positions. AI radio calls are heard when COM 1 or
// COM 2 is tuned to the frequency they are on.
import { AIRPORTS } from './geo.js';

const FT = 0.3048;
const NM = 1852;

// Real frequencies (AirNav, FAA Chart Supplement). alt = split tower/ground by runway.
export const STATIONS = {
  KSFO: { name: 'San Francisco', atis: 118.85, del: 118.2, gnd: 121.8, twr: 120.5, app: 134.5, dep: 135.1, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class B' },
  KOAK: { name: 'Oakland', atis: 133.775, del: 121.1, gnd: 121.75, twr: 127.2, app: 125.35, dep: 120.9, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class C', alt: { rwys: ['10L', '28R', '10R', '28L', '15', '33'], twr: 118.3, gnd: 121.9 } },
  KSJC: { name: 'San Jose', atis: 126.95, del: 118.0, gnd: 121.7, twr: 124.0, app: 120.1, dep: 121.3, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class C' },
  KNUQ: { name: 'Moffett', atis: 124.175, gnd: 121.85, twr: 119.55, app: 120.1, dep: 120.1, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KHWD: { name: 'Hayward', atis: 126.7, del: 128.05, gnd: 121.4, twr: 120.2, app: 124.4, dep: 124.4, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KSQL: { name: 'San Carlos', atis: 125.9, gnd: 118.025, twr: 119.0, app: 135.65, dep: 135.65, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KPAO: { name: 'Palo Alto', atis: 135.275, gnd: 125.0, twr: 118.6, app: 121.3, dep: 121.3, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KLVK: { name: 'Livermore', atis: 119.65, gnd: 121.6, twr: 118.1, app: 123.85, dep: 123.85, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KCCR: { name: 'Concord', atis: 124.7, del: 118.025, gnd: 121.9, twr: 119.7, app: 119.9, dep: 119.9, appName: 'Travis Approach', depName: 'Travis Departure', cls: 'Class D' },
  KAPC: { name: 'Napa', atis: 124.05, del: 127.85, gnd: 121.7, twr: 118.7, app: 127.8, dep: 127.8, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D' },
  KRHV: { name: 'Reid-Hillview', atis: 125.2, gnd: 121.65, twr: 119.8, app: 120.1, dep: 121.3, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class D', alt: { rwys: ['13R', '31L'], twr: 126.1, gnd: 121.65 } },
  KHAF: { name: 'Half Moon Bay', ctaf: 122.8, app: 135.1, dep: 135.1, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class G' },
  KDVO: { name: 'Gnoss', ctaf: 123.075, app: 127.8, dep: 127.8, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class G' },
  KO69: { name: 'Petaluma', ctaf: 122.7, app: 127.8, dep: 127.8, appName: 'NorCal Approach', depName: 'NorCal Departure', cls: 'Class G' },
};
/** frequency for a facility kind ('twr' | 'gnd' | 'atis' | 'app' | 'dep' | 'del') at an airport, optionally by runway */
export function freqFor(icao, kind, rwy) {
  const s = STATIONS[icao]; if (!s) return kind === 'gnd' ? 121.9 : 118.0;
  if (s.alt && rwy && s.alt.rwys.includes(rwy) && s.alt[kind]) return s.alt[kind];
  if (s.ctaf && (kind === 'twr' || kind === 'gnd')) return s.ctaf;
  return s[kind] || s.twr || s.ctaf || 118.0;
}
export const facilityName = (icao) => STATIONS[icao]?.name || icao;
const PHON = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu'];
/** current ATIS letter: advances hourly (routine hourly METAR), different per airport */
export function atisLetter(icao, sim) {
  const h = Math.floor(((sim?.timeOfDay ?? 12) + 24) % 24);
  const k = (icao.charCodeAt(1) * 7 + icao.charCodeAt(2) * 3 + h) % 26; return PHON[k];
}

function nearestAirport(pos) {
  let best = null;
  let distance = Infinity;
  for (const airport of AIRPORTS) {
    const d = Math.hypot(airport.x - pos[0], airport.z - pos[2]);
    if (d < distance) { distance = d; best = airport; }
  }
  return { airport: best, distance };
}

function runwayName(airport, heading) {
  let best = null, bd = 1e9;
  for (const r of airport.runways || []) for (let e = 0; e < 2; e++) {
    const h = e === 0 ? r.hdg : (r.hdg + 180) % 360; const d = Math.abs(((heading - h + 540) % 360) - 180) + (r === airport.runways[0] ? 0 : 3);
    if (d < bd) { bd = d; best = r.rwy[e]; }
  }
  return best || 'runway';
}
const f2 = (f) => (Math.round(f * 1000) % 10 ? f.toFixed(3) : f.toFixed(2));

export class ATC {
  constructor() {
    this.enabled = true;
    this.trafficEnabled = true;
    this.reset({ spawn: 'SFO28' });
  }

  reset(setup) {
    this.log = [];
    this.stage = 'initial';
    this.role = 'ground';
    this.frequency = 121.8;
    this.airport = AIRPORTS.find((a) => a.icao === 'KSFO') || AIRPORTS[0];
    this.runway = '28L';
    this.callsign = 'Skyhawk 172SP';
    this.transmission = '';
    this.speaker = '';
    this.options = [];
    this.extras = [];
    this.timer = 0;
    this.messageId = 0;
    this.pdep = null; // player departure: {icao, rwy, state: 'hold' | 'luaw' | 'cleared' | 'airborne'}
    this.parr = null; // player arrival: {icao, rwy, cleared}
    this.trafficEnabled = setup?.aiTraffic !== false;
    this.initFromSetup(setup);
  }

  station(kind, rwy = this.runway) { return freqFor(this.airport.icao, kind, rwy); }
  get fac() { return facilityName(this.airport.icao); }
  get towered() { return !!STATIONS[this.airport.icao]?.twr; }

  initFromSetup(setup) {
    const SP = { SFO28: ['KSFO', '28L'], SFO28rwy: ['KSFO', '28L'], SFOramp: ['KSFO', '28L'], SFO1R: ['KSFO', '1R'], ILS28: ['KSFO', '28L'], OAK30: ['KOAK', '30'], OAK12: ['KOAK', '12'], OAK28R: ['KOAK', '28R'], SJC30: ['KSJC', '30L'], HWD28: ['KHWD', '28L'], SQL30: ['KSQL', '30'], PAO31: ['KPAO', '31'], LVK25: ['KLVK', '25R'], CCR32: ['KCCR', '32R'], RHV31: ['KRHV', '31R'], APC36: ['KAPC', '19R'], HAF30: ['KHAF', '30'], NUQ32: ['KNUQ', '32R'], DVO31: ['KDVO', '31'], O69: ['KO69', '29'], GG: ['KSFO', '28L'], cruise: ['KOAK', '30'] };
    const [airportCode, rwyCode] = SP[setup.spawn] || ['KSFO', '28L'];
    this.airport = AIRPORTS.find((a) => a.icao === airportCode) || this.airport;
    this.runway = setup.depRwy || rwyCode || runwayName(this.airport, this.airport.hdg);
    this.taxiVia = setup.taxiVia || 'Alpha';

    if (setup.ramp || setup.spawn === 'SFOramp') {
      this.role = 'ground';
      this.frequency = this.station('gnd');
      this.stage = 'ramp';
      this.transmission = `${this.fac} Ground, ${this.callsign}, at the general aviation ramp with information ${atisLetter(this.airport.icao)}, requesting taxi for VFR departure.`;
      this.speaker = 'YOU';
      this.options = [
        { label: 'Request taxi', action: 'requestTaxi' },
        { label: 'Request flight following', action: 'requestFollowing' },
      ];
    } else if (setup.spawn === 'ILS28') {
      this.role = 'approach';
      this.frequency = this.station('app');
      this.stage = 'approach';
      this.transmission = `${this.callsign}, 8 miles from ${this.runway}, inbound for ILS.`;
      this.speaker = 'YOU';
      this.options = [
        { label: 'Contact approach', action: 'contactApproach' },
        { label: 'Request missed approach?', action: 'requestMissedBrief' },
      ];
    } else {
      this.role = 'tower';
      this.frequency = this.station('twr');
      this.stage = 'departurePosition';
      this.setATC(`${this.fac} Tower, ${this.callsign}, runway ${this.runway}, ready for departure.`, 'YOU',
        [{ label: 'Call ready for departure', action: 'readyDeparture' }]);
    }
  }

  setATC(text, speaker = 'ATC', options = []) {
    this.messageId++;
    this.transmission = text;
    this.speaker = speaker;
    this.options = options;
    if (speaker !== 'YOU') this.logLine(speaker, text);
  }

  logLine(speaker, text, ai = false) {
    this.log.unshift({ id: ++this.messageId, speaker, text, ai });
    this.log = this.log.slice(0, 14);
  }

  /** a transmission on `freq` (AI traffic or a controller talking to it): heard if COM 1 or COM 2 is tuned to it */
  hear(sim, freq, speaker, text) {
    const av = sim.av; if (!av) return false;
    const on = (c, n) => !!c && Math.abs(c.active - freq) < 0.004 && (!av.comPowered || !sim.fdm.eff || av.comPowered(sim.fdm, n));
    if (!on(av.com1, 1) && !on(av.com2, 2)) return false;
    this.logLine(speaker, text, true); this.dirty = true; return true;
  }

  setFrequency(sim, frequency) {
    (sim.av.micRadio ? sim.av.micRadio() : sim.av.com1).active = frequency;
  }

  readback(text) {
    this.logLine('YOU', text);
  }

  windText(sim) {
    const w = sim.weather || { windDir: 250, windKt: 8 };
    if (Math.round(w.windKt) < 3) return 'wind calm';
    return `wind ${String(Math.round(w.windDir / 10) * 10 || 360).padStart(3, '0')} at ${Math.round(w.windKt)}`;
  }

  atisText(sim) {
    const icao = this.airport.icao, s = STATIONS[icao] || {}, w = sim.weather || { windDir: 280, windKt: 8, visKm: 16, qnhInHg: 29.92, cover: 0, baseFt: 4000 };
    const z = Math.floor(((sim.timeOfDay ?? 12) + 8) % 24); // PST -> UTC
    const flow = sim.tower?.flow(icao);
    const rw = flow ? `Landing runways ${flow.arr.join(' and ')}, departing runways ${flow.dep.join(' and ')}` : `Landing and departing runway ${this.runway}`;
    const vis = Math.min(10, Math.round((w.visKm ?? 16) / 1.609));
    const sky = (w.cover ?? 0) > 0.6 ? `ceiling ${Math.round((w.baseFt ?? 3000) / 100) * 100} broken` : (w.cover ?? 0) > 0.2 ? `${Math.round((w.baseFt ?? 3000) / 100) * 100} scattered` : 'sky clear';
    const hot = sim.taxiChart?.(icao)?.hot?.length ? ` Notice to airmen: hot spots are depicted on the airport diagram, ${sim.taxiChart(icao).hot.length} listed.` : '';
    return `${s.name || icao} information ${atisLetter(icao, sim)}, ${String(z).padStart(2, '0')}56 Zulu. ${this.windText(sim).replace('wind', 'Wind')}. Visibility ${vis}. ${sky[0].toUpperCase() + sky.slice(1)}. Altimeter ${(w.qnhInHg ?? 29.92).toFixed(2).replace('.', '')}. ${rw}.${hot} Advise on initial contact you have information ${atisLetter(icao, sim)}.`;
  }

  get extraOptions() {
    const x = [];
    if (STATIONS[this.airport.icao]?.atis) x.push({ label: `ATIS ${f2(this.station('atis'))}`, action: 'atis' });
    return [...this.extras, ...x];
  }

  act(action, sim) {
    if (!this.enabled) {
      this.setATC('ATC communications are disabled. Enable Realistic ATC communications in setup.', 'RADIO', []);
      return;
    }
    const runway = this.runway, cs = this.callsign, fac = this.fac, T = sim.tower;
    if (action === 'atis') { this.logLine('ATIS', this.atisText(sim)); this.transmission = this.atisText(sim); this.speaker = `ATIS ${f2(this.station('atis'))}`; return; }
    if (action === 'trafficInSight' || action === 'trafficLooking') {
      this.readback(action === 'trafficInSight' ? `Traffic in sight, ${cs}.` : `Looking, ${cs}.`);
      this.extras = []; return;
    }
    const n = sim.av.audio?.mic === 2 ? 2 : 1;
    const radio = sim.av.micRadio ? sim.av.micRadio() : sim.av.com1;
    if (sim.av.audio && sim.av.audio.mic > 2) {
      this.setATC('The audio panel MIC selector is on COM 3 / TEL. Select COM 1 or COM 2 to transmit.', 'RADIO', this.options);
      return;
    }
    if (sim.av.comPowered && sim.fdm.eff && !sim.av.comPowered(sim.fdm, n)) {
      this.setATC(`COM ${n} has no power. Check MASTER, AVIONICS, the COM ${n} breaker and the radio's power knob.`, 'RADIO', this.options);
      return;
    }
    const active = Math.round(radio.active * 1000) / 1000;
    if (action !== 'requestFollowing' && action !== 'requestMissedBrief' && Math.abs(active - this.frequency) > 0.004) {
      this.setATC(`Tune COM ${n} to ${f2(this.frequency)} MHz before transmitting on this frequency.`, 'RADIO',
        this.options);
      return;
    }
    const gnd = this.station('gnd'), twr = this.station('twr'), app = this.station('app'), dep = this.station('dep'), S = STATIONS[this.airport.icao] || {};

    switch (action) {
      case 'requestTaxi':
        this.readback(`${cs}, general aviation ramp, ready to taxi with ${atisLetter(this.airport.icao, sim)}.`);
        this.role = 'ground'; this.frequency = gnd; this.setFrequency(sim, gnd);
        this.stage = 'taxi';
        this.taxiVia = sim.taxi?.route?.viaText || this.taxiVia;
        this.setATC(`${cs}, ${fac} Ground, runway ${runway}, taxi via ${this.taxiVia}, hold short of runway ${runway}.`, 'GROUND',
          [{ label: 'Read back taxi clearance', action: 'ackTaxi' }, { label: 'Request progressive taxi', action: 'progressiveTaxi' }]);
        break;
      case 'ackTaxi':
        this.readback(`Runway ${runway}, taxi via ${this.taxiVia}, hold short runway ${runway}, ${cs}.`);
        this.setATC(`${cs}, readback correct. Contact ${fac} Tower ${f2(twr)} when ready.`, 'GROUND',
          [{ label: 'Contact Tower', action: 'contactTower' }]);
        break;
      case 'progressiveTaxi':
        this.setATC(`${cs}, progressive taxi: follow the magenta taxi line (T) via ${this.taxiVia}, hold short of runway ${runway}.`, 'GROUND',
          [{ label: 'Read back progressive taxi', action: 'ackTaxi' }]);
        break;
      case 'contactTower':
        this.role = 'tower'; this.frequency = twr; this.setFrequency(sim, twr);
        this.readback(`${fac} Tower, ${cs}, taxiing to runway ${runway}.`);
        this.stage = 'towerTaxi';
        this.setATC(`${cs}, ${fac} Tower, hold short runway ${runway}, advise ready.`, 'TOWER',
          [{ label: 'Ready for departure', action: 'readyDeparture' }]);
        break;
      case 'readyDeparture': {
        this.role = 'tower'; this.frequency = twr; this.setFrequency(sim, twr);
        this.readback(`${fac} Tower, ${cs}, holding short runway ${runway}, ready for departure.`);
        this.stage = 'towerReady';
        this.pdep = { icao: this.airport.icao, rwy: runway, state: 'hold', t: 0 };
        const d = T ? T.playerDepartureDecision(sim) : { go: true };
        if (d.go) this.issueTakeoff(sim);
        else if (d.luaw) this.issueLUAW(sim, d.why);
        else this.setATC(`${cs}, ${fac} Tower, hold short runway ${runway}, ${d.why || 'traffic'}.`, 'TOWER',
          [{ label: 'Hold short, runway ' + runway, action: 'holdShortReadback' }]);
        break;
      }
      case 'holdShortReadback':
        this.readback(`Holding short runway ${runway}, ${cs}.`);
        this.options = []; this.transmission = 'Holding short. The tower will clear you when the runway and approach are clear.'; this.speaker = 'INFO';
        break;
      case 'holdShort':
      case 'lineUp':
        this.readback(`Runway ${runway}, line up and wait, ${cs}.`);
        this.options = []; this.transmission = 'Lined up and waiting. Expect the takeoff clearance from the tower.'; this.speaker = 'INFO';
        break;
      case 'takeoffReadback':
        this.readback(`Cleared for takeoff runway ${runway}, ${cs}.`);
        this.stage = 'airborne';
        this.setATC(`${cs}, fly runway heading, climb and maintain 3,000.`, 'TOWER',
          [{ label: 'Departure readback', action: 'departureReadback' }]);
        break;
      case 'departureReadback':
        this.readback(`Fly runway heading, climb and maintain 3,000, ${cs}.`);
        this.role = 'departure'; this.frequency = dep;
        this.setATC(`${cs}, contact ${S.depName || 'Departure'} ${f2(dep)}.`, 'TOWER',
          [{ label: 'Contact Departure', action: 'contactDeparture' }]);
        break;
      case 'contactDeparture':
      case 'requestFollowing':
        this.role = 'departure'; this.frequency = dep; this.setFrequency(sim, dep);
        this.setATC(`${cs}, ${S.depName || 'Departure'}, radar contact. Squawk 0431.`, 'DEPARTURE',
          [{ label: 'Roger, radar contact', action: 'radarReadback' }]);
        break;
      case 'radarReadback':
        this.readback(`Squawk 0431, ${cs}.`);
        sim.av.xpdr.code = '0431';
        this.setATC(`${cs}, maintain VFR at or below 3,500, proceed on course.`, 'DEPARTURE',
          [{ label: 'Maintain 3,500', action: 'maintainAltitude' }]);
        break;
      case 'maintainAltitude':
        this.readback(`At or below 3,500, ${cs}.`);
        this.setATC(`${cs}, no traffic observed between you and destination. Frequency change approved.`, 'DEPARTURE',
          [{ label: 'Frequency change approved', action: 'enroute' }]);
        break;
      case 'enroute':
        this.role = 'monitor';
        this.setATC(`${cs}, monitoring. Remain outside controlled airspace unless cleared.`, 'ATC',
          [{ label: 'Copy', action: 'copyOnly' }]);
        break;
      case 'contactApproach':
        this.role = 'approach'; this.frequency = app; this.setFrequency(sim, app);
        this.setATC(`${cs}, ${S.appName || 'Approach'}, radar contact 8 miles, cleared ILS runway ${runway} approach, maintain 3,000 until established.`, 'APPROACH',
          [{ label: 'Read back ILS clearance', action: 'ackApproach' }]);
        break;
      case 'ackApproach':
        this.readback(`Cleared ILS runway ${runway}, maintain 3,000 until established, ${cs}.`);
        this.role = 'tower'; this.frequency = twr;
        this.setATC(`${cs}, contact ${fac} Tower ${f2(twr)}.`, 'APPROACH',
          [{ label: 'Switch to Tower', action: 'towerLanding' }]);
        break;
      case 'towerLanding': {
        this.setFrequency(sim, twr); this.frequency = twr; this.role = 'tower';
        this.readback(`${fac} Tower, ${cs}, on the ILS runway ${runway}.`);
        this.parr = { icao: this.airport.icao, rwy: runway, cleared: false };
        const q = T ? T.playerArrivalSequence(sim) : { n: 1 };
        const seq = q.n > 1 && q.lead ? `number ${q.n}, follow the ${q.lead} on ${q.leadAt}, ` : '';
        if (q.wait) {
          this.setATC(`${cs}, ${fac} Tower, runway ${runway}, ${seq}continue, ${q.wait}.`, 'TOWER', [{ label: 'Continue', action: 'continueReadback' }]);
        } else {
          this.parr.cleared = true;
          this.setATC(`${cs}, ${fac} Tower, runway ${runway}, ${seq}${this.windText(sim)}, cleared to land.`, 'TOWER',
            [{ label: 'Cleared to land, runway ' + runway, action: 'landingReadback' }]);
        }
        break;
      }
      case 'continueReadback':
        this.readback(`Continue, ${cs}.`); this.options = []; this.transmission = 'Continue the approach; expect the landing clearance.'; this.speaker = 'INFO';
        break;
      case 'landingReadback':
        this.readback(`Cleared to land runway ${runway}, ${cs}.`);
        this.stage = 'landed';
        this.setATC(`${cs}, after landing vacate at the next taxiway, contact Ground ${f2(gnd)}.`, 'TOWER',
          [{ label: 'Vacated runway', action: 'contactGroundAfterLanding' }]);
        break;
      case 'goAroundReadback':
        this.readback(`Going around, ${cs}.`); this.parr = null;
        this.setATC(`${cs}, fly runway heading, climb and maintain 2,000, re-enter the pattern.`, 'TOWER', [{ label: 'Request landing', action: 'towerLanding' }]);
        break;
      case 'contactGroundAfterLanding':
        this.role = 'ground'; this.frequency = gnd; this.setFrequency(sim, gnd); this.parr = null;
        this.readback(`${fac} Ground, ${cs}, clear of ${runway}, taxi to parking.`);
        this.setATC(`${cs}, ${fac} Ground, taxi to parking via ${this.taxiVia || 'the parallel taxiway'}.`, 'GROUND',
          [{ label: 'Taxi to parking', action: 'taxiParking' }]);
        break;
      case 'taxiParking':
        this.readback(`Taxi to parking, ${cs}.`);
        this.setATC(`${cs}, readback correct. Welcome back.`, 'GROUND', []);
        break;
      case 'requestMissedBrief':
        this.setATC(`Missed approach: climbing, turn as published or as directed, set 4,000 feet, and request instructions.`, 'ATC',
          [{ label: 'Copy missed-approach plan', action: 'copyOnly' }]);
        break;
      case 'copyOnly':
        this.readback('Copied.');
        break;
    }
  }

  /** called by the tower when the player's departure is released */
  issueTakeoff(sim) {
    if (this.pdep) this.pdep.state = 'cleared';
    this.setATC(`${this.callsign}, runway ${this.runway}, ${this.windText(sim)}, cleared for takeoff.`, 'TOWER',
      [{ label: 'Cleared for takeoff, runway ' + this.runway, action: 'takeoffReadback' }]);
    this.dirty = true;
  }
  issueLUAW(sim, why) {
    if (this.pdep) this.pdep.state = 'luaw';
    this.setATC(`${this.callsign}, runway ${this.runway}, line up and wait${why ? ', ' + why : ''}.`, 'TOWER',
      [{ label: 'Line up and wait', action: 'lineUp' }]);
    this.dirty = true;
  }
  issueLanding(sim) {
    if (this.parr) this.parr.cleared = true;
    this.setATC(`${this.callsign}, runway ${this.runway}, ${this.windText(sim)}, cleared to land.`, 'TOWER',
      [{ label: 'Cleared to land, runway ' + this.runway, action: 'landingReadback' }]);
    this.dirty = true;
  }
  issueGoAround(sim, why) {
    this.parr = null;
    this.setATC(`${this.callsign}, go around, ${why}.`, 'TOWER', [{ label: 'Going around', action: 'goAroundReadback' }]);
    this.dirty = true;
  }
  trafficAdvisory(text) {
    this.logLine('TOWER', text); this.transmission = text; this.speaker = this.role === 'tower' ? 'TOWER' : this.role.toUpperCase();
    this.extras = [{ label: 'Traffic in sight', action: 'trafficInSight' }, { label: 'Looking', action: 'trafficLooking' }];
    this.dirty = true;
  }

  update(sim, dt) {
    if (!this.enabled) return;
    const F = sim.fdm;
    if (!F) return;
    if (!this.airport || !STATIONS[this.airport.icao]) {
      const n = nearestAirport(F.pos);
      if (n.distance < 30 * NM) this.airport = n.airport;
    }
    const nearest = nearestAirport(F.pos);
    if (!F.onGround && nearest.distance < 5 * NM && this.stage !== 'approach' && this.stage !== 'landed' && this.stage !== 'airborne' && !this.parr) {
      if (!this.patternReminder && F.agl / FT > 300) {
        this.patternReminder = true;
        this.setATC(`${this.callsign}, report your position and intentions before entering the pattern.`, 'TOWER',
          [{ label: 'Request landing', action: 'towerLanding' }]);
      }
    }
    this.timer += dt;
  }

  get status() {
    const traffic = this.trafficEnabled ? ' · AI TRAFFIC ON' : ' · AI TRAFFIC OFF';
    return `${this.airport.icao} · ${this.role.toUpperCase()} · ${f2(this.frequency)} MHz${this.enabled ? traffic : ' · ATC OFF'}`;
  }
}
