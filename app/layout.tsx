import "./globals.css";

export const metadata = {
  title: "WONE Admin Control Room",
  description: "Database health dashboard for races, editions, categories, mappings, and result integrity.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
