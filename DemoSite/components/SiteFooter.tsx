import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div>
          <div className="logo" style={{ marginBottom: 10 }}>
            <span className="logo-mark">N</span>
            Northwind Devices
          </div>
          <p style={{ margin: 0, maxWidth: 320 }}>
            Smart home devices that just work — and a support team that answers when they don&apos;t.
          </p>
        </div>
        <div>
          <h4>Shop</h4>
          <ul>
            <li><Link href="/products">Thermostats</Link></li>
            <li><Link href="/products">Cameras</Link></li>
            <li><Link href="/products">Hubs</Link></li>
          </ul>
        </div>
        <div>
          <h4>Support</h4>
          <ul>
            <li><Link href="/support">Help centre</Link></li>
            <li><Link href="/support#refunds">Refunds &amp; returns</Link></li>
            <li><Link href="/support#errors">Error codes</Link></li>
          </ul>
        </div>
        <div>
          <h4>Company</h4>
          <ul>
            <li><Link href="/">About</Link></li>
            <li><Link href="/">Careers</Link></li>
            <li><Link href="/">Privacy</Link></li>
          </ul>
        </div>
      </div>
      <div className="container copyright">
        © {new Date().getFullYear()} Northwind Devices — a fictional company, for demonstrating the Anchor widget.
      </div>
    </footer>
  );
}
