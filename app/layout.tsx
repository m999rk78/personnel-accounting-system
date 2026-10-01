import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Учёт персонала";
  const description = "Расстановка и учёт отработанных часов на строительных объектах.";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    openGraph: { title, description, images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><head>
    <link rel="shortcut icon" href="/tps-favicon-v4.ico" />
    <link rel="icon" href="/tps-favicon-v4.ico" sizes="any" />
    <link rel="icon" type="image/png" href="/tps-favicon-v4-32.png" sizes="32x32" />
    <link rel="apple-touch-icon" href="/tps-favicon-v4-64.png" sizes="64x64" />
  </head><body>{children}</body></html>;
}
