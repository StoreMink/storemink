-- WhatsApp menu buttons (docs/whatsapp-commerce-plan.md §4 Automation,
-- §16 Phase 2): up to three reply buttons sent with the welcome message and
-- whenever a customer asks for the menu. Each button checks the customer's
-- order, hands the chat to a person, or sends a message the merchant wrote.
--
--   whatsapp_auto_replies.menu_enabled / menu_buttons
--       the switch and the buttons, on the same settings row as the welcome
--       they ride with: [{ "id", "title", "action", "text" }, ...], at most
--       three because WhatsApp allows three reply buttons on one message. The
--       shape is checked by the application; the database holds the count and
--       the type, and that a menu that is on has a button.
--
-- Backward compatible: two columns with defaults the revision being replaced
-- never reads. A row it writes keeps the menu off.

ALTER TABLE public.whatsapp_auto_replies
  ADD COLUMN IF NOT EXISTS menu_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS menu_buttons jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ★ jsonb_array_length throws on a non-array, so the type check comes first
-- and guards it; a CHECK is satisfied by NULL but every column here is NOT
-- NULL, so neither can pass on one.
ALTER TABLE public.whatsapp_auto_replies
  DROP CONSTRAINT IF EXISTS whatsapp_auto_replies_menu_shape_check;
ALTER TABLE public.whatsapp_auto_replies
  ADD CONSTRAINT whatsapp_auto_replies_menu_shape_check
    CHECK (jsonb_typeof(menu_buttons) = 'array'
           AND jsonb_array_length(menu_buttons) <= 3);
ALTER TABLE public.whatsapp_auto_replies
  DROP CONSTRAINT IF EXISTS whatsapp_auto_replies_menu_on_check;
ALTER TABLE public.whatsapp_auto_replies
  ADD CONSTRAINT whatsapp_auto_replies_menu_on_check
    CHECK (NOT menu_enabled OR jsonb_array_length(menu_buttons) >= 1);

COMMENT ON COLUMN public.whatsapp_auto_replies.menu_buttons IS
  'Reply buttons sent with the welcome: [{id, title, action (order_status|person|text), text}], at most three.';
