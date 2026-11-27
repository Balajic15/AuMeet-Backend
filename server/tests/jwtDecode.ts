// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jwtDecode(token: string): any {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}
