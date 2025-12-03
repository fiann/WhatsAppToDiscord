import { fetch as undiciFetch, Headers as UndiciHeaders, Request as UndiciRequest, Response as UndiciResponse, FormData as UndiciFormData } from 'undici';

const shouldPolyfillFetch = typeof globalThis.fetch !== 'function';

if (shouldPolyfillFetch) {
  globalThis.fetch = undiciFetch;
  globalThis.Headers = UndiciHeaders;
  globalThis.Request = UndiciRequest;
  globalThis.Response = UndiciResponse;
  if (typeof globalThis.FormData !== 'function') {
    globalThis.FormData = UndiciFormData;
  }
}
