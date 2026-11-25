// Local-first storage (localStorage). Patients are keyed by anonymised IDs; there is no name field anywhere.
import { nowIso, newPatientId } from './util.js';
const KEY = 'mamaguard.v1';
let mem = { patients: {} };          // in-memory fallback when storage is blocked
let persistent = true;

export function load() {
  try { const s = localStorage.getItem(KEY); if (s) mem = JSON.parse(s); persistent = true; }
  catch { persistent = false; }
  if (!mem.patients) mem.patients = {};
  return mem;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); persistent = true; } catch { persistent = false; } }
export const isPersistent = () => persistent;
export const patients = () => Object.values(mem.patients).sort((a, b) => b.createdTs.localeCompare(a.createdTs));
export const getPatient = id => mem.patients[id] || null;

export function createPatient({ age, consentGiven, synthetic = false }) {
  if (!consentGiven) throw new Error('Patient consent is required.');
  const id = newPatientId(Object.keys(mem.patients));
  const ts = nowIso();
  mem.patients[id] = { id, age, createdTs: ts, consent: { given: true, ts, text: 'Patient agreed to local, anonymised storage of vitals for this antenatal check-up.', synthetic }, visits: [] };
  save(); return mem.patients[id];
}
export function addVisit(id, visit) {
  const p = mem.patients[id];
  if (!p?.consent?.given) throw new Error('No recorded consent for this patient: visit not saved.');
  p.visits.push(visit); save(); return visit;
}
export function deletePatient(id) { delete mem.patients[id]; save(); }
export function deleteAll() { mem = { patients: {} }; try { localStorage.removeItem(KEY); } catch {} }
