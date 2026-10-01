import Link from 'next/link';

const FEATURES = [
  {
    icon: '⚡',
    title: 'Set up in 5 minutes',
    body: 'Plug in, scan the code with the Northwind app, done. No electrician, no account wizard.',
  },
  {
    icon: '🔒',
    title: 'Private by default',
    body: 'Video and sensor data stay on your hub. Nothing leaves your home unless you choose to share it.',
  },
  {
    icon: '🛠️',
    title: '2-year warranty',
    body: 'Every device is covered for two years. If it fails, we replace it — shipping both ways included.',
  },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <div>
            <p className="eyebrow">Smart home, simply</p>
            <h1>The smart home that doesn&apos;t need a manual.</h1>
            <p className="lead">
              Thermostats, cameras and hubs that work together out of the box — and quietly stay out of your way.
            </p>
            <div className="hero-actions">
              <Link href="/products" className="button button-primary">
                Browse devices
              </Link>
              <Link href="/support" className="button button-ghost">
                Get help
              </Link>
            </div>
            <div className="trust">
              <div>
                <strong>250k+</strong>homes connected
              </div>
              <div>
                <strong>4.8 / 5</strong>average rating
              </div>
              <div>
                <strong>30 days</strong>no-quibble refunds
              </div>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            🏡
          </div>
        </div>
      </section>

      <section className="section-soft">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Why Northwind</p>
            <h2>Built for people who just want it to work</h2>
            <p>Three promises we make on every device we sell.</p>
          </div>
          <div className="grid-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="card">
                <div className="card-icon" aria-hidden="true">
                  {f.icon}
                </div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Support that answers</p>
            <h2>Questions? We&apos;re here around the clock.</h2>
            <p>
              Most answers are in our help centre. For everything else, our team replies within a few hours,
              seven days a week.
            </p>
          </div>
          <div className="cta-band">
            <div>
              <h2 style={{ fontSize: 26 }}>Need a hand with a device?</h2>
              <p>Refunds, setup, error codes and shipping — all in one place.</p>
            </div>
            <Link href="/support" className="button">
              Visit support
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
