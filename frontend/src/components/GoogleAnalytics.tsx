// Google Analytics (gtag.js) via next/script. Loaded afterInteractive so it
// never blocks first paint. The Measurement ID defaults to the configured
// property but can be overridden (or disabled) with NEXT_PUBLIC_GA_ID.
// CSP note: googletagmanager.com + google-analytics.com are allowed in
// next.config.ts (script-src / connect-src); the CSP is report-only anyway.
import Script from "next/script";

const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "G-4K3PGBJRHF";

export function GoogleAnalytics() {
  if (!GA_ID) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
      </Script>
    </>
  );
}
