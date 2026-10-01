export const metadata = { title: 'Products — Northwind Devices' };

const PRODUCTS = [
  {
    icon: '🌡️',
    name: 'Northwind Thermostat',
    sku: 'NW-TH200',
    price: 149,
    tag: 'Bestseller',
    blurb: 'Learns your schedule in a week and trims heating bills by up to 15%.',
    specs: ['Works with most boilers and heat pumps', 'Room-by-room sensors (sold separately)', 'Energy reports in the app'],
  },
  {
    icon: '📷',
    name: 'Northwind Camera',
    sku: 'NW-CM310',
    price: 99,
    tag: 'New',
    blurb: '2K video, night vision and on-device person detection — no cloud subscription required.',
    specs: ['Indoor and outdoor rated (IP65)', '30 days of local recording on the hub', 'Two-way audio'],
  },
  {
    icon: '📡',
    name: 'Northwind Hub',
    sku: 'NW-HB100',
    price: 79,
    tag: 'Required',
    blurb: 'The brain of your home. Connects every Northwind device and keeps your data local.',
    specs: ['Wi-Fi, Zigbee and Thread', 'Battery backup for 8 hours', 'Automatic firmware updates'],
  },
];

export default function ProductsPage() {
  return (
    <section>
      <div className="container">
        <div className="section-head">
          <p className="eyebrow">Products</p>
          <h1 style={{ fontSize: 40 }}>Everything works with everything</h1>
          <p>
            Start with the Hub, then add what you need. Free shipping on every order, a 2-year warranty, and 30 days to
            change your mind.
          </p>
        </div>
        <div className="grid-3">
          {PRODUCTS.map((p) => (
            <article key={p.sku} className="card product-card">
              <div className="product-image" aria-hidden="true">
                {p.icon}
              </div>
              <span className="tag">{p.tag}</span>
              <h3>{p.name}</h3>
              <p style={{ margin: 0 }}>{p.blurb}</p>
              <ul className="spec-list">
                {p.specs.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <div className="price">
                ${p.price} <small>· SKU {p.sku}</small>
              </div>
              <button className="button button-primary" type="button">
                Add to cart
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
