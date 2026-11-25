// Local-first storage (localStorage). Patients are keyed by anonymised IDs; there is no name field anywhere.
import { nowIso, newPatientId } from './util.js';
const KEY = 'mamaguard.v1';
let mem = { patients: {}, log: [] };          // in-memory fallback when storage is blocked
let persistent = true;

export function load() {
  try { const s = localStorage.getItem(KEY); if (s) mem = JSON.parse(s); persistent = true; }
  catch { persistent = false; }
  if (!mem.patients) mem.patients = {};
  if (!mem.log) mem.log = [];
  return mem;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); persistent = true; } catch { persistent = false; } }
export const isPersistent = () => persistent;
export const patients = () => Object.values(mem.patients).sort((a, b) => b.createdTs.localeCompare(a.createdTs));
export const getPatient = id => mem.patients[id] || null;

export const logs = () => mem.log.slice().reverse();
export function addLog(type, pid, text) { mem.log.push({ ts: nowIso(), type, pid, text }); if (mem.log.length > 500) mem.log.splice(0, mem.log.length - 500); save(); }
export const lastPid = () => (mem.lastPid && mem.patients[mem.lastPid] ? mem.lastPid : null);
export function setLast(pid) { mem.lastPid = pid; save(); }
export function createPatient({ age, consentGiven, synthetic = false }) {
  if (!consentGiven) throw new Error('Patient consent is required.');
  const id = newPatientId(Object.keys(mem.patients));
  const ts = nowIso();
  mem.patients[id] = { id, age, createdTs: ts, consent: { given: true, ts, text: 'Patient agreed to local, anonymised storage of vitals for this antenatal check-up.', synthetic }, visits: [] };
  mem.log.push({ ts, type: 'patient', pid: id, text: `Patient ${id} created (age ${age}), consent recorded` }); save(); return mem.patients[id];
}
export function addVisit(id, visit) {
  const p = mem.patients[id];
  if (!p?.consent?.given) throw new Error('No recorded consent for this patient: visit not saved.');
  p.visits.push(visit); save(); return visit;
}
export function deletePatient(id) { delete mem.patients[id]; mem.log = mem.log.filter(l => l.pid !== id); if (mem.lastPid === id) mem.lastPid = null; save(); }
export function deleteAll() { mem = { patients: {}, log: [] }; try { localStorage.removeItem(KEY); } catch {} }
