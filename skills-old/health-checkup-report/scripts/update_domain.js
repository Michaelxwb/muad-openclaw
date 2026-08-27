const fs = require('fs');
const path = require('path');

const col = JSON.parse(fs.readFileSync('postman_collection.json', 'utf8'));
const req = col.item[0].request;

const oldHost = 'pre.soar.sangfor.com';
const newHost = 'sitmssw.soar.sangfor.com';

// Update URL
req.url.raw = req.url.raw.replace(oldHost, newHost);
req.url.host = newHost.split('.');
col.item[0].name = col.item[0].name.replace(oldHost, newHost);

// Update origin, referer headers
for (const h of req.header) {
    if (h.key === 'origin') h.value = 'https://' + newHost;
    if (h.key === 'referer') h.value = 'https://' + newHost + '/index.html';
}

fs.writeFileSync('postman_collection.json', JSON.stringify(col, null, '\t'));

// Regenerate curl inline
const cookieRaw = fs.readFileSync(path.join(process.env.USERPROFILE, 'Downloads', 'mssw_cookies.txt'), 'utf8').trim();
let lines = [];
lines.push('curl -X POST "' + req.url.raw + '"');
for (const h of req.header) {
    if (h.key === 'Cookie') continue;
    const v = h.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push('  -H "' + h.key + ': ' + v + '"');
}
const cookieEscaped = cookieRaw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
lines.push('  -H "Cookie: ' + cookieEscaped + '"');
const body = req.body.raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
lines.push('  -d "' + body + '"');
fs.writeFileSync('postman_curl_inline.sh', lines.join(' \\\n'));

console.log('Updated to: ' + newHost);
console.log('Files: postman_collection.json, postman_curl_inline.sh');
