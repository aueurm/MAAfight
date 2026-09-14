// Parse only explicit digits. Unknowns stay null; no carried-forward or outcome-inferred values.
const fs = require('fs');
const path = require('path');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node parse-battle-ocr.cjs input.json output.json');
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const compact = text => (text || '').replace(/\s+/g, '');
const number = text => /^\d{1,3}$/.test(compact(text)) ? Number(compact(text)) : null;
const repeated = text => {
  const match = /^(\d{1,3})\1\1\1$/.exec(compact(text));
  return match ? Number(match[1]) : null;
};
function scalar(frame, key, max) {
  const attempts = [{ method:'raw', raw:frame[key].text, value:number(frame[key].text) },
    { method:'binary', raw:frame[key + 'Binary'].text, value:number(frame[key + 'Binary'].text) },
    { method:'same-glyph-repeated-four-times', raw:frame[key + 'Repeated'].text, value:repeated(frame[key + 'Repeated'].text) }];
  const inRange = attempts.filter(a => a.value !== null && a.value >= 0 && a.value <= max);
  const values = [...new Set(inRange.map(a => a.value))];
  return { raw:attempts.map(({method,raw}) => ({method,raw})), value:values.length === 1 ? values[0] : null,
    state:values.length === 1 ? 'parsed-unverified' : 'unknown', confidence:null,
    agreement:inRange.length, reason:values.length > 1 ? 'conflicting OCR variants' : values.length ? 'explicit digits only' : 'empty, non-numeric, non-repeating or out-of-range OCR' };
}
const frames = source.frames.map(frame => {
  const text = frame.topBar.text || '';
  const matches = [...text.matchAll(/(?<![\p{L}\p{N}.+\-])(?<![+\-]\s)(\d+)\s*\/\s*(\d+)(?![\p{L}\p{N}.])/gu)];
  const match = matches.length === 1 && (text.match(/\//g) || []).length === 1 ? matches[0] : null;
  const validKills = match && Number(match[1]) <= Number(match[2]) && Number(match[2]) > 0;
  const stem = path.basename(frame.file).replace(/\.bmp$/i, '');
  const epoch = /^\d+$/.test(stem) ? Number(stem) : NaN;
  const validTimestamp = Number.isSafeInteger(epoch) && Number.isFinite(new Date(epoch + 8*3600000).getTime());
  return { file:frame.file, capturedAt:validTimestamp ? epoch : null, localTime:validTimestamp ? new Date(epoch + 8*3600000).toISOString().replace('T',' ').replace('Z',' +08:00') : null,
    kills:{raw:frame.topBar.text,value:validKills ? Number(match[1]) : null,total:validKills ? Number(match[2]) : null,state:validKills ? 'parsed-unverified' : 'unknown',confidence:null},
    hp:scalar(frame,'hp',99), dp:scalar(frame,'dp',99), elapsedMs:frame.elapsedMs };
});
const report = { input, engine:source.engine, screenshotCount:0, confidenceAvailable:false, frames,
  summary:{frames:frames.length,killsParsed:frames.filter(f=>f.kills.value!==null).length,hpParsed:frames.filter(f=>f.hp.value!==null).length,dpParsed:frames.filter(f=>f.dp.value!==null).length},
  limitations:[...source.limitations,'Repeated OCR concatenates four copies of the observed binary glyph; it is a preprocessing experiment, not four independent observations.',
    'Parsed-unverified values have no manually labelled ground truth; agreement is not an accuracy or confidence score.',
    'HP and DP use fixed ROIs, bound to this recorded layout. Unreadable final-result screens stay unknown.'] };
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
for(const f of frames) console.log(`${f.localTime ?? f.file} kills=${f.kills.value??'unknown'}/${f.kills.total??'?'} hp=${f.hp.value??'unknown'} dp=${f.dp.value??'unknown'}`);
