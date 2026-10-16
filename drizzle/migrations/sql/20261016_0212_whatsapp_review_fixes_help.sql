-- The four WhatsApp guides, edited in place for the review fixes of 0211.
-- Each change replaces the sentence that is now inaccurate, where it stands,
-- and moves updated_at so the Help index re-embeds the guide.
--
-- Order updates: an order's updates go to the number typed at checkout; the
-- card's Set up templates button follows what is still to submit; a Cancel
-- tap after a declined cancellation request waits for a person; an
-- undelivered COD message is labelled and never followed up; the COD
-- follow-ups run only while the number is connected and switched on; and an
-- SMS is sent when Meta reports that the WhatsApp failed.
-- Templates: the Not submitted state, a STOP or START worded quick reply is
-- answered automatically and is for marketing templates only, a marketing
-- template needs the customer's yes to offers, and templates after a change
-- of WhatsApp Business account.
-- Inbox: a tapped STOP button counts as STOP, and the marketing template rule.
-- Automatic replies: Mink mentions only offers a shopper can see on the store.

UPDATE public.help_articles
   SET body = replace(
         replace(
           replace(
             replace(
               replace(
                 replace(
                   replace(
                     body,
                     $old$If the card shows fewer than the full set, choose <strong>Set up templates</strong> to send the rest.$old$,
                     $new$If the card shows templates still to submit, choose <strong>Set up templates</strong> to send them.$new$
                   ),
                   $old$A customer who leaves the first box unticked receives no WhatsApp updates for that order.$old$,
                   $new$Updates for an order go to the mobile number entered for it at checkout, and a customer who leaves the first box unticked receives no WhatsApp updates for that order.$new$
                 ),
                 $old$<li>A customer who taps <strong>Cancel order</strong> after the order has shipped is told it can't be cancelled there, and the chat waits for you in <strong>Inbox</strong>.</li>$old$,
                 $new$<li>A customer who taps <strong>Cancel order</strong> after the order has shipped, or after you declined their request to cancel it, is told it can't be cancelled there, and the chat waits for you in <strong>Inbox</strong>.</li>$new$
               ),
               $old$Until a customer answers, the order shows <strong>Awaiting confirmation on WhatsApp</strong>.$old$,
               $new$Until a customer answers, the order shows <strong>Awaiting confirmation on WhatsApp</strong>. If Meta could not deliver the message, the order shows <strong>WhatsApp message not delivered</strong> and is never reminded or cancelled automatically, so contact the customer another way.$new$
             ),
             $old$A customer who has not answered 24 hours later gets the message once more, while the order is still pending;$old$,
             $new$A customer who has not answered 24 hours later gets the message once more, while the order is still pending and your number is connected and switched on;$new$
           ),
           $old$: a pending order still waiting for an answer 48 hours after the message is cancelled,$old$,
           $new$: while your number is connected and switched on, a pending order still waiting for an answer 48 hours after the message is cancelled,$new$
         ),
         $old$SMS is used when WhatsApp cannot deliver - for example when the customer did not opt in or the template is not yet approved.$old$,
         $new$SMS is used when WhatsApp cannot deliver - for example when the customer did not opt in, the template is not yet approved, or Meta reports that the WhatsApp message failed, in which case the SMS goes out as soon as Meta says so.$new$
       ),
       updated_at = now()
 WHERE slug = 'send-order-updates-on-whatsapp';

UPDATE public.help_articles
   SET body = replace(
         replace(
           replace(
             replace(
               body,
               $old$<strong>Paused</strong> and <strong>Disabled</strong> when Meta has stopped it.$old$,
               $new$<strong>Paused</strong> and <strong>Disabled</strong> when Meta has stopped it, or <strong>Not submitted</strong> when Meta has not received it on this account.$new$
             ),
             $old$A quick-reply button comes back to you as the customer's message with the button's words, so you can answer it like any other.$old$,
             $new$A quick-reply button comes back to you as the customer's message with the button's words, so you can answer it like any other. A button worded like STOP or START, such as "Stop promotions", records the customer's choice about offers and is answered for you, as if they had typed it, so a button worded that way can be added only to a marketing template.$new$
           ),
           $old$Choose one, fill in each placeholder and send.$old$,
           $new$Choose one, fill in each placeholder and send. A marketing template can be sent only to a customer who agreed to offers and has not turned them off; for anyone else it is greyed out with the reason.$new$
         ),
         $old$Choose <strong>Delete</strong> on one of your own templates. Meta forgets it too, and the inbox stops offering it.$old$,
         $new$Choose <strong>Delete</strong> on one of your own templates. Meta forgets it too, and the inbox stops offering it; a template marked <strong>Not submitted</strong> was never sent to Meta and is removed only here. If you connect a different WhatsApp Business account, your own templates show as <strong>Not submitted</strong>: delete each one and add it again to send it to Meta for review on that account. StoreMink's order-update templates are sent for review again when you connect.$new$
       ),
       updated_at = now()
 WHERE slug = 'manage-your-whatsapp-templates';

UPDATE public.help_articles
   SET body = replace(
         replace(
           body,
           $old$A customer who replies STOP, unsubscribe, or the same in Hindi stops receiving offers and news from your number.$old$,
           $new$A customer who replies STOP, unsubscribe, or the same in Hindi, or taps a button worded that way such as "Stop promotions", stops receiving offers and news from your number.$new$
         ),
         $old$The reply box then offers your approved templates, and you fill in the details they need.$old$,
         $new$The reply box then offers your approved templates, and you fill in the details they need. A marketing template can be sent only to a customer who agreed to offers and has not turned them off.$new$
       ),
       updated_at = now()
 WHERE slug = 'reply-to-whatsapp-messages';

UPDATE public.help_articles
   SET body = replace(
         body,
         $old$the offers running now,$old$,
         $new$the offers a shopper can see on your store at that moment (a code only when <strong>Show this coupon on my storefront</strong> is ticked, and never an offer limited to a customer group or a location),$new$
       ),
       updated_at = now()
 WHERE slug = 'set-up-whatsapp-automatic-replies';
