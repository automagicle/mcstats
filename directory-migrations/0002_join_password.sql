-- Whether a server has a join password of its own. A public server can be made without one: it then gets a
-- random hash nobody knows (so the columns stay filled and joining with a password always fails), and
-- has_password = 0 until the owner sets one. It must have one before it can be made private.
ALTER TABLE servers ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1;
