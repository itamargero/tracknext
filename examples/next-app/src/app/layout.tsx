import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body style={{ maxWidth: 760, margin: '48px auto', padding: '0 24px', fontFamily: 'system-ui', lineHeight: 1.6 }}>{children}</body></html>;
}
