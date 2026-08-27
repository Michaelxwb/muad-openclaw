const fs = require('fs');
const path = require('path');

// Read Postman collection
const col = JSON.parse(fs.readFileSync('postman_collection.json', 'utf8'));
const req = col.item[0].request;

// Read latest MSSW cookie
const cookieRaw = fs.readFileSync(path.join(process.env.USERPROFILE, 'Downloads', 'mssw_cookies.txt'), 'utf8').trim();

const url = req.url.raw;

let lines = [];
lines.push('curl -X POST "' + url + '"');

// Add all non-Cookie headers from Postman
for (const h of req.header) {
    if (h.key === 'Cookie') continue;
    const v = h.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push('  -H "' + h.key + ': ' + v + '"');
}

// Add updated Cookie
const cookieEscaped = cookieRaw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
lines.push('  -H "Cookie: ' + cookieEscaped + '"');

// Add body inline
const body = req.body.raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
lines.push('  -d "' + body + '"');

fs.writeFileSync('postman_curl_inline.sh', lines.join(' \\\n'));
console.log('Done. Updated postman_curl_inline.sh with latest MSSW cookie.');
console.log('Cookie line length:', cookieRaw.length, 'chars');

// Also update the postman_collection.json with the new cookie
const oldCookie = req.header.find(h => h.key === 'Cookie');
oldCookie.value = cookieRaw;
fs.writeFileSync('postman_collection.json', JSON.stringify(col, null, '\t'));
console.log('Done. Updated postman_collection.json with latest MSSW cookie.');
