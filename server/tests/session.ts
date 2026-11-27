/** The session JWT from a response's Set-Cookie header (tests send it back as a Bearer token). */
export function tokenFrom(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const c = cookies.find((x) => x.startsWith('aumeet_session='));
  if (!c) throw new Error('no session cookie in response');
  return decodeURIComponent(c.split(';')[0]!.slice('aumeet_session='.length));
}

/** `name=value` pair to replay a cookie, e.g. `.set('Cookie', cookiePair(res))`. */
export function cookiePair(res: { headers: Record<string, unknown> }): string {
  return `aumeet_session=${encodeURIComponent(tokenFrom(res))}`;
}
