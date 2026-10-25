-- 003_order_seq.sql — monotonic order sequence for the FIFO queue.
-- created_at is only second-precision, so two orders created in the same
-- second cannot be ordered reliably by timestamp alone. A unique
-- auto-increment sequence gives a total order for queue position.
ALTER TABLE orders ADD COLUMN seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE;
