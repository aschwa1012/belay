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
  openai_key: ['k ' + 'sk' + '-proj-' + 'bQ7'.repeat(14) + ' z', 'k [REDACTED:openai_key] z'],
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

// The 20 ms bound for 64 KB (5 ms on a quiet host, about 8 ms measured on a hosted runner) is gated in tests/budgets/core-budgets.test.cjs.
// A quadratic or backtracking regression is caught by the 256 KB test below, which compares two sizes with each other.

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

// Secret-shaped samples are joined from parts so no literal sits in the source.
const PW = 'hunter' + '2hunter2';
const clean = (s) => { const r = redact(s); assert.doesNotMatch(r.text, /hunter2/, s); assert.equal(redact(r.text).text, r.text, s); return r.text; };

test('env_secret: a secret member after a non-secret member on the same line is redacted', () => {
  assert.equal(clean(JSON.stringify({ id: 3, token: PW })), '{"id":3,"token":"[REDACTED:env_secret]"}');
  assert.equal(clean('{"n": 1, "api_key": "' + PW + '"}'), '{"n": 1, "api_key": "[REDACTED:env_secret]"}');
  assert.equal(clean('{"ok": true, "password": "' + PW + '"}'), '{"ok": true, "password": "[REDACTED:env_secret]"}');
  assert.equal(clean('{a: 1, token: ' + PW + '}'), '{a: 1, token: [REDACTED:env_secret]}');
  assert.equal(clean('{"x": null, "y": [1, 2], "secret": "' + PW + '"}'), '{"x": null, "y": [1, 2], "secret": "[REDACTED:env_secret]"}');
});

test('env_secret: quoting edge cases still lose the whole value', () => {
  assert.equal(clean('{"token": "ab\\"' + PW + '"}'), '{"token": "[REDACTED:env_secret]"}');
  assert.equal(clean("password: 'it''s " + PW + "'"), "password: '[REDACTED:env_secret]'");
  assert.equal(clean('{"token": "' + PW + '}'), '{"token": "[REDACTED:env_secret]');
  assert.equal(clean('PASSWORD="' + PW), 'PASSWORD="[REDACTED:env_secret]');
  assert.equal(clean('{"token": "abc"' + PW + '}'), '{"token": "[REDACTED:env_secret]"}');
});

test('env_secret: inline assignments and URL query parameters', () => {
  assert.equal(clean('run API_TOKEN=' + PW + ' node build.js'), 'run API_TOKEN=[REDACTED:env_secret] node build.js');
  assert.equal(clean('GET /x?api_key=' + PW + '&page=2'), 'GET /x?api_key=[REDACTED:env_secret]&page=2');
});

test('env_secret: prose and counters are not assignments', () => {
  for (const s of ['Note on the API key: rotate it monthly', 'max_tokens: 4096', 'monkey=banana', 'The password: see the vault', 'cache_keys: 12']) {
    assert.deepEqual(redact(s), { text: s, redactions: {} }, s);
  }
  assert.equal(redact('apiKey: ' + PW).text, 'apiKey: [REDACTED:env_secret]');
  assert.equal(redact('APIKEY=' + PW).text, 'APIKEY=[REDACTED:env_secret]');
  assert.equal(redact('- token: ' + PW).text, '- token: [REDACTED:env_secret]');
});

test('url_credentials: empty user, and an @ inside the password', () => {
  assert.equal(clean('redis:' + '//:' + PW + '@host:6379'), 'redis:' + '//[REDACTED:url_credentials]@host:6379');
  assert.equal(clean('postgres:' + '//u:' + 'p@ss' + PW + '@host/db'), 'postgres:' + '//[REDACTED:url_credentials]@host/db');
});

test('private: nested spans and tags joined by a removal', () => {
  const r = redact('a <private>x <private>y</private> ' + PW + '</private> b');
  assert.equal(r.text, 'a  b');
  assert.deepEqual(r.redactions, { private: 1 });
  assert.equal(redact('a <private>x <private>y</private> z').text, 'a ');
  assert.equal(redact('a </private> b').text, 'a </private> b');
  const joined = redact('<pri<private>x</private>vate>' + PW + '</private>');
  assert.equal(joined.text, '');
  assert.equal(redact(joined.text).text, joined.text);
});

test('pem_private_key: an unterminated block is redacted to the end of the text', () => {
  const r = redact('before\n-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIabc\n' + PW);
  assert.equal(r.text, 'before\n[REDACTED:pem_private_key]');
  assert.deepEqual(r.redactions, { pem_private_key: 1 });
});

test('jwt: a five-segment encrypted token is redacted', () => {
  const seg = (c) => c.repeat(12);
  const t = 'ey' + 'J' + seg('h') + '.' + seg('k') + '.' + seg('i') + '.' + seg('c') + '.' + seg('t');
  assert.equal(redact('see ' + t + ' now').text, 'see [REDACTED:jwt] now');
});

test('a key glued to more token characters is redacted through the whole run', () => {
  const key = 'gh' + 'p_' + 'x'.repeat(36);
  assert.equal(clean(key + '_tail'), '[REDACTED:github_token]');
  assert.equal(clean(key + '-more'), '[REDACTED:github_token]');
  assert.deepEqual(redact(key + key), { text: '[REDACTED:github_token]', redactions: { github_token: 1 } });
  assert.equal(redact(key + ' tail').text, '[REDACTED:github_token] tail');
  assert.equal(redact(key + '.').text, '[REDACTED:github_token].');
  const aws = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  assert.equal(redact(aws + 'Q').text, aws + 'Q');
});

test('redactDeep: non-plain objects pass through and an own __proto__ key survives', () => {
  const d = new Date(0);
  const map = new Map([['a', 'TOKEN=' + PW]]);
  const buf = Buffer.from('abc');
  const r = redactDeep({ d, map, buf, list: [d] });
  assert.equal(r.value.d, d);
  assert.equal(r.value.map, map);
  assert.equal(r.value.buf, buf);
  assert.equal(r.value.list[0], d);
  const input = JSON.parse('{"__proto__": {"x": "TOKEN=' + PW + '"}, "y": 1}');
  assert.deepEqual(Object.keys(input), ['__proto__', 'y']);
  const out = redactDeep(input).value;
  assert.deepEqual(Object.keys(out), ['__proto__', 'y']);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__').value.x, 'TOKEN=[REDACTED:env_secret]');
  assert.equal({}.x, undefined);
});

test('adversarial 256 KB inputs stay linear', () => {
  const shapes = {
    openers: '<private>x ',
    pem: '-----BEGIN ' + 'RSA PRIVATE KEY----- ',
    heads: 'a=1 api_key: ',
    urls: 'a:' + '//b:c ',
    quotes: 'token="x ',
    dots: 'ey' + 'Jabcde.',
    colons: '{"a":1,',
    skippedHeads: 'API_KEY=[REDACTED:x]',
    nextLine: 'TOKEN: \n',
    bearer: 'Authorization: Bearer ',
  };
  // Linear: four times the text costs about four times as much; a quadratic scan
  // costs sixteen. The ratio bound allows noise; the absolute cap catches a hang.
  const time = (text) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      redact(text);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  for (const [name, unit] of Object.entries(shapes)) {
    const small = time(unit.repeat(Math.ceil((64 * 1024) / unit.length)));
    const big = time(unit.repeat(Math.ceil((256 * 1024) / unit.length)));
    assert.ok(big < 1500, `${name}: ${big.toFixed(0)} ms`);
    assert.ok(big < 3 + small * 9, `${name}: 64 KB ${small.toFixed(1)} ms, 256 KB ${big.toFixed(1)} ms`);
  }
});

// --- second review: names, forms, code, and redactDeep robustness -----------------

const red = (s) => { const t = clean(s); assert.match(t, /\[REDACTED:/, s); return t; };
const kept = (s) => assert.deepEqual(redact(s), { text: s, redactions: {} }, s);

test('names: the last word decides, compounds and trailing digits included', () => {
  for (const n of ['PGPASSWORD', 'PASSWORD1', 'API_KEY2', 'GITHUBTOKEN', 'oauthtoken', 'DB_PASSWD', 'SSH_PASSPHRASE',
    'clientSecret', 'aws_secret_access_key']) {
    assert.equal(red(n + '=' + PW), n + '=[REDACTED:env_secret]');
  }
  assert.equal(red('export DBPASSWORD=' + PW), 'export DBPASSWORD=[REDACTED:env_secret]');
  for (const s of ['TOKEN_COUNT=5', 'secret_santa=yes', 'key: value', 'auth: required', 'KEY_FILE=/etc/x', 'sort_key=name',
    'secretary: Bob', 'num_tokens=5']) kept(s);
});

test('Authorization headers in any quoting, and a bare Bearer that looks like a token', () => {
  const T = 'opaque' + 'Tok' + 'x9'.repeat(10);
  assert.equal(clean('{"Authorization": "Bearer ' + T + '"}'), '{"Authorization": "Bearer [REDACTED:bearer]"}');
  assert.equal(clean("headers: { Authorization: 'Bearer " + T + "' }"), "headers: { Authorization: 'Bearer [REDACTED:bearer]' }");
  assert.equal(clean('curl -H "Bearer ' + T + '"'), 'curl -H "Bearer [REDACTED:bearer]"');
  kept('Bear' + 'er authentication-mechanisms are described below; Bear' + 'er t0k3n' + '12ab is short');
});

test('env_secret: escaped JSON, compact JS, subscripts, headers in strings', () => {
  assert.equal(red('{\\"token\\": \\"' + PW + '\\"}'), '{\\"token\\": \\"[REDACTED:env_secret]\\"}');
  assert.equal(red('log: "{\\"api_key\\":\\"' + PW + '\\"}"'), 'log: "{\\"api_key\\":\\"[REDACTED:env_secret]\\"}"');
  assert.equal(red('const c={apiKey:"' + PW + '",x:1}'), 'const c={apiKey:"[REDACTED:env_secret]",x:1}');
  assert.equal(red('os.environ["API_KEY"] = "' + PW + '"'), 'os.environ["API_KEY"] = "[REDACTED:env_secret]"');
  assert.equal(red("config['password'] = '" + PW + "'"), "config['password'] = '[REDACTED:env_secret]'");
  assert.equal(red('curl -H "x-api-key: ' + PW + '" x'), 'curl -H "x-api-key: [REDACTED:env_secret]" x');
  // a marker is atomic: its ] does not end a flow value on the next pass
  assert.equal(clean('{token: export ]api_key'), '{token: [REDACTED:env_secret] ]api_key');
  assert.equal(red('PASSWORD\uff1d' + PW), 'PASSWORD\uff1d[REDACTED:env_secret]');
  assert.equal(red('PASSWORD\u00a0=\u00a0' + PW), 'PASSWORD\u00a0=\u00a0[REDACTED:env_secret]');
});

test('env_secret: a value on the next line, a block scalar, and a nested mapping', () => {
  assert.equal(red('password:\n  ' + PW + '\nnext: 1'), 'password:\n  [REDACTED:env_secret]\nnext: 1');
  assert.equal(red('password: |\n  ' + PW + '\n  more\nnext: 1'), 'password: |\n  [REDACTED:env_secret]\nnext: 1');
  assert.equal(red('{\n  "token":\n    "' + PW + '"\n}'), '{\n  "token":\n    "[REDACTED:env_secret]"\n}');
  kept('password:\n  min_length: 8\n  rotate: true');
  kept('tokens:\n  - a\n  - b');
});

test('env_secret: flags, fish, SQL and XML forms', () => {
  assert.equal(red('tool --password ' + PW + ' -v'), 'tool --password [REDACTED:env_secret] -v');
  assert.equal(red('tool --password=' + PW), 'tool --password=[REDACTED:env_secret]');
  assert.equal(red('set -gx API_TOKEN ' + PW), 'set -gx API_TOKEN [REDACTED:env_secret]');
  assert.equal(red("ALTER USER x WITH PASSWORD '" + PW + "'"), "ALTER USER x WITH PASSWORD '[REDACTED:env_secret]'");
  assert.equal(red('<password>' + PW + '</password>'), '<password>[REDACTED:env_secret]</password>');
  kept('the password field is required');
});

test('env_secret: code that only names a secret is left alone', () => {
  for (const s of ['sorted(xs, key=lambda x: x.name)', '<li key={item.id}>x</li>', 'id = models.AutoField(primary_key=True)',
    '  token = self.next_token()', '  password: string;', 'def f(self, token: str):', 'interface A { apiKey: string }',
    'if token == None:', 'x = {"key": "name", "dir": "asc"}', 'cache_key = f"u:{id}"', 'password = f"{prefix}-{suffix}"', 'api_key = os.environ["API_KEY"]',
    'const token = req.headers.authorization;', 'className="' + 's' + 'k-folding-cube-container-x"']) kept(s);
  assert.equal(red('token: str = "' + PW + '"'), 'token: str = "[REDACTED:env_secret]"');
  assert.equal(red('API_KEY=Hunter2(' + PW + ')'), 'API_KEY=[REDACTED:env_secret]');
});

test('url_credentials: / # @ in the password, @ in the user; a port or a path @ is not one', () => {
  assert.equal(red('postgres:' + '//u:pa/ss' + PW + '@host/db'), 'postgres:' + '//[REDACTED:url_credentials]@host/db');
  assert.equal(red('https:' + '//me' + '@' + 'corp.com:' + PW + '@host/x'), 'https:' + '//[REDACTED:url_credentials]@host/x');
  assert.equal(red('redis:' + '//u:p#' + PW + '@host'), 'redis:' + '//[REDACTED:url_credentials]@host');
  kept('https:' + '//registry.npmjs.org:443/@scope/pkg');
  kept('https:' + '//host/a:b@c and https:' + '//h/x?email=a@b.c');
  assert.equal(red('postgres:' + '//admin:1234/' + PW + '@db/x'), 'postgres:' + '//[REDACTED:url_credentials]@db/x');
});

test('every key family variant: ASIA, xoxp, gho, and a chain of two kinds', () => {
  assert.equal(redact('k ' + 'AS' + 'IA' + 'ABCDEFGHIJKLMNOP').text, 'k [REDACTED:aws_access_key]');
  assert.equal(redact('k ' + 'xo' + 'xp-' + '1234567890-abcdefghij').text, 'k [REDACTED:slack_token]');
  assert.equal(redact('k ' + 'gh' + 'o_' + 'y'.repeat(36)).text, 'k [REDACTED:github_token]');
  const chain = redact('AK' + 'IA' + 'ABCDEFGHIJKLMNOP' + 'gh' + 'p_' + 'z'.repeat(36));
  assert.deepEqual(chain, { text: '[REDACTED:aws_access_key][REDACTED:github_token]', redactions: { aws_access_key: 1, github_token: 1 } });
});

test('a key prefix glued after token characters, or a short Google key, is not a key', () => {
  kept('task-sk-' + 'Ab1'.repeat(10));
  kept('my_gh' + 'p_' + 'x'.repeat(36));
  kept('AI' + 'za' + 'A'.repeat(30));
});

test('private: tags with spaces or attributes', () => {
  assert.equal(redact('a < private>' + PW + '</private> b').text, 'a  b');
  assert.equal(redact('a <private reason="x">' + PW + '</ private > b').text, 'a  b');
});

test('redactDeep: secret-named keys, cycles, depth, shared references, array properties', () => {
  const r = redactDeep({ api_key: PW, key: 'name', nested: { password: PW, n: 1 }, done: '[REDACTED:jwt]', empty: '' });
  assert.deepEqual(r.value, { api_key: '[REDACTED:env_secret]', key: 'name', nested: { password: '[REDACTED:env_secret]', n: 1 },
    done: '[REDACTED:jwt]', empty: '' });
  assert.deepEqual(r.redactions, { env_secret: 2 });
  const cyc = { a: 1 };
  cyc.self = { back: cyc };
  assert.throws(() => redactDeep(cyc), (e) => e.code === 'E_ARGS' && /cycle/.test(e.message));
  const shared = { t: 'TOKEN=' + PW };
  assert.deepEqual(redactDeep([shared, shared]).value, [{ t: 'TOKEN=[REDACTED:env_secret]' }, { t: 'TOKEN=[REDACTED:env_secret]' }]);
  let deep = 'TOKEN=' + PW;
  for (let i = 0; i < 20000; i++) deep = [deep];
  let out = redactDeep(deep).value;
  for (let i = 0; i < 20000; i++) out = out[0];
  assert.equal(out, 'TOKEN=[REDACTED:env_secret]');
  const arr = ['a'];
  arr.extra = 'TOKEN=' + PW;
  assert.equal(redactDeep(arr).value.extra, 'TOKEN=[REDACTED:env_secret]');
});

test('names: a secret word anywhere counts; a metadata last word clears the name', () => {
  for (const n of ['SECRET_KEY_BASE', 'API_KEY_PROD', 'GITHUB_TOKEN_RO', 'STRIPE_SECRET_KEY_LIVE', 'JWT_SECRET_B64', 'TOKEN_VALUE',
    'AUTH_HEADER', 'DB_PASS', 'MYSQL_PWD', 'SALT', 'VAULT_SECRET_ID', 'secret_id']) assert.equal(red(n + '=' + PW), n + '=[REDACTED:env_secret]');
  for (const s of ['PWD=/home/x', 'Error: missing GITHUB_TOKEN: set it in .env', 'see AWS_SECRET_ACCESS_KEY: rotate monthly', 'SECRET_NAME=prod-db', 'TOKEN_TTL=3600', 'secret_santa=yes']) kept(s);
  assert.equal(red('and SECRET_KEY_BASE: ' + PW + ' here'), 'and SECRET_KEY_BASE: [REDACTED:env_secret] here');
});

test('a bare key or auth is a secret only with a random-looking value', () => {
  assert.equal(red('GET /api?key=' + PW + '&q=x'), 'GET /api?key=[REDACTED:env_secret]&q=x');
  assert.equal(red('auth: ' + PW), 'auth: [REDACTED:env_secret]');
  kept('key: primary');
  const r = redactDeep({ key: PW, auth: 'basic', headers: { Authorization: 'Bearer ' + 'a'.repeat(30) } });
  assert.deepEqual(r.value, { key: '[REDACTED:env_secret]', auth: 'basic', headers: { Authorization: '[REDACTED:env_secret]' } });
});

test('values: a dotenv line is literal, and code needs its whole shape', () => {
  for (const s of ['DB_PASSWORD=$' + PW, 'REDIS_PASSWORD=(' + PW + ')', 'API_TOKEN=abc123.' + PW, 'PASSWORD=hunter(' + PW + ')',
    'PASSWORD=true ' + PW]) assert.match(red(s), /=\[REDACTED:env_secret\]$/, s);
  for (const s of ['password: null ' + PW, 'password: {' + PW, 'token: str | ' + PW, 'password: lambda ' + PW]) {
    assert.match(red(s), /: \[REDACTED:env_secret\]$/, s);
  }
  assert.equal(red('TOKEN = f"' + PW + '{x}"'), 'TOKEN = f"[REDACTED:env_secret]"');
  assert.equal(red('const token = `' + PW + '${x}`'), 'const token = `[REDACTED:env_secret]`');
  for (const s of ['PASSWORD=$DB_PASSWORD', 'PASSWORD=${DB_PASSWORD}', 'token: Optional[str] = None', 'secret: str | None']) kept(s);
  const V = 'Zq9' + PW;
  for (const s of ['password: Summer(' + V + ')', 'password: ' + V + '(2024)!', 'password: {' + V + '}', 'DB_PASSWORD = (' + V + ')',
    'PASSWORD = env.' + V, 'API_TOKEN = ' + V + '(x)', 'run API_TOKEN=' + V + '(1) node']) assert.doesNotMatch(red(s), /Zq9/, s);
  for (const s of ['token = tokens[i]', 'token = None if x else y', 'TOKEN=$(cat token.txt)', 'token = parts[0].strip()', 'API_KEY="$API_KEY"',
    'const token = await getToken();', 'let password = form.password.value;', 'client_secret = secrets.client_secret',
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}']) kept(s);
  // An expression must span the value, hold only names, and end at a boundary.
  for (const s of ['password: (' + PW + '!)', 'password: self.x ' + PW]) assert.doesNotMatch(red(s), /hunter2/, s);
  assert.notEqual(redact('{token: a[b]c}').text, '{token: a[b]c}');
});

test('openai_key: sk-proj- always, a random body in any case, never a kebab-case name', () => {
  for (const body of ['a1b2c3d4'.repeat(4), 'A1B2C3D4'.repeat(4)]) assert.equal(redact('k sk-' + body).text, 'k [REDACTED:openai_key]');
  for (const body of ['ab1_'.repeat(10), 'abcdef-ghijkl-mnopqr-stuvwx']) assert.equal(redact('k sk-' + 'proj-' + body).text, 'k [REDACTED:openai_key]');
});
