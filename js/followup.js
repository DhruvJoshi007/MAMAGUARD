// Follow-up scheduler: suggests the next visit by risk level and flags missed visits.
// The interval is a planning aid (the health worker decides), not a clinical order. No names are used anywhere.
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// risk: the assessment object ({levelName, provisional, trend:{alert}}); weeks: gestational age (optional)
export function suggest(risk, weeks, now = new Date()) {
  let days, why, args = {};
  if (!risk) { days = 7; why = 'fu_why_mid'; }
  else if (risk.levelName === 'High') { days = 2; why = 'fu_why_high'; }
  else if (risk.trend?.alert) { days = 3; why = 'fu_why_trend'; }
  else if (risk.levelName === 'Mid' || risk.provisional) { days = 7; why = 'fu_why_mid'; }   // missing data is never treated as routine
  else { days = weeks >= 36 ? 7 : weeks >= 28 ? 14 : 28; why = 'fu_why_low'; args = { d: days }; }
  return { days, why, args, date: ymd(new Date(sod(now).getTime() + days * DAY)), level: risk?.levelName || 'Mid' };
}
// days until due (negative = overdue)
export const daysUntil = (due, now = new Date()) => Math.round((parseYmd(due) - sod(now)) / DAY);
export function dueState(due, now = new Date()) { const d = daysUntil(due, now); return { days: d, state: d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 2 ? 'soon' : 'later' }; }

// iCalendar file (works offline, in any phone calendar; carries two alarms)
export function ics(pid, due, level) {
  const d = due.replace(/-/g, ''), stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MamaGuard//Follow-up//EN', 'BEGIN:VEVENT', `UID:${pid}-${d}@mamaguard`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`,
    `SUMMARY:MamaGuard follow-up visit (${pid}, ${level} risk)`, 'DESCRIPTION:Antenatal follow-up. Patient ID only; no personal data.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Follow-up visit tomorrow', 'TRIGGER:-P1D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Follow-up visit today', 'TRIGGER:PT9H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
