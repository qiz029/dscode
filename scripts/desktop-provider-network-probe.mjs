// Loaded before the isolated Host so fixture credentials can never leave loopback.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== '127.0.0.1') {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const publicHub = process.env.DSCODE_UI_PUBLIC_HUB === '1' &&
      ((url.origin === 'https://api.dshpluginhub.ai' && ['/api/v1/packages', '/api/v1/packages/resolve', '/api/v1/categories'].includes(url.pathname)) || url.origin === 'https://registry.npmjs.org') &&
      (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'GET' && !headers.has('authorization') && !headers.has('cookie');
    if (!publicHub) throw Error('Provider fixture blocked external network');
  }
  return nativeFetch(input, init);
};
