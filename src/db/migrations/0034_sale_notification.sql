-- ===========================================================================
-- A NOTIFICATION FOR THE ENGINEER ON EVERY SALE (owner decision)
--
-- "عند الشراء اريد فقط ان تصل رسالة أو اشعار إلى المهندس تخبره بكل عملية الشراء"
--
-- Until now a completed sale sent ORDER_PAID to two different audiences: the
-- buyer, meaning "your order went through", and the engineer, meaning "your
-- product sold". One type carrying two meanings cannot be rendered correctly
-- for either, and cannot be filtered or counted separately.
--
-- PRODUCT_SOLD is the engineer's. Its payload carries the product, the date
-- and THEIR OWN frozen share — resolved per contributor, so on a co-authored
-- product each author is told their own number and not the others'
-- (decisions §6). It carries no buyer identity, per OPEN-4.
-- ===========================================================================

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PRODUCT_SOLD';
