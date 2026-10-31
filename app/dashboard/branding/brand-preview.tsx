/* eslint-disable @next/next/no-img-element */
"use client";

import { Clock, Mail, Phone, ShoppingBag } from "lucide-react";
import type { CSSProperties } from "react";
import { footerCreditFor } from "@/lib/store/footer-credit";
import { InstagramMark, WhatsappMark, YoutubeMark } from "./brand-icons";
import { readableTextOn, type BrandDraft } from "./branding-state";

/**
 * A small picture of where each branding field lands on the storefront: the
 * browser tab (logo as the icon, "Name | Tagline" as the homepage title), the
 * header, the shop page's heading, and the footer (about text, contact lines,
 * social icons, the copyright line and the credit line).
 *
 * ★ The credit line follows the storefront's own rule (footerCreditFor): the
 * badge on Free, the store's own line or nothing on Basic and Pro. A plan that
 * could not be read (`null`) previews the paid rule, since showing the badge
 * would claim something about the plan nobody could check.
 *
 * It repeats what the fields already say, so it is hidden from screen readers;
 * the card's heading tells everyone what it is.
 */
export function BrandPreview({
  draft,
  removeBadge,
}: {
  draft: BrandDraft;
  removeBadge: boolean | null;
}) {
  const name = draft.name.trim() || "Your store";
  const tagline = draft.tagline.trim();
  const blurb = draft.blurb.trim();
  const logo = draft.logoUrl.trim();
  const accent = draft.primaryColor;
  const onAccent = readableTextOn(accent);
  const year = new Date().getFullYear();
  const owner = draft.legalName.trim() || name;
  const credit = footerCreditFor({
    removeBadge: removeBadge ?? true,
    creditLine: draft.creditLine,
  });
  const socials = [
    { key: "instagram", href: draft.instagram, Icon: InstagramMark },
    { key: "youtube", href: draft.youtube, Icon: YoutubeMark },
    { key: "whatsapp", href: draft.whatsapp, Icon: WhatsappMark },
  ].filter((s) => s.href.trim());
  const contacts = [
    { key: "email", value: draft.email.trim(), Icon: Mail },
    { key: "phone", value: draft.phone.trim(), Icon: Phone },
    { key: "hours", value: draft.hours.trim(), Icon: Clock },
  ].filter((c) => c.value);

  const style = {
    "--bp-accent": accent,
    "--bp-on-accent": onAccent,
  } as CSSProperties;

  return (
    <div className="bpFrame" style={style} aria-hidden="true">
      <div className="bpTab">
        <span className="bpFavicon">
          {logo ? <img src={logo} alt="" /> : name.charAt(0).toUpperCase()}
        </span>
        <span className="bpTabTitle">
          {tagline ? `${name} | ${tagline}` : name}
        </span>
      </div>

      <div className="bpHeader">
        <span className="bpBrand">
          {logo && <img src={logo} alt="" className="bpLogo" />}
          <span className="bpName">{name}</span>
        </span>
        <span className="bpNav">
          <span>Shop</span>
          <span>About</span>
          <ShoppingBag size={14} />
        </span>
      </div>

      <div className="bpHero">
        <span className="bpEyebrow">Shop</span>
        <span className="bpTitle">{name}</span>
        {(tagline || blurb) && (
          <span className="bpSubtitle">{tagline || blurb}</span>
        )}
        <span className="bpActions">
          <span className="bpButton">Shop now</span>
          <span className="bpLink">See what&apos;s new</span>
        </span>
      </div>

      <div className="bpFooter">
        <span className="bpBrand">
          {logo && <img src={logo} alt="" className="bpLogo" />}
          <span className="bpName">{name}</span>
        </span>
        {blurb ? (
          <span className="bpBlurb">{blurb}</span>
        ) : (
          <span className="bpBlurb is-empty">
            A sentence about your store shows here.
          </span>
        )}
        {contacts.length > 0 && (
          <span className="bpContacts">
            {contacts.map(({ key, value, Icon }) => (
              <span key={key} className="bpContact">
                <Icon size={12} />
                <span>{value}</span>
              </span>
            ))}
          </span>
        )}
        {socials.length > 0 && (
          <span className="bpSocials">
            {socials.map(({ key, Icon }) => (
              <span key={key} className="bpSocial">
                <Icon size={13} />
              </span>
            ))}
          </span>
        )}
        <span className="bpBottom">
          <span>
            © {year} {owner}. All rights reserved.
          </span>
          {credit.kind === "storemink" && <span>Powered by StoreMink</span>}
          {credit.kind === "custom" && <span>{credit.text}</span>}
        </span>
      </div>
    </div>
  );
}
