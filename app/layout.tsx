import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'arXivpecker · Mathematics Paper Reader',
  description: 'Read mathematics papers with structure maps, proof paths, and personal notes.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
