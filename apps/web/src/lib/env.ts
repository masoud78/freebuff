/**
 * Base URL of the backend API, resolved from `VITE_API_BASE_URL`.
 *
 * An empty value means "same origin": in development the Vite dev server
 * proxies `/api` to the backend (see `vite.config.ts`), so the app never
 * talks cross-origin.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';
