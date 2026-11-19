import { AIRPORTS } from './geo.js';

const FT = 0.3048;
const NM = 1852;

const STATIONS = {
  KSFO: { ground: 121.8, tower: 120.5, approach: 134.5, class: 'Class B', runways: ['28L', '28R'] },
  KOAK: { ground: 121.75, tower: 118.3, approach: 125.35, class: 'Class C', runways: ['30', '12'] },
  KSJC: { ground: 121.9, tower: 124.0, approach: 127.0, class: 'Class C', runways: ['30L', '30R'] },
  KHWD: { ground: 121.4, tower: 120.2, approach: 125.35, class: 'Class D', runways: ['28L', '10R'] },
  KSQL: { ground: 119.0, tower: 119.0, approach: 134.5, class: 'Class D', runways: ['30', '12'] },
  KLVK: { ground: 125.1, tower: 118.1, approach: 125.35, class: 'Class D', runways: ['25R', '07L'] },
  KCCR: { ground: 121.65, tower: 119.6, approach: 125.35, class: 'Class D', runways: ['32L', '14R'] },
};

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
  const station = STATIONS[airport.icao];
  if (station?.runways?.length) {
    const reciprocal = ((heading + 180) % 360);
    return (Math.abs(((heading - airport.hdg + 540) % 360) - 180) < 90)
      ? station.runways[0]
      : station.runways[1] || station.runways[0];
  }
  return 'runway';
}

export class ATC {
  constructor() {
    this.enabled = true;
    this.trafficEnabled = true;
    this.traffic = [];
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
    this.timer = 0;
    this.messageId = 0;
    this.trafficTimer = 8;
    this.trafficEnabled = setup?.aiTraffic !== false;
    this.traffic = [
      { callsign: 'United 482', type: 'A320', position: 'northwest', altitude: 3500, heading: 105, report: 'leaving 4,500 for 3,500' },
      { callsign: 'Alaska 217', type: 'B739', position: 'south', altitude: 5200, heading: 320, report: 'turning final, runway 28L' },
      { callsign: 'N194SP', type: 'C172', position: 'east', altitude: 1800, heading: 275, report: 'entering the left downwind' },
    ];
    this.initFromSetup(setup);
  }

  initFromSetup(setup) {
    const airportCode = ({ SFO28: 'KSFO', SFOramp: 'KSFO', OAK12: 'KOAK', SJC30: 'KSJC', HWD28: 'KHWD', SQL30: 'KSQL', LVK25: 'KLVK', CCR32: 'KCCR', ILS28: 'KSFO' }[setup.spawn]) || 'KSFO';
    this.airport = AIRPORTS.find((a) => a.icao === airportCode) || this.airport;
    const station = STATIONS[this.airport.icao] || { ground: 121.9, tower: 118.0, approach: 125.35 };
    this.runway = runwayName(this.airport, this.airport.hdg);

    if (setup.spawn === 'SFOramp') {
      this.role = 'ground';
      this.frequency = station.ground;
      this.stage = 'ramp';
      this.transmission = `${this.airport.icao} Ground, ${this.callsign}, North Ramp, requesting taxi for VFR departure.`;
      this.speaker = 'YOU';
      this.options = [
        { label: 'Request taxi', action: 'requestTaxi' },
        { label: 'Request flight following', action: 'requestFollowing' },
      ];
    } else if (setup.spawn === 'ILS28') {
      this.role = 'approach';
      this.frequency = station.approach;
      this.stage = 'approach';
      this.transmission = `${this.callsign}, 8 miles from ${this.runway}, inbound for ILS.`;
      this.speaker = 'YOU';
      this.options = [
        { label: 'Contact approach', action: 'contactApproach' },
        { label: 'Request missed approach?', action: 'requestMissedBrief' },
      ];
    } else {
      this.role = 'tower';
      this.frequency = station.tower;
      this.stage = 'departurePosition';
      this.setATC(`${this.airport.icao} Tower, ${this.callsign}, runway ${this.runway}, ready for departure.`, 'YOU',
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

  logLine(speaker, text) {
    this.log.unshift({ id: ++this.messageId, speaker, text });
    this.log = this.log.slice(0, 8);
  }

  setFrequency(sim, frequency) {
    sim.av.com1.active = frequency;
  }

  readback(text) {
    this.logLine('YOU', text);
  }

  act(action, sim) {
    if (!this.enabled) {
      this.setATC('ATC communications are disabled. Enable Realistic ATC communications in setup.', 'RADIO', []);
      return;
    }
    const station = STATIONS[this.airport.icao] || { ground: 121.9, tower: 118.0, approach: 125.35 };
    const runway = this.runway;
    const active = Math.round(sim.av.com1.active * 100) / 100;
    if (action !== 'requestFollowing' && action !== 'requestMissedBrief' && Math.abs(active - this.frequency) > 0.001) {
      this.setATC(`Tune COM 1 to ${this.frequency.toFixed(2)} MHz before transmitting on this frequency.`, 'RADIO',
        this.options);
      return;
    }

    switch (action) {
      case 'requestTaxi':
        this.readback(`${this.callsign}, North Ramp, taxi.`);
        this.role = 'ground'; this.frequency = station.ground; this.setFrequency(sim, station.ground);
        this.stage = 'taxi';
        this.setATC(`${this.callsign}, ${this.airport.icao} Ground, taxi to runway ${runway} via Alpha, hold short of runway ${runway}.`, 'GROUND',
          [{ label: 'Read back taxi clearance', action: 'ackTaxi' }, { label: 'Request progressive taxi', action: 'progressiveTaxi' }]);
        break;
      case 'ackTaxi':
        this.readback(`Taxi via Alpha, hold short runway ${runway}, ${this.callsign}.`);
        this.setATC(`Readback correct. Contact Tower at ${station.tower.toFixed(2)} when ready.`, 'GROUND',
          [{ label: 'Contact Tower', action: 'contactTower' }]);
        break;
      case 'progressiveTaxi':
        this.setATC(`${this.callsign}, continue taxi via Alpha, left on Taxiway Bravo, hold short of runway ${runway}.`, 'GROUND',
          [{ label: 'Read back progressive taxi', action: 'ackTaxi' }]);
        break;
      case 'contactTower':
        this.role = 'tower'; this.frequency = station.tower; this.setFrequency(sim, station.tower);
        this.stage = 'towerReady';
        this.setATC(`${this.callsign}, ${this.airport.icao} Tower, runway ${runway}, hold short.`, 'TOWER',
          [{ label: 'Hold short, runway ' + runway, action: 'holdShort' }]);
        break;
      case 'readyDeparture':
        this.role = 'tower'; this.frequency = station.tower; this.setFrequency(sim, station.tower);
        this.readback(`${this.callsign}, runway ${runway}, ready for departure.`);
        this.stage = 'towerReady';
        this.setATC(`${this.callsign}, runway ${runway}, line up and wait.`, 'TOWER',
          [{ label: 'Line up and wait', action: 'lineUp' }]);
        break;
      case 'holdShort':
      case 'lineUp':
        this.readback(action === 'holdShort'
          ? `Holding short runway ${runway}, ${this.callsign}.`
          : `Runway ${runway}, line up and wait, ${this.callsign}.`);
        this.stage = 'lineUp';
        this.setATC(`${this.callsign}, runway ${runway}, cleared for takeoff. Wind ${this.windText(sim)}, traffic in vicinity.`, 'TOWER',
          [{ label: 'Cleared for takeoff, runway ' + runway, action: 'takeoffReadback' }]);
        break;
      case 'takeoffReadback':
        this.readback(`Cleared for takeoff runway ${runway}, ${this.callsign}.`);
        this.stage = 'airborne';
        this.setATC(`${this.callsign}, departure approved. Fly runway heading, climb and maintain 3,000.`, 'TOWER',
          [{ label: 'Departure readback', action: 'departureReadback' }]);
        break;
      case 'departureReadback':
        this.readback(`Fly runway heading, climb and maintain 3,000, ${this.callsign}.`);
        this.role = 'departure'; this.frequency = station.approach;
        this.setATC(`${this.callsign}, contact Departure at ${station.approach.toFixed(2)}.`, 'TOWER',
          [{ label: 'Contact Departure', action: 'contactDeparture' }]);
        break;
      case 'contactDeparture':
      case 'requestFollowing':
        this.role = 'departure'; this.frequency = station.approach; this.setFrequency(sim, station.approach);
        this.setATC(`${this.callsign}, ${station.class} radar contact. Identified, squawk 1200.`, 'DEPARTURE',
          [{ label: 'Roger, radar contact', action: 'radarReadback' }]);
        break;
      case 'radarReadback':
        this.readback(`Squawk 1200, ${this.callsign}.`);
        sim.av.xpdr.code = '1200';
        this.setATC(`${this.callsign}, maintain 3,500, proceed on course.`, 'DEPARTURE',
          [{ label: 'Maintain 3,500', action: 'maintainAltitude' }]);
        break;
      case 'maintainAltitude':
        this.readback(`Maintain 3,500, ${this.callsign}.`);
        this.setATC(`${this.callsign}, no delay expected. Frequency change approved.`, 'DEPARTURE',
          [{ label: 'Frequency change approved', action: 'enroute' }]);
        break;
      case 'enroute':
        this.role = 'monitor';
        this.setATC(`${this.callsign}, monitoring. Remain outside controlled airspace unless cleared.`, 'ATC',
          [{ label: 'Copy', action: 'copyOnly' }]);
        break;
      case 'contactApproach':
        this.role = 'approach'; this.frequency = station.approach; this.setFrequency(sim, station.approach);
        this.setATC(`${this.callsign}, ${station.class} radar contact 8 miles, cleared for the ILS runway ${runway}, maintain 3,000 until established.`, 'APPROACH',
          [{ label: 'Read back ILS clearance', action: 'ackApproach' }]);
        break;
      case 'ackApproach':
        this.readback(`Cleared ILS runway ${runway}, maintain 3,000 until established, ${this.callsign}.`);
        this.role = 'tower'; this.frequency = station.tower;
        this.setATC(`${this.callsign}, approach has cleared you, switch to Tower at ${station.tower.toFixed(2)}.`, 'APPROACH',
          [{ label: 'Switch to Tower', action: 'towerLanding' }]);
        break;
      case 'towerLanding':
        this.setFrequency(sim, station.tower);
        this.setATC(`${this.callsign}, ${station.class} Tower, runway ${runway}, clear to land.`, 'TOWER',
          [{ label: 'Cleared to land, runway ' + runway, action: 'landingReadback' }]);
        break;
      case 'landingReadback':
        this.readback(`Cleared to land runway ${runway}, ${this.callsign}.`);
        this.stage = 'landed';
        this.setATC(`${this.callsign}, left after landing, vacate at next taxiway, contact Ground.`, 'TOWER',
          [{ label: 'Vacated runway', action: 'contactGroundAfterLanding' }]);
        break;
      case 'contactGroundAfterLanding':
        this.role = 'ground'; this.frequency = station.ground; this.setFrequency(sim, station.ground);
        this.setATC(`${this.callsign}, Ground, taxi to parking via Alpha, squawk standby.`, 'GROUND',
          [{ label: 'Taxi to parking', action: 'taxiParking' }]);
        break;
      case 'taxiParking':
        this.readback(`Taxi to parking via Alpha, squawk standby, ${this.callsign}.`);
        this.setATC(`${this.callsign}, readback correct. Welcome back.`, 'GROUND', []);
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

  windText(sim) {
    const w = sim.weather || { windDir: 250, windKt: 8 };
    return `${String(Math.round(w.windDir)).padStart(3, '0')} degrees at ${Math.round(w.windKt)} knots`;
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
    if (!F.onGround && nearest.distance < 5 * NM && this.stage !== 'approach' && this.stage !== 'landed') {
      // A short automatic reminder while the aircraft is in the pattern.
      if (!this.patternReminder && F.agl / FT > 300) {
        this.patternReminder = true;
        this.setATC(`${this.callsign}, report your position and intentions before entering the pattern.`, 'TOWER',
          [{ label: 'Request VFR flight following', action: 'requestFollowing' }]);
      }
    }

    this.timer += dt;
    if (this.trafficEnabled) {
      this.trafficTimer -= dt;
      if (this.trafficTimer <= 0) {
        this.trafficTimer = 35 + Math.floor(Math.random() * 20);
        const traffic = this.traffic[Math.floor(Math.random() * this.traffic.length)];
        this.logLine('ATC', `${traffic.callsign}, ${this.airport.icao}, ${traffic.position} at ${traffic.altitude.toLocaleString()} feet, ${traffic.report}.`);
        if (Math.random() < 0.35) this.setATC(`${traffic.callsign}, report in sight if able. Maintain visual separation.`, 'TOWER',
          this.options);
      }
    }
  }

  get status() {
    const traffic = this.trafficEnabled ? ' · AI TRAFFIC ON' : ' · AI TRAFFIC OFF';
    return `${this.airport.icao} · ${this.role.toUpperCase()} · ${this.frequency.toFixed(2)} MHz${this.enabled ? traffic : ' · ATC OFF'}`;
  }
}
