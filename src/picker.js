// Start screen flow shared by every simulator page: step 1 picks the edition (Light / Heavy),
// step 2 picks the aircraft. Aircraft that live on another page are opened there with the
// chosen edition in the URL, and that page starts loading straight away.
(function () {
  const AIRCRAFT = [
    { id: 'C172', page: 'skyhawk.html', name: 'Cessna 172S Skyhawk', desc: '180 hp four-seat trainer · steam gauges' },
    { id: 'C152', page: 'skyhawk.html', name: 'Cessna 152 Aerobat', desc: '110 hp two-seat trainer · lighter, livelier' },
    { id: 'A350', page: 'a350.html', name: 'Airbus A350-1000', desc: 'Twin-engine widebody · Trent XWB-97 · full fly-by-wire flight deck' },
  ];
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const $ = (id) => document.getElementById(id);
  let edition = null;

  function showStep(n) {
    const s1 = $('editionStep'), s2 = $('aircraftStep'), s3 = $('flightStep');
    if (s1) s1.classList.toggle('hidden', n !== 1);
    if (s2) s2.classList.toggle('hidden', n !== 2);
    if (s3) s3.classList.toggle('hidden', n !== 3);
    const tag = $('editionTag'); if (tag) tag.textContent = edition === 'heavy' ? 'Heavy Edition' : 'Light Edition';
  }
  window.pickEdition = function (mode) { edition = mode === 'heavy' ? 'heavy' : 'light'; showStep(2); };
  window.pickBack = function (n) { showStep(n === 2 ? 2 : 1); };
  window.pickAircraft = function (id) {
    const a = AIRCRAFT.find((x) => x.id === id); if (!a || !edition) return;
    if (a.page !== here) { location.href = `./${a.page}?edition=${edition}&aircraft=${a.id}`; return; }
    const sel = $('aircraftType');
    if (sel && [...sel.options].some((o) => o.value === id)) { sel.value = id; sel.dispatchEvent(new Event('change')); }
    const go = () => { if (typeof window.startEdition === 'function') window.startEdition(edition); };
    // step 3: flight plan and start state (cold & dark ... in the air), then load
    if (window.FlightSetup && $('flightStep')) window.FlightSetup.show(id, edition, go); else go();
  };

  function build() {
    const list = $('aircraftList'); if (!list) return;
    list.replaceChildren(...AIRCRAFT.map((a) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'editionButton aircraftButton'; b.dataset.aircraft = a.id;
      const s = document.createElement('strong'); s.textContent = a.name; const d = document.createElement('span'); d.textContent = a.desc;
      b.append(s, d); b.addEventListener('click', () => window.pickAircraft(a.id)); return b;
    }));
    showStep(1);
    // arriving from another page's picker: start at once with the chosen edition and aircraft
    const q = new URLSearchParams(location.search); const ed = q.get('edition'), ac = q.get('aircraft');
    if ((ed === 'light' || ed === 'heavy') && AIRCRAFT.some((a) => a.id === ac && a.page === here)) {
      edition = ed; history.replaceState(null, '', location.pathname);
      setTimeout(() => window.pickAircraft(ac), 0);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
