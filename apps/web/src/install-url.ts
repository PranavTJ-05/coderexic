import 'server-only';
import { loadWebEnv } from './env';

/**
 * GitHub's own "install this app" page. Deliberately not passed through
 * an `installation_id`/`setup_action` query param anywhere - the return
 * leg of GitHub's install flow (a Setup URL redirect) is never trusted for
 * authorization; the dashboard just re-derives "what am I authorized for"
 * from `listAuthorizedRepositories` on load, same as any other visit.
 * Returns `undefined` when `GITHUB_APP_SLUG` isn't configured, so a page
 * can render a sensible fallback instead of a broken link.
 */
export function installUrl(): string | undefined {
  const slug = loadWebEnv().GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
}
