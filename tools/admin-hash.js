#!/usr/bin/env node
// Makes the ADMIN_SALT and ADMIN_HASH values for backend/Code.gs from a new admin password.
// Usage:  node tools/admin-hash.js "your-long-random-password"
// Same method as pwHash() in Code.gs: SHA-256 repeated 200 times with a random salt.
const crypto = require('crypto');
const pass = process.argv[2];
if (!pass) { console.error('Usage: node tools/admin-hash.js "<password>"'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
let h = salt + pass;
for (let i = 0; i < 200; i++) h = sha(h + salt);
console.log(`const ADMIN_SALT = '${salt}';\nconst ADMIN_HASH = '${h}';`);
