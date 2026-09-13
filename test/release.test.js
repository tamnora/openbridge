'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('release: computeVersion y distTagFor', async () => {
    const { computeVersion, distTagFor } = await import('../scripts/release.mjs');

    assert.equal(computeVersion('0.1.0', 'patch', 'beta'), '0.1.1');
    assert.equal(computeVersion('0.1.0', 'minor', 'beta'), '0.2.0');
    assert.equal(computeVersion('0.1.0', 'major', 'beta'), '1.0.0');
    assert.equal(computeVersion('0.1.0', 'prerelease', 'beta'), '0.1.1-beta.0');
    assert.equal(computeVersion('0.1.1-beta.0', 'prerelease', 'beta'), '0.1.1-beta.1');
    assert.equal(computeVersion('0.1.1-beta.9', 'prerelease', 'beta'), '0.1.1-beta.10');
    assert.equal(computeVersion('0.1.0', 'prerelease', 'next'), '0.1.1-next.0');
    assert.equal(computeVersion('0.1.0', '0.3.0', 'beta'), '0.3.0');
    assert.equal(computeVersion('0.1.0', '0.3.0-rc.1', 'beta'), '0.3.0-rc.1');

    assert.equal(distTagFor('0.2.0'), 'latest');
    assert.equal(distTagFor('0.2.0-beta.1'), 'beta');
    assert.equal(distTagFor('0.2.0-rc.2'), 'rc');
    assert.equal(distTagFor('0.2.0-beta.1', 'next'), 'next');
});

test('release: renderChangelog inserta antes de la version previa', async () => {
    const { renderChangelog } = await import('../scripts/release.mjs');
    const original = '# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-09-11\n\n### Agregado\n\n- algo\n';
    const out = renderChangelog(original, '0.2.0', '- nuevo', '2026-09-13');

    assert.match(out, /## \[0\.2\.0\] - 2026-09-13/);
    assert.ok(out.indexOf('## [0.2.0]') < out.indexOf('## [0.1.0]'));
    assert.match(out, /- nuevo/);
    // No duplica el encabezado original.
    assert.equal(out.match(/# Changelog/g).length, 1);
});

test('release: renderChangelog salta Unreleased', async () => {
    const { renderChangelog } = await import('../scripts/release.mjs');
    const original = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-11\n\n- algo\n';
    const out = renderChangelog(original, '0.2.0', '- nuevo', '2026-09-13');

    assert.ok(out.indexOf('## [Unreleased]') < out.indexOf('## [0.2.0]'));
    assert.ok(out.indexOf('## [0.2.0]') < out.indexOf('## [0.1.0]'));
});
