// Step 3 of the start screen (after edition and aircraft): the flight plan and the state the aircraft
// starts in. Shared by every simulator page; the page's main module reads the choice with
// window.FlightSetup.get(). Classic script (no module) so it works before the simulator has loaded.
(function () {
  // [icao, name, size L/M/S, towered, [[runway, length ft, ILS 0/1, true heading], ...]] — from data/airports.json
  const AIRPORTS = [["KSFO","San Francisco Intl","L",1,[["10L",11870,0,118],["28R",11870,1,298],["10R",11381,0,118],["28L",11381,1,298],["1L",7649,0,28],["19R",7649,0,208],["1R",8652,0,28],["19L",8652,1,208]]],["KOAK","Oakland San Francisco Bay","L",1,[["10L",5457,0,112],["28R",5457,1,292],["10R",6235,0,112],["28L",6235,0,292],["12",10520,1,130],["30",10520,1,310],["15",3355,0,165],["33",3355,0,345]]],["KSJC","Mineta San Jose Intl","L",1,[["12L",11006,0,138],["30R",11006,0,318],["12R",11005,1,138],["30L",11005,1,318]]],["KNUQ","Moffett Federal Airfield","M",1,[["14L",9207,0,158],["32R",9207,1,338],["14R",8121,0,158],["32L",8121,0,338]]],["KHWD","Hayward Executive","S",1,[["10L",3108,0,120],["28R",3108,0,300],["10R",5663,0,120],["28L",5663,1,300]]],["KSQL","San Carlos","S",1,[["12",2613,0,138],["30",2613,0,318]]],["KPAO","Palo Alto","S",1,[["13",2441,0,142],["31",2441,0,322]]],["KLVK","Livermore Municipal","S",1,[["07L",5210,0,90],["25R",5210,1,270],["07R",2699,0,90],["25L",2699,0,270]]],["KCCR","Buchanan Field","S",1,[["01L",4979,0,24],["19R",4979,1,204],["01R",2770,0,23],["19L",2770,0,203],["14L",4582,0,154],["32R",4582,0,334],["14R",2798,0,153],["32L",2798,0,333]]],["KAPC","Napa County","S",1,[["01L",5925,1,21],["19R",5925,0,201],["01R",2519,0,21],["19L",2519,0,201],["6",5008,0,77],["24",5008,0,257]]],["KRHV","Reid-Hillview of Santa Clara County","S",1,[["13L",3100,0,143],["31R",3100,0,323],["13R",3099,0,143],["31L",3099,0,323]]],["KO69","Petaluma Municipal","S",0,[["11",3565,0,126],["29",3565,0,306]]],["KHAF","Half Moon Bay","S",0,[["12",5064,0,137],["30",5064,0,317]]],["KDVO","Marin County - Gnoss Field","S",0,[["13",3322,0,149],["31",3322,0,329]]]];
  const VORS = [['CCR', 'Concord'], ['OAK', 'Oakland'], ['OSI', 'Woodside'], ['SAU', 'Sausalito'], ['SFO', 'San Francisco'], ['SGD', 'Scaggs Island'], ['SJC', 'San Jose'], ['TZZ', 'Travis']];
  const PROFILES = {
    C172: { minRwy: 1800, airports: null, dep: 'KSFO', dest: 'KHAF', crz: [1500, 12500, 500, 4500], route: '', unit: 'ft' },
    C152: { minRwy: 1800, airports: null, dep: 'KSFO', dest: 'KHAF', crz: [1500, 12500, 500, 3500], route: '', unit: 'ft' },
    A350: { minRwy: 7000, airports: ['KSFO', 'KOAK', 'KSJC'], dep: 'KSFO', dest: 'KSJC', crz: [6000, 41000, 1000, 12000], route: '', unit: 'FL' },
  };
  const STATES = [
    ['cold', 'Cold & dark', 'Parked, everything switched off'],
    ['running', 'Engines running', 'Parked with the engine(s) started — call Ground yourself'],
    ['taxi', 'Ready to taxi', 'Checklists done, taxi clearance received'],
    ['runway', 'On the runway', 'Lined up on the departure runway'],
    ['air', 'In the air', 'Climbing out, en route or on final'],
  ];
  const AIRPOS = [['climb', 'Climbing out after takeoff'], ['cruise', 'En route at cruise altitude'], ['final', 'On final approach at the destination']];
  const $ = (id) => document.getElementById(id);
  const KEY = (ac) => 'flightsetup.' + ac;
  let ac = 'C172', P = PROFILES.C172, onGo = null, state = 'cold';

  const el = (tag, props = {}, kids = []) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of [].concat(kids)) e.append(k); return e; };
  const apt = (icao) => AIRPORTS.find((a) => a[0] === icao);
  const okAirports = () => AIRPORTS.filter((a) => (!P.airports || P.airports.includes(a[0])) && a[4].some((r) => r[1] >= P.minRwy));
  const fmtAlt = (ft) => (P.unit === 'FL' && ft >= 18000 ? 'FL' + String(Math.round(ft / 100)).padStart(3, '0') : (+ft).toLocaleString('en-US') + ' ft');

  function fillRunways(sel, icao, kind) {
    const a = apt(icao), keep = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: kind === 'dep' ? 'Auto — runway in use (wind)' : 'Auto — landing runway in use (wind)' }));
    for (const r of a ? a[4] : []) if (r[1] >= P.minRwy) sel.append(el('option', { value: r[0], textContent: `Runway ${r[0]} · ${r[1].toLocaleString('en-US')} ft${r[2] ? ' · ILS' : ''}` }));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  function build() {
    const host = $('flightStep'); if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    const panel = el('div', { id: 'fpPanel', className: 'fpPanel' });
    const grid = el('div', { className: 'grid fpGrid' });
    const L = (text, input) => el('label', {}, [text, input]);
    const dep = el('select', { id: 'fpDep' }), depR = el('select', { id: 'fpDepRwy' }), dest = el('select', { id: 'fpDest' }), arrR = el('select', { id: 'fpArrRwy' });
    const route = el('input', { id: 'fpRoute', type: 'text', placeholder: 'Direct (or e.g. OSI SJC)', autocomplete: 'off', spellcheck: false });
    route.setAttribute('list', 'fpWpts');
    const wl = el('datalist', { id: 'fpWpts' }, [...VORS.map(([i, n]) => el('option', { value: i, label: n + ' VOR' })), ...AIRPORTS.map((a) => el('option', { value: a[0], label: a[1] }))]);
    const crz = el('input', { id: 'fpCrz', type: 'range' }), crzOut = el('output', { id: 'fpCrzOut' });
    grid.append(L('From', dep), L('Departure runway', depR), el('label', {}, ['Cruise altitude ', crzOut, crz]), L('To', dest), L('Arrival runway', arrR), L('Route', route), wl);
    const st = el('div', { id: 'fpStates', className: 'editionActions fpStates', role: 'radiogroup' });
    for (const [id, name, desc] of STATES) {
      const b = el('button', { type: 'button', className: 'editionButton fpState' }, [el('strong', { textContent: name }), el('span', { textContent: desc })]);
      b.dataset.state = id; b.setAttribute('role', 'radio'); b.addEventListener('click', () => { state = id; sync(); }); st.append(b);
    }
    const airSel = el('select', { id: 'fpAir' }, AIRPOS.map(([v, t]) => el('option', { value: v, textContent: t })));
    const airRow = el('label', { id: 'fpAirRow', className: 'fpAirRow hidden' }, ['In-air position', airSel]);
    const sum = el('p', { id: 'fpSummary', className: 'fpSummary' });
    panel.append(el('h3', { className: 'fpTitle', textContent: 'Flight plan & start state' }), grid, el('div', { className: 'fpLabel', textContent: 'Start the aircraft' }), st, airRow, sum);
    const go = el('button', { type: 'button', className: 'primary', id: 'fpGo', textContent: 'Load simulator' });
    go.addEventListener('click', () => { save(); mount(); onGo && onGo(); });
    host.append(panel, el('div', { className: 'actions fpActions' }, [go]));
    for (const e of [dep, dest]) e.addEventListener('change', () => { fillRunways(e === dep ? depR : arrR, e.value, e === dep ? 'dep' : 'arr'); sync(); });
    for (const e of [depR, arrR, route, crz, airSel]) e.addEventListener('input', sync);
    for (const e of [depR, arrR, airSel]) e.addEventListener('change', sync);
  }
  function configure() {
    const dep = $('fpDep'), dest = $('fpDest'), crz = $('fpCrz');
    const list = okAirports();
    for (const s of [dep, dest]) s.replaceChildren(...list.map((a) => el('option', { value: a[0], textContent: `${a[0]} ${a[1]}` })));
    const [lo, hi, step, def] = P.crz; Object.assign(crz, { min: lo, max: hi, step });
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY(ac)) || 'null'); } catch (e) { saved = null; }
    const has = (s, v) => [...s.options].some((o) => o.value === v);
    dep.value = saved && has(dep, saved.dep) ? saved.dep : P.dep; dest.value = saved && has(dest, saved.dest) ? saved.dest : P.dest;
    fillRunways($('fpDepRwy'), dep.value, 'dep'); fillRunways($('fpArrRwy'), dest.value, 'arr');
    if (saved) { $('fpDepRwy').value = has($('fpDepRwy'), saved.depRwy) ? saved.depRwy : ''; $('fpArrRwy').value = has($('fpArrRwy'), saved.arrRwy) ? saved.arrRwy : ''; }
    $('fpRoute').value = saved?.routeText ?? P.route;
    crz.value = String(saved?.crzFt && saved.crzFt >= lo && saved.crzFt <= hi ? saved.crzFt : def);
    state = saved?.state && STATES.some((s) => s[0] === saved.state) ? saved.state : 'cold';
    $('fpAir').value = saved?.air || 'climb';
    sync();
  }
  function parseRoute(text) {
    const ok = [], bad = [];
    for (const t of String(text || '').toUpperCase().split(/[\s,]+/).filter(Boolean)) {
      if (t === 'DCT' || t === 'DIRECT') continue;
      const id = VORS.some((v) => v[0] === t) ? t : apt(t) ? t : apt('K' + t) ? 'K' + t : null;
      if (id) ok.push(id); else bad.push(t);
    }
    return { ok, bad };
  }
  function get() {
    if (!$('fpDep')) return null;
    const r = parseRoute($('fpRoute').value);
    return { aircraft: ac, dep: $('fpDep').value, depRwy: $('fpDepRwy').value, dest: $('fpDest').value, arrRwy: $('fpArrRwy').value, route: r.ok, routeText: $('fpRoute').value, crzFt: +$('fpCrz').value, state, air: $('fpAir').value };
  }
  function save() { try { const g = get(); if (g) localStorage.setItem(KEY(ac), JSON.stringify(g)); } catch (e) { /* private mode */ } }
  function sync() {
    for (const b of document.querySelectorAll('.fpState')) { const on = b.dataset.state === state; b.classList.toggle('selected', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
    $('fpAirRow').classList.toggle('hidden', state !== 'air');
    $('fpCrzOut').textContent = fmtAlt(+$('fpCrz').value);
    const g = get(), r = parseRoute(g.routeText);
    const where = { cold: 'parked cold & dark at ' + g.dep, running: 'parked at ' + g.dep + ' with the engine' + (ac === 'A350' ? 's' : '') + ' running', taxi: 'at ' + g.dep + ', ready to taxi to runway ' + (g.depRwy || 'in use'), runway: 'lined up on ' + g.dep + ' runway ' + (g.depRwy || 'in use'), air: { climb: 'climbing out of ' + g.dep, cruise: 'en route at ' + fmtAlt(g.crzFt), final: 'on final for ' + g.dest + ' runway ' + (g.arrRwy || 'in use') }[g.air] }[state];
    $('fpSummary').textContent = `${g.dep}${g.depRwy ? ' (' + g.depRwy + ')' : ''} → ${r.ok.length ? r.ok.join(' → ') + ' → ' : ''}${g.dest}${g.arrRwy ? ' (' + g.arrRwy + ')' : ''} at ${fmtAlt(g.crzFt)} · start ${where}.${r.bad.length ? ' Unknown waypoint' + (r.bad.length > 1 ? 's' : '') + ' ignored: ' + r.bad.join(', ') + '.' : ''}`;
    save();
  }
  // after the simulator loads, the same panel sits at the top of the settings form so it can be changed before Fly
  function mount() {
    const p = $('fpPanel'), form = $('setup'); if (!p || !form || p.parentElement === form) return;
    form.prepend(p); p.classList.add('mounted');
  }
  function show(aircraft, edition, go) {
    ac = PROFILES[aircraft] ? aircraft : 'C172'; P = PROFILES[ac]; onGo = go;
    build(); configure();
    const step = $('flightStep');
    for (const id of ['editionStep', 'aircraftStep']) $(id)?.classList.add('hidden');
    step.classList.remove('hidden');
    const tag = $('fpTag'); if (tag) tag.textContent = (edition === 'heavy' ? 'Heavy Edition' : 'Light Edition') + ' · ' + ({ C172: 'Cessna 172S', C152: 'Cessna 152', A350: 'Airbus A350-1000' }[ac]);
  }
  window.FlightSetup = { show, get, mount, airports: AIRPORTS, vors: VORS };
})();
