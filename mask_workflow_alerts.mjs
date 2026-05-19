import { readFileSync } from 'fs';
import { AuthInfo, Connection, StateAggregator } from '@salesforce/core';

const ORG_ALIAS = 'RBKUAT';
const CSV_PATH  = 'D:\\tmp\\workflow_alerts.csv';

// ── CSV parser that handles multi-line quoted fields ─────────────────────────
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function parseField() {
    if (text[i] === '"') {
      i++; // skip opening quote
      let field = '';
      while (i < len) {
        if (text[i] === '"' && text[i + 1] === '"') { field += '"'; i += 2; }
        else if (text[i] === '"') { i++; break; }
        else { field += text[i++]; }
      }
      return field;
    }
    // unquoted
    let field = '';
    while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
      field += text[i++];
    }
    return field;
  }

  while (i < len) {
    const row = [];
    while (true) {
      row.push(parseField());
      if (i >= len || text[i] === '\n' || text[i] === '\r') break;
      if (text[i] === ',') i++; // skip comma
    }
    // skip \r\n or \n
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    rows.push(row);
  }
  return rows;
}

function maskEmails(raw) {
  const tokens = raw.split(/[,\n\r;]+/).map(t => t.trim()).filter(t => t);
  let changed = false;
  const masked = tokens.map(email => {
    if (!email.includes('.sandbox')) { changed = true; return email + '.sandbox'; }
    return email;
  });
  return { changed, value: masked.join('\n') };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const text = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(text);

// First row = headers: _, Id, CcEmails
const [headers, ...dataRows] = rows;
const idIdx      = headers.indexOf('Id');
const emailIdx   = headers.indexOf('CcEmails');

// Connect to Salesforce
let conn;
try {
  let username = ORG_ALIAS;
  try {
    const sa = await StateAggregator.getInstance();
    username  = sa.aliases.getUsername(ORG_ALIAS) ?? ORG_ALIAS;
  } catch { /* fall through */ }
  const authInfo = await AuthInfo.create({ username });
  conn = await Connection.create({ authInfo });
  console.log(`Connected to ${conn.instanceUrl}`);
} catch (err) {
  console.error(`Auth failed: ${err.message}`);
  process.exit(1);
}

let updated = 0, skipped = 0, errCount = 0;

for (const row of dataRows) {
  const id       = (row[idIdx] ?? '').trim();
  const ccEmails = (row[emailIdx] ?? '').trim();

  if (!id) { skipped++; continue; }
  if (!ccEmails) { skipped++; continue; }

  const { changed, value } = maskEmails(ccEmails);
  if (!changed) { skipped++; continue; }

  console.log(`Updating ${id}`);
  console.log(`  Old: ${ccEmails.replace(/\n/g, ' | ')}`);
  console.log(`  New: ${value.replace(/\n/g, ' | ')}`);

  try {
    await conn.tooling.update('WorkflowAlert', { Id: id, CcEmails: value });
    console.log(`  [OK]`);
    updated++;
  } catch (err) {
    console.error(`  [ERROR] ${err.message}`);
    errCount++;
  }
}

console.log(`\n--- Done ---`);
console.log(`Updated : ${updated}`);
console.log(`Skipped : ${skipped}  (empty or already masked)`);
console.log(`Errors  : ${errCount}`);
