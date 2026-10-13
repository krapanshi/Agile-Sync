export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createHttpClient(fetcher = fetch) {
  return async (path, { method = 'GET', body, signal } = {}) => {
    let response;
    try {
      response = await fetcher(`/api${path}`, {
        method, signal, credentials: 'same-origin',
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(['GET', 'HEAD'].includes(method) ? {} : { 'X-Agile-Sync': '1' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError(0, 'Could not reach the API. Configure Atlas and start the backend, or try demo mode.');
    }
    if (response.status === 204) return null;
    let data;
    try { data = await response.json(); } catch { throw new ApiError(response.status, 'The API is unavailable. Start the backend or try demo mode.'); }
    if (!response.ok) throw new ApiError(response.status, data.error || 'Request failed');
    return data;
  };
}
