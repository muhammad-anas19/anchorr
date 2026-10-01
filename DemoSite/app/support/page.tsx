export const metadata = { title: 'Support — Northwind Devices' };

const FAQS = [
  {
    q: 'What is your refund policy?',
    a: 'You can return any device within 30 days of delivery for a full refund, no questions asked. Refunds go back to your original payment method within 5–7 business days of us receiving the return.',
  },
  {
    q: 'How long does shipping take?',
    a: 'Standard shipping is free and arrives in 3–5 business days. Express shipping (1–2 business days) is available at checkout for $12.',
  },
  {
    q: 'What does the warranty cover?',
    a: 'Every device has a 2-year warranty against defects. If a device fails, we send a replacement first and include a prepaid label for the faulty one.',
  },
  {
    q: 'Do I need a subscription?',
    a: 'No. Every feature works without a subscription, and camera recordings are stored locally on your Hub for 30 days.',
  },
  {
    q: 'How do I reset my Hub?',
    a: 'Hold the reset button on the back for 10 seconds until the light flashes amber, then set it up again from the Northwind app. Your devices reconnect automatically.',
  },
];

const ERRORS = [
  { code: 'E-4021', meaning: 'The device lost its connection to the Hub.', fix: 'Move the device closer to the Hub, or restart the Hub.' },
  { code: 'E-4022', meaning: 'The Hub lost its internet connection.', fix: 'Check your router, then restart the Hub.' },
  { code: 'E-5103', meaning: 'A firmware update failed to install.', fix: 'Leave the device powered on; it retries within an hour.' },
];

export default function SupportPage() {
  return (
    <>
      <section className="section-soft">
        <div className="container">
          <p className="eyebrow">Help centre</p>
          <h1 style={{ fontSize: 40 }}>How can we help?</h1>
          <p className="lead" style={{ marginBottom: 0 }}>
            Answers to the questions we hear most. Still stuck? Our team replies within a few hours, every day.
          </p>
          <div className="contact-grid">
            <div className="card">
              <div className="card-icon" aria-hidden="true">💬</div>
              <h3>Chat with us</h3>
              <p>The fastest way to get help — usually answered in minutes.</p>
            </div>
            <div className="card">
              <div className="card-icon" aria-hidden="true">✉️</div>
              <h3>Email</h3>
              <p>support@northwind.example — we reply within a few hours.</p>
            </div>
            <div className="card">
              <div className="card-icon" aria-hidden="true">📞</div>
              <h3>Phone</h3>
              <p>Mon–Fri, 9am–6pm. Call +1 (555) 010-2040.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="refunds">
        <div className="container faq">
          <div className="section-head">
            <p className="eyebrow">FAQ</p>
            <h2>Frequently asked questions</h2>
          </div>
          {FAQS.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="errors" className="section-soft">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Troubleshooting</p>
            <h2>Error codes</h2>
            <p>
              Seeing a code like <span className="code">E-4021</span> in the app? Here&apos;s what it means.
            </p>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="errors">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>What it means</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                {ERRORS.map((e) => (
                  <tr key={e.code}>
                    <td><span className="code">{e.code}</span></td>
                    <td>{e.meaning}</td>
                    <td>{e.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
