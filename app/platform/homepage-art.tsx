import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleCheck,
  Globe2,
  Package,
  ShoppingBag,
  Sparkles,
  Store,
  Users,
} from "lucide-react";
import { BrandMark } from "./brand-mark";

// Drawn product artwork for the marketing pages (homepage + /products/*).
// Everything written on these is what the product would actually say; all of
// it is decorative (aria-hidden) and the meaning lives in the copy beside it.

export function CommerceCommandCentre() {
  const orders = [
    ["#1028", "Aarav Mehta", "₹2,490", "Paid"],
    ["#1027", "Naina Kapoor", "₹1,280", "Ready"],
    ["#1026", "Riya Shah", "₹3,940", "Packed"],
  ];

  return (
    <div className="smh-command" aria-hidden="true">
      <div className="smh-command-window">
        <div className="smh-command-bar">
          <span className="smh-command-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="smh-command-address">app.storemink.com</span>
          <span className="smh-live">
            <i /> Live
          </span>
        </div>
        <div className="smh-command-body">
          <aside className="smh-command-rail">
            <span className="is-brand">
              <BrandMark size={18} />
            </span>
            <span className="is-active">
              <BarChart3 size={15} />
            </span>
            <span>
              <ShoppingBag size={15} />
            </span>
            <span>
              <Package size={15} />
            </span>
            <span>
              <Users size={15} />
            </span>
          </aside>
          <div className="smh-command-main">
            <div className="smh-command-heading">
              <div>
                <small>Tuesday, 25 August</small>
                <b>Good afternoon, Rhea</b>
              </div>
              <span>
                Last 30 days <ChevronDown size={11} />
              </span>
            </div>
            <div className="smh-metrics">
              <div>
                <span>Net sales</span>
                <b>₹48,420</b>
                <small>↗ 18.4%</small>
              </div>
              <div>
                <span>Orders</span>
                <b>128</b>
                <small>↗ 12.1%</small>
              </div>
              <div>
                <span>Customers</span>
                <b>94</b>
                <small>↗ 8.7%</small>
              </div>
            </div>
            <div className="smh-command-grid">
              <div className="smh-chart-card">
                <span>Sales across your store</span>
                <div className="smh-chart">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="smh-chart-labels">
                  <span>1 Aug</span>
                  <span>15 Aug</span>
                  <span>Today</span>
                </div>
              </div>
              <div className="smh-channel-card">
                <span>Sales by channel</span>
                <div className="smh-donut">
                  <i>76%</i>
                </div>
                <small>
                  <i className="online" /> Online store
                </small>
                <small>
                  <i className="retail" /> Retail POS
                </small>
              </div>
            </div>
            <div className="smh-orders-card">
              <div>
                <b>Latest orders</b>
                <span>View all</span>
              </div>
              {orders.map(([id, customer, amount, status]) => (
                <p key={id}>
                  <b>{id}</b>
                  <span>{customer}</span>
                  <strong>{amount}</strong>
                  <em>{status}</em>
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="smh-float-store">
        <span>
          <Globe2 size={15} />
        </span>
        <div>
          <small>Online store</small>
          <b>yourbrand.com</b>
        </div>
        <em>Live</em>
      </div>
      <div className="smh-float-pos">
        <span>
          <Store size={16} />
        </span>
        <div>
          <small>Retail POS</small>
          <b>Connaught Place</b>
        </div>
        <em>Online</em>
      </div>
      <div className="smh-float-order">
        <CircleCheck size={16} />
        <span>
          <b>New order</b>
          <small>₹2,490 · just now</small>
        </span>
      </div>
    </div>
  );
}

export function OrderFlowArt() {
  return (
    <div className="smh-order-art" aria-hidden="true">
      <div className="smh-order-top">
        <span>Orders</span>
        <em>All locations</em>
      </div>
      <div className="smh-order-tabs">
        <b>All</b>
        <span>Unfulfilled</span>
        <span>Ready</span>
        <span>Delivered</span>
      </div>
      <div className="smh-order-row is-head">
        <span>Order</span>
        <span>Customer</span>
        <span>Channel</span>
        <span>Total</span>
      </div>
      <div className="smh-order-row">
        <b>#1028</b>
        <span>Aarav Mehta</span>
        <span>
          <i className="smh-dot-purple" /> Online
        </span>
        <strong>₹2,490</strong>
      </div>
      <div className="smh-order-row">
        <b>#1027</b>
        <span>Naina Kapoor</span>
        <span>
          <i className="smh-dot-green" /> POS
        </span>
        <strong>₹1,280</strong>
      </div>
      <div className="smh-order-row">
        <b>#1026</b>
        <span>Riya Shah</span>
        <span>
          <i className="smh-dot-purple" /> Online
        </span>
        <strong>₹3,940</strong>
      </div>
      <div className="smh-sync-pill">
        <RefreshIcon /> Inventory synced across 2 locations
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden>
      <path
        d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Where today's orders came from — the "sell on every channel" card. */
export function ChannelsArt() {
  const sources = [
    { label: "Online store", count: "84", tone: "purple", width: "100%" },
    { label: "Retail POS", count: "31", tone: "green", width: "42%" },
    { label: "Pickup orders", count: "9", tone: "amber", width: "18%" },
    { label: "Enquiries", count: "4", tone: "slate", width: "10%" },
  ];
  return (
    <div className="smh-channels-art" aria-hidden="true">
      <div className="smh-channels-head">
        <b>Orders by channel</b>
        <span>Today</span>
      </div>
      {sources.map((s) => (
        <div className="smh-channels-row" key={s.label}>
          <span>{s.label}</span>
          <i className={`is-${s.tone}`} style={{ width: s.width }} />
          <b>{s.count}</b>
        </div>
      ))}
      <div className="smh-channels-pill">
        <Check size={12} /> One catalogue, one customer list
      </div>
    </div>
  );
}

export function GrowthArt() {
  return (
    <div className="smh-growth-art" aria-hidden="true">
      <div className="smh-growth-stat">
        <small>Returning customer rate</small>
        <b>34.8%</b>
        <span>+6.2% this month</span>
      </div>
      <div className="smh-growth-bars">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="smh-growth-actions">
        <span>
          <BarChart3 size={15} /> Campaign sent <b>2,840</b>
        </span>
        <span>
          <Users size={15} /> Coupon orders <b>126</b>
        </span>
      </div>
    </div>
  );
}

/** Mink AI in the dashboard — a question answered from store data, and a
 * draft prepared for review. Only what the beta really does today. */
export function MinkArt() {
  return (
    <div className="smh-mink-art" aria-hidden="true">
      <div className="smh-mink-bar">
        <span className="smh-mink-badge">
          <Sparkles size={12} /> Mink AI
        </span>
        <em>Beta</em>
      </div>
      <div className="smh-mink-thread">
        <p className="is-user">
          Which products at Connaught Place are low on stock?
        </p>
        <div className="is-mink">
          <b>Three products are under their reorder level:</b>
          <ul>
            <li>
              <span>Cold Brew Concentrate</span>
              <strong>4 left</strong>
            </li>
            <li>
              <span>Butter Cookies 300g</span>
              <strong>2 left</strong>
            </li>
            <li>
              <span>Fresh Orange Juice</span>
              <strong>0 left</strong>
            </li>
          </ul>
          <small>Based on inventory you have permission to see.</small>
        </div>
        <p className="is-user">Draft a launch email for the new cold brew.</p>
        <div className="is-mink">
          <b>Draft ready — private until you send it.</b>
          <span className="smh-mink-draft">
            Subject: The cold brew you asked for is here ☕
          </span>
        </div>
      </div>
      <div className="smh-mink-input">
        <span>Ask Mink about your store…</span>
        <i>
          <ArrowRight size={13} />
        </i>
      </div>
    </div>
  );
}
