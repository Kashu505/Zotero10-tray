const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../addon/manifest.json')));

test('Zotero installer mandatory fields are present', () => {
  // Zotero app/scripts/fetch_xulrunner patches Extension.sys.mjs to
  // reject missing applications.zotero.{id,update_url,strict_max_version}.
  // Source: https://github.com/zotero/zotero/blob/main/app/scripts/fetch_xulrunner
  const app = manifest.applications.zotero;
  for (const key of ['id', 'update_url', 'strict_max_version']) {
    assert.equal(typeof app[key], 'string');
    assert.ok(app[key].length, `Missing required field: ${key}`);
  }
  assert.equal(new URL(app.update_url).protocol, 'https:');
  assert.equal(manifest.manifest_version, 2);
});

test('10.0.7 falls inside declared stable target range', () => {
  const app = manifest.applications.zotero;
  assert.equal(app.strict_min_version, '10.0');
  assert.equal(app.strict_max_version, '10.0.*');
  assert.match('10.0.7', /^10\.0\.\d+$/);
});

test('update placeholder is an intentionally nonresolving reserved domain', () => {
  assert.equal(new URL(manifest.applications.zotero.update_url).hostname, 'example.invalid');
});
