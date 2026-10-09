const SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbx4v6ue7kF0JdYtrohH_lcbHoN9cRFbYYTS9sqkC6Ks3bHbW4V_f_XawmpEa8ZdZNQ/exec';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  try {
    let upstream;
    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.queryStringParameters || {});
      const url = `${SCRIPT_URL}?${params.toString()}`;
      upstream = await fetch(url, { method: 'GET', redirect: 'follow' });
    } else if (event.httpMethod === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      upstream = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow'
      });
    } else {
      return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
    }
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { ok: false, error: 'Apps Script returned a non-JSON response. Check the web app deployment and backend code.' }; }
    return { statusCode: upstream.ok ? 200 : upstream.status, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: `Could not reach Apps Script backend: ${err.message}` }) };
  }
};
