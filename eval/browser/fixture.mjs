import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const CASES = ['reservation', 'reference', 'dialog'];
const html = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

/** Disposable website with an oracle held in server memory, never in a page. */
export async function createFixture(id) {
  if (!CASES.includes(id)) throw Error(`Unknown browser case: ${id}`);
  const receipt = `DS-${randomBytes(5).toString('hex')}`;
  const code = `REF-${randomBytes(4).toString('hex')}`;
  const writes = [];
  const visits = [];
  let submissions = 0;
  const save = (path, fields, dialog = false) => `document.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const pending = fetch('${path}', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${fields})});
    ${dialog ? "alert('Request sent. Dismiss this dialog to inspect the receipt before trying again.');" : ''}
    const response = await pending;
    const result = await response.json();
    document.querySelector('output').textContent = result.message;
  };`;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/submit') {
      submissions++;
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 4096) throw Error('oversized'); }
        const data = JSON.parse(body);
        writes.push(data);
        const valid = id === 'reservation'
          ? data.product === 'atlas-blue' && data.quantity === 2 && data.name === 'Morgan Lee' && data.marketing === false
          : id === 'reference' ? data.code === code : data.weekly === true;
        res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: valid ? `Saved. Receipt ${receipt}` : 'Check the requested values and try again.' }));
      } catch { res.writeHead(400); res.end('{}'); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    visits.push(url.pathname);
    let page;
    if (url.pathname === '/' && id === 'reservation') page = html('Stationery reservation', `
      <p>Choose a notebook, then complete its reservation form.</p>
      <a href="/details?product=atlas-red">Atlas notebook — red</a><br>
      <a href="/details?product=atlas-blue">Atlas notebook — blue</a>`);
    else if (url.pathname === '/details' && id === 'reservation') {
      const product = url.searchParams.get('product') === 'atlas-blue' ? 'atlas-blue' : 'atlas-red';
      page = html('Reservation details', `<p>Product: ${product}</p><form>
        <label>Quantity <input name="quantity" aria-label="Quantity" type="number" min="1" max="5" value="1" required></label><br>
        <label>Full name <input name="name" aria-label="Full name" required></label><br>
        <label><input name="marketing" type="checkbox">Send marketing updates</label><br>
        <button>Confirm reservation</button></form><output aria-live="polite">Not submitted</output>
        <script>${save('/api/submit', `{product:'${product}',quantity:Number(document.querySelector('[name=quantity]').value),name:document.querySelector('[name=name]').value,marketing:document.querySelector('[name=marketing]').checked}`)}</script>`);
    } else if (url.pathname === '/' && id === 'reference') page = html('Reference entry', `
      <p>Use the current code in the reference tab. Archived codes are invalid.</p>
      <a href="/reference" target="_blank" rel="noopener">Open reference tab</a>
      <form><label>Current code <input name="code" aria-label="Current code" required></label><button>Submit code</button></form>
      <output aria-live="polite">Not submitted</output>
      <script>${save('/api/submit', "{code:document.querySelector('[name=code]').value}")}</script>`);
    else if (url.pathname === '/reference' && id === 'reference') page = html('Reference codes', `<p>Archived code: REF-expired</p><p>Current code: ${code}</p>`);
    else if (url.pathname === '/' && id === 'dialog') page = html('Digest preferences', `
      <form><label><input name="weekly" type="checkbox">Weekly digest</label><button>Save preference</button></form>
      <output aria-live="polite">Not submitted</output>
      <script>${save('/api/submit', "{weekly:document.querySelector('[name=weekly]').checked}", true)}</script>`);
    if (!page) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const task = id === 'reservation'
    ? 'Reserve exactly two blue Atlas notebooks under Morgan Lee. Leave marketing updates unchecked.'
    : id === 'reference' ? 'Open the linked reference tab, read its current code, then enter that code in the original page and submit it.'
      : 'Enable the weekly digest and save the preference. Dismiss any confirmation dialog and inspect the final receipt. Do not repeat a submission that already succeeded.';
  return {
    origin,
    prompt: `Use the browser at ${origin}/. ${task} Submit exactly once, keep the confirmation page open, and report its receipt. This is a local disposable test site; the requested submissions are authorized. Use browser tools and visible page content, without JavaScript evaluation, shell, direct HTTP requests, or other websites.`,
    inspect: () => ({ writes: structuredClone(writes), visits: [...visits], submissions }),
    judge(finalText, pages = []) {
      const data = writes[0];
      const correct = submissions === 1 && writes.length === 1 && (id === 'reservation'
        ? data.product === 'atlas-blue' && data.quantity === 2 && data.name === 'Morgan Lee' && data.marketing === false
        : id === 'reference' ? data.code === code && visits.includes('/reference') : data.weekly === true);
      const receiptRead = typeof finalText === 'string' && finalText.includes(receipt);
      const retained = pages.some(p => p.owned && p.kept && (id === 'reservation' ? p.url.startsWith(origin + '/details?') : p.url === origin + '/'));
      return { correct, submissions, duplicateSubmissions: Math.max(0, submissions - 1), receiptRead, retained, success: correct && receiptRead && retained };
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
