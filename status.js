// WebEaze shared support status logic
// Used by portal.html (detailed) and status.html (simple)

// Supports ?preview= for testing holiday states on any page
var _PREVIEW_DATES = {
  today:  '2026-05-25T12:00:00',
  soon:   '2026-05-21T12:00:00',
  coming: '2026-05-07T12:00:00',
  past:   '2026-05-26T12:00:00',
};
var _previewKey = new URLSearchParams(window.location.search).get('preview');
function getET() {
  if (_previewKey && _PREVIEW_DATES[_previewKey]) return new Date(_PREVIEW_DATES[_previewKey]);
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getClosures() {
  return [
    { name: "New Year's Day",      start: '2026-01-01', end: '2026-01-01' },
    { name: 'Memorial Day',        start: '2026-05-25', end: '2026-05-25' },
    { name: 'Independence Day',    start: '2026-07-03', end: '2026-07-03' },
    { name: 'Labor Day',           start: '2026-09-07', end: '2026-09-07' },
    { name: 'Thanksgiving',        start: '2026-11-25', end: '2026-11-29' },
    { name: 'December Holidays',   start: '2026-12-24', end: '2027-01-01' },
    { name: "New Year's Day",      start: '2027-01-01', end: '2027-01-01' },
    { name: 'Memorial Day',        start: '2027-05-31', end: '2027-05-31' },
    { name: 'Independence Day',    start: '2027-07-05', end: '2027-07-05' },
    { name: 'Labor Day',           start: '2027-09-06', end: '2027-09-06' },
    { name: 'Thanksgiving',        start: '2027-11-24', end: '2027-11-28' },
    { name: 'December Holidays',   start: '2027-12-24', end: '2028-01-01' },
    { name: "New Year's Day",      start: '2028-01-01', end: '2028-01-01' },
    { name: 'Memorial Day',        start: '2028-05-29', end: '2028-05-29' },
    { name: 'Independence Day',    start: '2028-07-04', end: '2028-07-04' },
    { name: 'Labor Day',           start: '2028-09-04', end: '2028-09-04' },
    { name: 'Thanksgiving',        start: '2028-11-22', end: '2028-11-26' },
    { name: 'December Holidays',   start: '2028-12-24', end: '2029-01-01' },
    { name: "New Year's Day",      start: '2029-01-01', end: '2029-01-01' },
    { name: 'Memorial Day',        start: '2029-05-28', end: '2029-05-28' },
    { name: 'Independence Day',    start: '2029-07-04', end: '2029-07-04' },
    { name: 'Labor Day',           start: '2029-09-03', end: '2029-09-03' },
    { name: 'Thanksgiving',        start: '2029-11-21', end: '2029-11-25' },
    { name: 'December Holidays',   start: '2029-12-24', end: '2030-01-01' },
    { name: "New Year's Day",      start: '2030-01-01', end: '2030-01-01' },
    { name: 'Memorial Day',        start: '2030-05-27', end: '2030-05-27' },
    { name: 'Independence Day',    start: '2030-07-04', end: '2030-07-04' },
    { name: 'Labor Day',           start: '2030-09-02', end: '2030-09-02' },
    { name: 'Thanksgiving',        start: '2030-11-27', end: '2030-12-01' },
    { name: 'December Holidays',   start: '2030-12-24', end: '2031-01-01' },
    { name: "New Year's Day",      start: '2031-01-01', end: '2031-01-01' }
  ].map(function(c) {
    return {
      name: c.name,
      start: new Date(c.start + 'T00:00:00'),
      end:   new Date(c.end   + 'T23:59:59')
    };
  });
}

function nextBusinessDay(et) {
  const cls = getClosures();
  let d = new Date(et); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !cls.some(c => d >= c.start && d <= c.end)) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function nextOpenLabel(et) {
  const nbd = nextBusinessDay(et);
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  if (et.getDay() === 0) {
    const t = new Date(et); t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0);
    if (nbd.toDateString() === t.toDateString()) return 'tomorrow';
  }
  return DAYS[nbd.getDay()];
}

// Returns the current support state so each page can render it its own way
// { state: 'open' | 'away' | 'closed' | 'holiday', message: '...', holidayName: '...' }
function getSupportStatus(detailed) {
  const now = getET(), day = now.getDay(), hour = now.getHours();
  const holiday = getClosures().find(c => now >= c.start && now <= c.end);
  const next = nextOpenLabel(now);

  if (holiday) {
    return {
      state: 'holiday',
      holidayName: holiday.name,
      message: detailed
        ? 'Closed for ' + holiday.name + '. Back ' + next + ' at 9am ET'
        : 'Currently closed. Back ' + next + ' at 9am ET'
    };
  }
  if (day === 0 || day === 6) {
    return { state: 'closed', message: 'Support is back ' + next + ' at 9am ET' };
  }
  if (hour >= 9 && hour < 17) {
    return { state: 'open', message: 'Support is available now' };
  }
  return { state: 'away', message: 'Support is back ' + (hour < 9 ? 'today' : next) + ' at 9am ET' };
}