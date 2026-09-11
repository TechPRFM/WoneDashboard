import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";

import "./globals.css";

export const metadata = {
  title: "WONE Admin Control Room",
  description: "Database health dashboard for races, editions, categories, mappings, and result integrity.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider signInUrl="/sign-in" signInFallbackRedirectUrl="/ops">
      <html lang="en" suppressHydrationWarning>
        <body>
          <Show when="signed-in">
            <div className="ops-auth-dock" aria-label="Signed-in administrator">
              <UserButton />
            </div>
          </Show>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
