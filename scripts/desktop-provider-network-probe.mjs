// Loaded before the isolated Host so fixture credentials can never leave loopback.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== '127.0.0.1') throw Error('Provider fixture blocked external network');
  return nativeFetch(input, init);
};
