// The signature on a one-tap inquiry link. Shared on purpose: the email that BUILDS the link and
// the endpoint that CHECKS it have to agree forever, and every other pair of "same logic, two
// files" in this project has eventually drifted.
export async function leadToken(id: string, action: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id + ':' + action));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 24);
}
// One place that knows the shape of the link, so the email cannot invent a URL the endpoint
// does not serve.
export async function leadActionUrl(base: string, id: string, action: string, secret: string): Promise<string> {
  const t = await leadToken(id, action, secret);
  return base + '/functions/v1/lead-action?id=' + encodeURIComponent(id) + '&a=' + action + '&t=' + t;
}
