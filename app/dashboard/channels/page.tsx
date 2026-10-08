import { requireSectionAccess } from "../lib/access";
import { getChannelState } from "@/app/actions/payment-provider-actions";
import { getShiprocketChannelState } from "@/app/actions/logistics-provider-actions";
import { getSmsChannelState } from "@/app/actions/sms-provider-actions";
import { getWhatsAppChannelState } from "@/app/actions/whatsapp-provider-actions";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { ChannelsClient } from "./channels-client";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const access = await requireSectionAccess("channels", "view");
  const [
    paymentState,
    shiprocketState,
    smsState,
    whatsAppState,
    whatsAppSettings,
  ] = await Promise.all([
    getChannelState(),
    getShiprocketChannelState(),
    getSmsChannelState(),
    getWhatsAppChannelState(),
    // The WhatsApp registry group (today: SMS/WhatsApp precedence), rendered
    // inside the WhatsApp card — convention #9: a setting lives on the page
    // of the feature that owns it, and this is that page.
    getStoreSettingsForEditor("WhatsApp").catch(() => ({
      plan: "free",
      settings: [],
    })),
  ]);
  return (
    <ChannelsClient
      initialState={paymentState}
      initialShiprocketState={shiprocketState}
      initialSmsState={smsState}
      initialWhatsAppState={whatsAppState}
      whatsAppSettings={whatsAppSettings}
      canManage={access.can("channels", "manage")}
    />
  );
}
