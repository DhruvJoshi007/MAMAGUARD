// Web Bluetooth: standard GATT health profiles + pure parsers (unit-tested in tests/).
// NOTE: consumer smartwatches (incl. GoBoult) normally use proprietary protocols and sync through their
// phone app, so they rarely expose these services. Sleep and stress have no standard GATT profile at all.
// That is why Simulation Mode and manual entry exist.
export const UUID = {
  hrSvc: 0x180d, hrChar: 0x2a37,
  bpSvc: 0x1810, bpChar: 0x2a35,
  tempSvc: 0x1809, tempChar: 0x2a1c,
  gluSvc: 0x1808, gluChar: 0x2a18,
  plxSvc: 0x1822, plxSpot: 0x2a5e, plxCont: 0x2a5f,
};

// IEEE-11073 16-bit SFLOAT: 4-bit exponent, 12-bit mantissa (both signed). Returns NaN for special values.
export function sfloat(u16) {
  let mant = u16 & 0x0fff, exp = (u16 >> 12) & 0x0f;
  if (mant >= 0x800) mant -= 0x1000;
  if (exp >= 0x8) exp -= 0x10;
  if (u16 === 0x07ff || u16 === 0x0800 || u16 === 0x0801 || u16 === 0x07fe || u16 === 0x0802) return NaN;
  return mant * Math.pow(10, exp);
}
// IEEE-11073 32-bit FLOAT: 8-bit exponent, 24-bit mantissa (signed)
export function float32_11073(u32) {
  let mant = u32 & 0x00ffffff, exp = (u32 >>> 24) & 0xff;
  if (mant >= 0x800000) mant -= 0x1000000;
  if (exp >= 0x80) exp -= 0x100;
  if (mant === 0x7fffff || mant === -0x800000 || mant === -0x7fffff) return NaN;
  return mant * Math.pow(10, exp);
}
const KPA_TO_MMHG = 7.50062;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return { hr: (flags & 1) ? dv.getUint16(1, true) : dv.getUint8(1) };
}
export function parseBloodPressure(dv) {
  const flags = dv.getUint8(0), k = (flags & 1) ? KPA_TO_MMHG : 1;
  return { sbp: round(sfloat(dv.getUint16(1, true)) * k, 0), dbp: round(sfloat(dv.getUint16(3, true)) * k, 0) };
}
export function parseTemperature(dv) {
  const flags = dv.getUint8(0);
  const v = float32_11073(dv.getUint32(1, true));
  return { temp: round((flags & 1) ? (v - 32) * 5 / 9 : v, 1) };
}
export function parsePlx(dv) { return { spo2: round(sfloat(dv.getUint16(1, true)), 0) }; }
export function parseGlucose(dv) {
  const flags = dv.getUint8(0);
  let o = 3 + 7;                       // flags + sequence number + base time
  if (flags & 0x01) o += 2;            // time offset
  if (!(flags & 0x02)) return {};      // no concentration present
  const c = sfloat(dv.getUint16(o, true));
  const mmol = (flags & 0x04) ? c * 1000 : (c * 100000) / 18.016; // mol/L -> mmol/L ; kg/L -> mg/dL -> mmol/L
  return { bs: round(mmol, 1) };
}

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

// onReading(key, value) is called per metric; every value is then validated like any other input.
export async function connectBle(onReading, onStatus) {
  if (!bleSupported()) throw new Error('Web Bluetooth is not available in this browser (use Chrome/Edge on Android or desktop, over HTTPS). Use Simulation Mode or manual entry.');
  const dev = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [UUID.hrSvc, UUID.bpSvc, UUID.tempSvc, UUID.gluSvc, UUID.plxSvc],
  });
  const server = await dev.gatt.connect();
  const found = [], absent = [];
  const specs = [
    ['Heart rate', UUID.hrSvc, [UUID.hrChar], parseHeartRate],
    ['Blood pressure', UUID.bpSvc, [UUID.bpChar], parseBloodPressure],
    ['Temperature', UUID.tempSvc, [UUID.tempChar], parseTemperature],
    ['Glucose', UUID.gluSvc, [UUID.gluChar], parseGlucose],
    ['SpO₂', UUID.plxSvc, [UUID.plxSpot, UUID.plxCont], parsePlx],
  ];
  for (const [name, svc, chars, parse] of specs) {
    try {
      const s = await server.getPrimaryService(svc);
      let ok = false;
      for (const c of chars) {
        try {
          const ch = await s.getCharacteristic(c);
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', e => {
            try { const r = parse(e.target.value); for (const [k, v] of Object.entries(r)) if (Number.isFinite(v)) onReading(k, v); }
            catch (err) { onStatus?.(`Could not parse ${name} packet: ${err.message}`); }
          });
          ok = true;
        } catch { /* try next characteristic */ }
      }
      (ok ? found : absent).push(name);
    } catch { absent.push(name); }
  }
  dev.addEventListener('gattserverdisconnected', () => onStatus?.('Bluetooth device disconnected.'));
  return { name: dev.name || 'Unnamed device', found, absent, disconnect: () => dev.gatt.connected && dev.gatt.disconnect() };
}
