/** The two pure judgements the sign-in WebView makes, checked without a device.
 *
 *  Both have been wrong before in ways nothing else catches: reading `code=true`
 *  out of the authorize URL's own `redirect_uri`, and sitting on the product's
 *  own page waiting for a code that can never come. Run: node scripts/test-login-web.cjs
 */
const { transform } = require('sucrase');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'app', 'login-web.tsx');
let src = fs.readFileSync(file, 'utf8');
src = src.slice(0, src.indexOf('export default function'));   // the helpers, no component
src = src.replace(/^import[\s\S]*?;$/gm, '').replace(/^export /gm, '');
const js = transform(src, { transforms: ['typescript', 'imports'] }).code;
const out = path.join(require('os').tmpdir(), 'rac-login-web.cjs');
fs.writeFileSync(out, js + '\nmodule.exports={codeFromCallback,isSignInPage};');
const { codeFromCallback, isSignInPage } = require(out);

const CALLBACK = 'https://platform.claude.com/oauth/code/callback?code=abcdefghijklmnop&state=xyz';
const AUTHORIZE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1'
  + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';

const checks = [
  ['the callback hands back code#state', codeFromCallback(CALLBACK) === 'abcdefghijklmnop#xyz'],
  ['a callback without a code is nothing',
    codeFromCallback('https://platform.claude.com/oauth/code/callback?code=true') === null],
  ['the authorize page is not a code', codeFromCallback(AUTHORIZE) === null],
  ['nor is it once iOS has decoded it', codeFromCallback(decodeURIComponent(AUTHORIZE)) === null],
  ['another host with the same path is not a code',
    codeFromCallback('https://evil.example/oauth/code/callback?code=abcdefghijklmnop') === null],

  ['the authorize page is a sign-in page', isSignInPage(AUTHORIZE) === true],
  ['so is the login form', isSignInPage('https://claude.com/login?returnTo=%2F') === true],
  ['so is a magic link', isSignInPage('https://claude.com/magic-link/abc') === true],
  ['so is the device page', isSignInPage('https://auth.openai.com/device/code') === true],
  ['the product itself is not', isSignInPage('https://claude.com/new') === false],
  ['neither is the chat list', isSignInPage('https://claude.com/recents') === false],
  ['a bare root is left alone', isSignInPage('https://claude.com/') === true],
  ['about:blank is left alone', isSignInPage('about:blank') === true],
  ['so is something that is not an address', isSignInPage('not a url') === true],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name);
  if (!ok) bad++;
}
console.log(bad ? `${bad} failed` : 'all checks passed');
process.exit(bad ? 1 : 0);
