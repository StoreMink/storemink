import { MapPin, PackageCheck, RotateCcw, Truck } from "lucide-react";
import { POS_URL } from "@/lib/site";
import { ChannelsArt, OrderFlowArt } from "../../../homepage-art";
import { PRODUCT_PAGES } from "../../../marketing-routes";
import { RegisterArt } from "../../../product-art";
import {
  CtaBand,
  FeatureRow,
  FeatureRows,
  PageHero,
  PillarGrid,
  RelatedPages,
  marketingMetadata,
} from "../../blocks";

export const metadata = marketingMetadata({
  path: "/products/orders-inventory",
  title: "Orders & inventory",
  description:
    "Every order and every shelf in one view: online, counter, pickup and enquiry orders, stock per location with transfers, returns and Shiprocket fulfilment.",
});

export default function OrdersInventoryPage() {
  return (
    <>
      <PageHero
        label="Orders & inventory"
        title={
          <>
            Every order. Every location. <em>One clear view.</em>
          </>
        }
        lead="Website orders, counter sales, pickups and enquiries land in one list. Stock lives per shelf, so your site never sells what the shop has already sold."
        secondary={{ href: POS_URL, text: "Explore Point of Sale" }}
      />

      <FeatureRows>
        <FeatureRow
          label="Orders"
          title="One list, every channel."
          points={[
            "All, Website and POS views with their own filters",
            "Status, payment and fulfilment on one screen",
            "Printable GST invoices for every order",
            "Customer cancellation requests you approve or decline",
          ]}
          art={<OrderFlowArt />}
          tone="lilac"
        >
          A register sale and a website order are the same kind of thing to the
          dashboard: they share customers, invoices and reports. The difference
          is shown, never hidden, so a counter sale is never mistaken for a
          parcel to pack.
        </FeatureRow>
        <FeatureRow
          label="Inventory"
          title="Stock per shelf, not per spreadsheet."
          points={[
            "On-hand and reserved quantities for every SKU at every location",
            "Transfers between shops, with a ledger of every movement",
            "Low-stock and out-of-stock alerts when a threshold is crossed",
            "Counts and corrections from the shop floor on a phone",
          ]}
          art={<RegisterArt compact />}
          tone="mint"
        >
          The website advertises only what locations that fulfil online orders
          can actually ship. A sale at the counter comes off that shelf, a
          pickup holds stock without removing it, and a cancellation puts it
          back where it came from.
        </FeatureRow>
        <FeatureRow
          label="Channels"
          title="Sell on every channel, with one catalogue."
          points={[
            "Online orders, counter sales, pickups and enquiries",
            "Wholesale and quote-based selling alongside retail",
            "Customer groups with their own pricing and offers",
          ]}
          art={<ChannelsArt />}
          tone="grey"
        >
          Add a channel and nothing splits. The same product, the same customer
          record and the same stock serve a shopper on your site, a walk-in at
          the counter and a trade buyer asking for a quote.
        </FeatureRow>
      </FeatureRows>

      <PillarGrid
        label="Fulfilment"
        title="From order to doorstep, or to the counter."
        columns={4}
        pillars={[
          {
            icon: <Truck size={20} />,
            title: "Shiprocket, your account",
            body: "Book, label, schedule pickup and track from the order. Live courier rates at checkout, or your own flat and free-shipping rules.",
          },
          {
            icon: <MapPin size={20} />,
            title: "Routed to the right shop",
            body: "Online orders are routed to a location that has the stock. Customers can pick a shop to collect from instead.",
          },
          {
            icon: <PackageCheck size={20} />,
            title: "Pickup in store",
            body: "A collection code and a hand-over step at the counter, with the customer's phone verified before goods leave.",
          },
          {
            icon: <RotateCcw size={20} />,
            title: "Returns and exchanges",
            body: "Requests from the customer's account or returns at the counter, with refunds to the original method or store credit.",
          },
        ]}
      />

      <RelatedPages
        pages={PRODUCT_PAGES.filter(
          (p) => p.path !== "/products/orders-inventory",
        )}
      />

      <CtaBand />
    </>
  );
}
