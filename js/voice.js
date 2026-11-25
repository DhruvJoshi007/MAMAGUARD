// Voice entry: browser speech recognition + a plain-text parser for vitals and danger-sign answers.
// The parser is pure and unit-tested. Spoken values are recorded with source `manual_entry` (the worker said them).
const DIG = { '०': 0, '१': 1, '२': 2, '३': 3, '४': 4, '५': 5, '६': 6, '७': 7, '८': 8, '९': 9, '০': 0, '১': 1, '২': 2, '৩': 3, '৪': 4, '৫': 5, '৬': 6, '৭': 7, '৮': 8, '৯': 9, '௦': 0, '௧': 1, '௨': 2, '௩': 3, '௪': 4, '௫': 5, '௬': 6, '௭': 7, '௮': 8, '௯': 9 };
const norm = s => s.toLowerCase().replace(/[०-९০-৯௦-௯]/g, c => DIG[c]).replace(/(\d),(\d)/g, '$1.$2');
const KW = {
  bp: 'bp|blood pressure|बीपी|ब्लड प्रेशर|रक्तचाप|रक्तदाब|বিপি|ব্লাড প্রেসার|রক্তচাপ|பிபி|இரத்த அழுத்தம்',
  hr: 'heart rate|pulse|hr|नाड़ी|नाडी|पल्स|हार्ट रेट|धड़कन|নাড়ি|পালস|হৃদস্পন্দন|நாடித்துடிப்பு|துடிப்பு',
  spo2: 'spo2|spo 2|oxygen|saturation|ऑक्सीजन|ऑक्सिजन|অক্সিজেন|ஆக்ஸிஜன்',
  bs: 'sugar|glucose|शुगर|ग्लूकोज|साखर|ग्लुकोज|চিনি|সুগার|শর্করা|சர்க்கரை',
  temp: 'temperature|temp|fever|तापमान|बुखार|ताप|তাপমাত্রা|জ্বর|வெப்பநிலை|காய்ச்சல்',
  sleep: 'sleep|नींद|झोप|ঘুম|தூக்கம்',
  stress: 'stress|तनाव|ताण|মানসিক চাপ|மன அழுத்தம்',
};
const SYM = {
  headache: 'headache|head ache|सिर दर्द|सरदर्द|डोकेदुखी|মাথাব্যথা|தலைவலி',
  vision: 'blurred vision|blurry|vision|धुंधला|नज़र|दृष्टी|ঝাপসা|மங்கலான',
  swelling: 'swelling|swollen|सूजन|सूज|सूज|ফোলা|வீக்கம்',
  fetal: 'fetal movement|baby movement|baby is not moving|baby not moving|foetal|बच्चे की हलचल|बच्चा हिल|बाळाची हालचाल|শিশুর নড়াচড়া|குழந்தை அசைவு',
};
const YES = /\b(yes|yeah|present|severe|reduced|less|decreased|not moving|has)\b|हाँ|हां|होय|আছে|হ্যাঁ|ஆம்|कम/;
const NO = /\b(no|not|none|absent|normal|nothing|good)\b|नहीं|नही|नाही|না|இல்லை/;

export function parseSpeech(text) {
  const s = norm(text), out = { metrics: {}, symptoms: {} };
  const num = (kw, digits = '\\d{1,3}(?:\\.\\d)?') => { const m = new RegExp(`(?:${kw})\\D{0,14}(${digits})`).exec(s); return m ? parseFloat(m[1]) : null; };
  let m = new RegExp(`(?:${KW.bp})\\D{0,14}(\\d{2,3})\\D{1,10}(\\d{2,3})`).exec(s) || /(\d{2,3})\s*(?:over|by|upon|\/|ऊपर|বাই)\s*(\d{2,3})/.exec(s);
  if (m) { out.metrics.sbp = +m[1]; out.metrics.dbp = +m[2]; }
  const hr = num(KW.hr); if (hr != null) out.metrics.hr = hr;
  const sp = num(KW.spo2); if (sp != null) out.metrics.spo2 = sp;
  let bs = num(KW.bs); if (bs != null) out.metrics.bs = bs > 40 ? Math.round(bs / 18.016 * 10) / 10 : bs;
  let tp = num(KW.temp); if (tp != null) out.metrics.temp = tp > 45 ? Math.round((tp - 32) * 5 / 9 * 10) / 10 : tp;
  const sl = num(KW.sleep); if (sl != null) out.metrics.sleep = sl;
  const st = num(KW.stress); if (st != null) out.metrics.stress = st;
  for (const clause of s.split(/[.;,]|\band\b|\bऔर\b/)) {
    for (const [k, kw] of Object.entries(SYM)) {
      if (!new RegExp(kw).test(clause)) continue;
      out.symptoms[k] = NO.test(clause) && !(k === 'fetal' && /not moving/.test(clause)) ? false : (YES.test(clause) || true);
      if (k === 'fetal' && /normal|good|ठीक|सामान्य/.test(clause) && !/not|reduced|less/.test(clause)) out.symptoms[k] = false;
    }
  }
  return out;
}

export const voiceSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
export function listen(lang, onText, onEnd, onInterim) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, r = new SR();
  r.lang = lang; r.interimResults = true; r.maxAlternatives = 1; r.continuous = true;   // keeps listening so you can speak several readings in a row
  r.onresult = e => { let live = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; if (res.isFinal) onText(res[0].transcript.trim()); else live += res[0].transcript; } onInterim?.(live); };
  r.onerror = e => onEnd(e.error); r.onend = () => onEnd();
  r.start(); return r;
}
