/** Accept only in-app paths so a crafted link can't bounce users to another site. */
export function safeReturnUrl(v: string | null | undefined): string {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}
