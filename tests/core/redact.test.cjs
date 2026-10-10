'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redact, redactDeep, KINDS } = require('../../src/core/redact.cjs');

// Every sample is built at runtime so no secret-shaped literal sits in the source.
const SAMPLES = {
  private: ['note <private>hidden</private> end', 'note  end'],
  anthropic_key: ['k ' + 'sk' + '-ant-' + 'a'.repeat(40) + ' z', 'k [REDACTED:anthropic_key] z'],
  openai_key: ['k ' + 'sk' + '-proj-' + 'b'.repeat(40) + ' z', 'k [REDACTED:openai_key] z'],
  github_token: ['k ' + 'gh' + 'p_' + 'x'.repeat(36) + ' z', 'k [REDACTED:github_token] z'],
  aws_access_key: ['k ' + 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP' + ' z', 'k [REDACTED:aws_access_key] z'],
  google_api_key: ['k ' + 'AI' + 'za' + 'A'.repeat(35) + ' z', 'k [REDACTED:google_api_key] z'],
  npm_token: ['k ' + 'np' + 'm_' + 'N'.repeat(36) + ' z', 'k [REDACTED:npm_token] z'],
  slack_token: ['k ' + 'xo' + 'xb-' + '1234567890-abcdefghij' + ' z', 'k [REDACTED:slack_token] z'],
  jwt: ['k ' + 'ey' + 'Jhbgc' + 'iOi.' + 'eyJzdWIiOjF9.' + 'sig_nature1' + ' z', 'k [REDACTED:jwt] z'],
  pem_private_key: ['a\n' + '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END ' + 'RSA PRIVATE KEY-----\nb',
    'a\n[REDACTED:pem_private_key]\nb'],
  bearer: ['Authorization: Bearer ' + 'T'.repeat(30), 'Authorization: Bearer [REDACTED:bearer]'],
  url_credentials: ['db postgres:' + '//admin:' + 'hunter2@host:5432/x', 'db postgres:' + '//[REDACTED:url_credentials]@host:5432/x'],
  env_secret: ['export API_TOKEN="abc123"', 'export API_TOKEN="[REDACTED:env_secret]"'],
};

test('KINDS is frozen, ordered, and covers every sample', () => {
  assert.ok(Object.isFrozen(KINDS));
  assert.deepEqual([...KINDS], Object.keys(SAMPLES));
  assert.ok(KINDS.indexOf('anthropic_key') < KINDS.indexOf('openai_key'));
});

for (const [kind, [input, expected]] of Object.entries(SAMPLES)) {
  test(`${kind}: positive and idempotent`, () => {
    const r = redact(input);
    assert.equal(r.text, expected);
    assert.deepEqual(r.redactions, { [kind]: 1 });
    const again = redact(r.text);
    assert.equal(again.text, r.text);
    assert.deepEqual(again.redactions, {});
  });
}

const NEGATIVES = {
  private: 'a private note, <privately> not a tag',
  anthropic_key: 'sk-' + 'ant-short',
  openai_key: 'sk-short and sk-' + 'a'.repeat(10),
  github_token: 'ghp_short and gh' + 'p_' + 'x'.repeat(10),
  aws_access_key: 'AKIA' + 'ABC' + ' and ' + 'AK' + 'IA' + 'a'.repeat(16),
  google_api_key: 'AIza' + 'A'.repeat(10),
  npm_token: 'npm_short and npm install',
  slack_token: 'xoxb-123',
  jwt: 'eyJhbGci.short',
  pem_private_key: '-----BEGIN ' + 'PUBLIC KEY-----\nabc\n-----END ' + 'PUBLIC KEY-----',
  bearer: 'the Bearer of bad news; Authorization: Bearer',
  url_credentials: 'https://example.com/path and ssh://git@host/repo',
  env_secret: 'TOKEN_COUNT is high\nPATH=/usr/bin\nKEY=',
};

for (const [kind, input] of Object.entries(NEGATIVES)) {
  test(`${kind}: negative`, () => {
    const r = redact(input);
    assert.equal(r.text, input);
    assert.deepEqual(r.redactions, {});
  });
}

test('private: spans across lines, unclosed span, two spans on one line, case-insensitive', () => {
  assert.equal(redact('a <private>x\ny\nz</private> b').text, 'a  b');
  assert.equal(redact('a <PRIVATE>x</Private> b <private>y</private> c').text, 'a  b  c');
  assert.deepEqual(redact('a <private>x</private> b <private>y</private>').redactions, { private: 2 });
  const open = redact('keep <private>secret\nto the end');
  assert.equal(open.text, 'keep ');
  assert.deepEqual(open.redactions, { private: 1 });
});

test('env_secret: JSON, YAML and .env forms', () => {
  assert.equal(redact('{"api_key": "abc123", "n": 1}').text, '{"api_key": "[REDACTED:env_secret]", "n": 1}');
  assert.equal(redact('db_password: hunter2').text, 'db_password: [REDACTED:env_secret]');
  assert.equal(redact('SECRET_KEY=abc').text, 'SECRET_KEY=[REDACTED:env_secret]');
  assert.equal(redact("export MY_PASSWORD='p w'").text, "export MY_PASSWORD='[REDACTED:env_secret]'");
  assert.equal(redact('GITHUB_AUTH=zzz').text, 'GITHUB_AUTH=[REDACTED:env_secret]');
  assert.equal(redact('AUTH_TOKEN=zzz\nname=ok').text, 'AUTH_TOKEN=[REDACTED:env_secret]\nname=ok');
  assert.equal(redact('{"name": "Jane", "author": "Jane"}').text, '{"name": "Jane", "author": "Jane"}');
});

test('AUTHOR is not an auth name: author names are not redacted', () => {
  assert.deepEqual(redact('AUTHOR=Jane'), { text: 'AUTHOR=Jane', redactions: {} });
});

test('a PEM block in the middle of text leaves the surrounding text', () => {
  const pem = '-----BEGIN ' + 'EC PRIVATE KEY-----\nAAAA\nBBBB\n-----END ' + 'EC PRIVATE KEY-----';
  const r = redact(`before line\n${pem}\nafter line`);
  assert.equal(r.text, 'before line\n[REDACTED:pem_private_key]\nafter line');
});

test('bearer keeps the header name', () => {
  assert.match(redact('authorization: bearer ' + 'q'.repeat(20)).text, /^authorization: bearer \[REDACTED:bearer\]$/);
});

test('url_credentials keeps scheme and host', () => {
  assert.equal(redact('https:' + '//u:p' + '@example.com/a').text, 'https:' + '//[REDACTED:url_credentials]@example.com/a');
});

test('url_credentials: a user part already redacted by another kind still loses the password', () => {
  const user = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  const input = 'https:' + '//' + user + ':' + 'realSecret' + 'Password@host/x';
  const r = redact(input);
  assert.equal(r.text, 'https:' + '//[REDACTED:url_credentials]@host/x');
  assert.doesNotMatch(r.text, /realSecret/);
  assert.deepEqual(r.redactions, { aws_access_key: 1, url_credentials: 1 });
  assert.deepEqual(redact(r.text), { text: r.text, redactions: {} });
});

test('env_secret: a value holding a marker plus more text is fully redacted', () => {
  const key = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  const r = redact('AWS_CREDENTIALS=' + key + ':' + 'realSecret' + 'Value');
  assert.equal(r.text, 'AWS_CREDENTIALS=[REDACTED:env_secret]');
  assert.doesNotMatch(r.text, /realSecret/);
  assert.deepEqual(r.redactions, { aws_access_key: 1, env_secret: 1 });
  assert.deepEqual(redact(r.text), { text: r.text, redactions: {} });
  const q = redact('{"aws_credentials": "' + key + ':' + 'realSecret' + 'Value"}');
  assert.equal(q.text, '{"aws_credentials": "[REDACTED:env_secret]"}');
});

test('env_secret: a value that is only a marker is left alone', () => {
  const t = 'API_KEY=[REDACTED:github_token]';
  assert.deepEqual(redact(t), { text: t, redactions: {} });
});

test('no false positives on look-alikes', () => {
  const samples = [
    '0123456789abcdef0123456789abcdef01234567',
    '123e4567-e89b-12d3-a456-426614174000',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=',
    'task-sk-1 and risk-assessment and desk-lamp-organizer-for-the-office',
    'The word Bearer in prose without a token',
  ];
  for (const s of samples) assert.deepEqual(redact(s), { text: s, redactions: {} });
});

test('redact throws TypeError on non-strings', () => {
  for (const v of [null, undefined, 1, {}, []]) assert.throws(() => redact(v), TypeError);
});

test('several kinds in one text are counted', () => {
  const r = redact(['gh' + 'p_' + 'x'.repeat(36), 'gh' + 'p_' + 'y'.repeat(36), 'TOKEN=abc'].join('\n'));
  assert.deepEqual(r.redactions, { github_token: 2, env_secret: 1 });
});

test('redactDeep: values redacted, keys kept, input unmutated, counts summed', () => {
  const key = 'gh' + 'p_' + 'x'.repeat(36);
  const input = { [key]: 'k', a: key, n: 5, ok: true, nil: null, nest: { list: ['fine', key, { b: 'TOKEN=abc' }] } };
  const snapshot = JSON.stringify(input);
  const r = redactDeep(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.notEqual(r.value, input);
  assert.deepEqual(Object.keys(r.value), Object.keys(input));
  assert.equal(r.value.a, '[REDACTED:github_token]');
  assert.equal(r.value.n, 5);
  assert.equal(r.value.ok, true);
  assert.equal(r.value.nil, null);
  assert.deepEqual(r.value.nest.list, ['fine', '[REDACTED:github_token]', { b: 'TOKEN=[REDACTED:env_secret]' }]);
  assert.deepEqual(r.redactions, { github_token: 2, env_secret: 1 });
});

test('performance: 64 KB of mixed text in under 5 ms (median of 20)', () => {
  const unit = 'The quick brown fox: see https://example.com/a?b=1 and commit ' + 'a1b2c3d4'.repeat(5) +
    ' plus task-sk-1 key=value, "name": "x" -- ' + 'ey' + 'Jabc not a token\nline two NAME=val\n';
  let text = '';
  while (text.length < 64 * 1024) text += unit;
  redact(text);
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    redact(text);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = (times[9] + times[10]) / 2;
  assert.ok(median < 5, `median ${median.toFixed(2)} ms`);
});

test('the module requires nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/core/redact.cjs'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
});

const GH = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

test('env_secret output is idempotent for YAML/JSON and .env forms', () => {
  const samples = [
    'db_password: hunter2',
    'api_key: ' + GH,
    'PASSWORD=pw ' + GH,
    'API_TOKEN=' + GH,
    '"api_key": "' + GH + '",',
    "secret: 'abc def'",
    'export DB_PASSWORD=hunter2',
    '{"password": "hunter2", "n": 1}',
  ];
  for (const s of samples) {
    const once = redact(s);
    assert.doesNotMatch(once.text, /\]\]/, s);
    assert.ok(once.text.includes('[REDACTED:'), s);
    const twice = redact(once.text);
    assert.equal(twice.text, once.text, s);
    assert.deepEqual(twice.redactions, {}, s);
  }
  assert.equal(redact('db_password: hunter2').text, 'db_password: [REDACTED:env_secret]');
  assert.equal(redact('api_key: ' + GH).text, 'api_key: [REDACTED:github_token]');
});

test('an unquoted env value is redacted to the end of the line', () => {
  const env = redact('PASSWORD=correct horse battery staple  \nNEXT=1');
  assert.equal(env.text, 'PASSWORD=[REDACTED:env_secret]  \nNEXT=1');
  assert.deepEqual(env.redactions, { env_secret: 1 });
  const yaml = redact('db_password: correct horse battery staple,  \nname: x');
  assert.equal(yaml.text, 'db_password: [REDACTED:env_secret],  \nname: x');
  assert.deepEqual(yaml.redactions, { env_secret: 1 });
  assert.equal(redact('export TOKEN=a b c').text, 'export TOKEN=[REDACTED:env_secret]');
  assert.equal(redact('AUTHOR=Jane Doe').text, 'AUTHOR=Jane Doe');
});
