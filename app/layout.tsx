import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gigle 学习白板',
  description: '在无限白板或 PDF 上书写、批注并识别当前可见内容。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
