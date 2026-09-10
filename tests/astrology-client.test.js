/**
 * The AstrologyAPI client's HTTP mechanics — auth, body shape, param
 * building, retry, timeout — proven against a faked `fetch`. No network call,
 * no credits spent, no real credentials needed.
 */
process.env.NODE_ENV = 'development';

const env = require('../config/env');
env.astrologyApi.userId = 'test-user-id';
env.astrologyApi.apiKey = 'test-api-key';
env.astrologyApi.baseUrl = 'https://fake.astrologyapi.test/v1';

const { request, callProvider } = require('../services/astrologyApi.client');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const originalFetch = global.fetch;
function stubFetch(impl) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return impl(calls.length, url, options);
  };
  fn.calls = calls;
  global.fetch = fn;
  return fn;
}
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const birthArjun = {
  birthDetails: {
    dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
    timeOfBirth: '06:30',
    place: { latitude: 19.075983, longitude: 72.877655 },
  },
  tzone: 5.5,
  ayanamsha: 'lahiri',
};

(async () => {
  /* ---------------------------------------------------------------- shape */
  section('request — auth, headers, body shape');
  let fetchStub = stubFetch(() => jsonResponse(200, { ok: true }));
  await request('astro_details', { day: 15, month: 8, year: 1995 });
  const call1 = fetchStub.calls[0];
  check('posts to baseUrl + path', call1.url === 'https://fake.astrologyapi.test/v1/astro_details');
  check('method is POST', call1.options.method === 'POST');
  check(
    'Basic auth is base64(userId:apiKey)',
    call1.options.headers.Authorization === `Basic ${Buffer.from('test-user-id:test-api-key').toString('base64')}`,
  );
  check('content-type is form-urlencoded, not JSON', call1.options.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  check('body is urlencoded, not a JSON string', call1.options.body === 'day=15&month=8&year=1995');

  section('request — undefined/null params are dropped, not sent as the string "undefined"');
  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await request('astro_details', { day: 15, month: undefined, year: null, hour: 6 });
  check('omits undefined/null params entirely', fetchStub.calls[0].options.body === 'day=15&hour=6');

  /* --------------------------------------------------------- callProvider */
  section('callProvider — builds the shared birth params from a BirthProfile');
  fetchStub = stubFetch(() => jsonResponse(200, { ok: true }));
  await callProvider(birthArjun, 'astro_details');
  const params = Object.fromEntries(new URLSearchParams(fetchStub.calls[0].options.body));
  check('day/month/year come from dateOfBirth, read in UTC', params.day === '15' && params.month === '8' && params.year === '1995');
  check('hour/min come from timeOfBirth', params.hour === '6' && params.min === '30');
  check('lat/lon come from birthDetails.place', params.lat === '19.075983' && params.lon === '72.877655');
  check('tzone and ayanamsha travel from the profile, not the current env default', params.tzone === '5.5' && params.ayanamsha === 'lahiri');

  section('callProvider — sub_vdasha appends the mahadasha lord as a path segment');
  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await callProvider(birthArjun, 'sub_vdasha', 'Jupiter');
  check('path is sub_vdasha/Jupiter', fetchStub.calls[0].url.endsWith('/sub_vdasha/Jupiter'));

  section('callProvider — only the chart image call carries its extra style params');
  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await callProvider(birthArjun, 'horo_chart_image/D1');
  const chartParams = Object.fromEntries(new URLSearchParams(fetchStub.calls[0].options.body));
  check(
    'chart image gets chartType/image_type/colours',
    chartParams.chartType === 'north' && chartParams.image_type === 'svg' && chartParams.planetColor === '#000000',
  );

  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await callProvider(birthArjun, 'major_vdasha');
  const vdashaParams = Object.fromEntries(new URLSearchParams(fetchStub.calls[0].options.body));
  check(
    'a sibling endpoint does not pick up the chart-only params',
    vdashaParams.chartType === undefined && vdashaParams.image_type === undefined,
  );

  section('callProvider — /shadbala never receives ayanamsha, everything else still does');
  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await callProvider(birthArjun, 'shadbala');
  const shadbalaParams = Object.fromEntries(new URLSearchParams(fetchStub.calls[0].options.body));
  check('shadbala omits ayanamsha entirely', !('ayanamsha' in shadbalaParams));
  check('shadbala still gets the rest of the shared birth params', shadbalaParams.day === '15' && shadbalaParams.lat === '19.075983');

  fetchStub = stubFetch(() => jsonResponse(200, {}));
  await callProvider(birthArjun, 'basic_gem_suggestion');
  const gemParams = Object.fromEntries(new URLSearchParams(fetchStub.calls[0].options.body));
  check('a sibling endpoint keeps ayanamsha', gemParams.ayanamsha === 'lahiri');

  /* -------------------------------------------------------------- retries */
  section('request — retries a 5xx, then succeeds');
  fetchStub = stubFetch(n => (n < 3 ? jsonResponse(502, { error: 'bad gateway' }) : jsonResponse(200, { ok: true, attempt: n })));
  const retried = await request('astro_details', { day: 1 });
  check('eventually returns the successful response', retried.ok === true && retried.attempt === 3);
  check('made exactly 3 attempts (2 failures + 1 success)', fetchStub.calls.length === 3);

  section('request — does not retry a 4xx (would fail identically and cost another credit)');
  fetchStub = stubFetch(() => jsonResponse(422, { error: 'bad params' }));
  let clientErrorThrown = null;
  try {
    await request('astro_details', { day: 1 });
  } catch (error) {
    clientErrorThrown = error;
  }
  check('throws immediately', clientErrorThrown?.status === 422);
  check('made exactly one attempt, no retry', fetchStub.calls.length === 1);

  section('request — a persistent 5xx exhausts all attempts and throws the last error');
  fetchStub = stubFetch(() => jsonResponse(503, { error: 'down' }));
  let persistentError = null;
  try {
    await request('astro_details', { day: 1 });
  } catch (error) {
    persistentError = error;
  }
  check('throws after exhausting retries', persistentError?.status === 503);
  check('made exactly 3 attempts total, then gave up', fetchStub.calls.length === 3);

  section('request — a timeout (AbortError) is retried like a 5xx');
  fetchStub = stubFetch(n => {
    if (n < 2) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    return jsonResponse(200, { ok: true });
  });
  const afterTimeout = await request('astro_details', { day: 1 });
  check('a timeout does not fail the call outright', afterTimeout.ok === true);
  check('retried once after the simulated timeout', fetchStub.calls.length === 2);

  global.fetch = originalFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  global.fetch = originalFetch;
  console.error('CRASHED:', e);
  process.exit(1);
});
