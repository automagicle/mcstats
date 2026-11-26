-- Each account's own list of servers ("Your servers", /servers; src/myservers.js): the ones it made, joined or
-- became a member of, and any it added from a server's page. In the order the account put them.
--
-- A server goes on the list by itself when it's made, joined with its password, or opened by a member; taking
-- it off sets removed_at rather than deleting the row, so it isn't put back by itself the next time. Adding it
-- again from the server's page clears removed_at. Neither changes what the account may do on the server: that
-- is still the server's own user_perms.
CREATE TABLE account_servers (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  server_id   TEXT NOT NULL REFERENCES servers(id),
  position    INTEGER NOT NULL,          -- 1, 2, 3… within the account; the list is shown in this order
  added_at    INTEGER NOT NULL,          -- unix seconds
  removed_at  INTEGER,                   -- taken off the list (NULL: on it)
  -- Joined with the server's password while signed in: the password's stamp then (src/session.js passwordStamp)
  -- and when that viewer cookie runs out. The cookie itself is only sent to the server's own pages, so this is
  -- how the list knows the account may still look at a private server it isn't a member of.
  view_stamp  TEXT,
  view_until  INTEGER,
  PRIMARY KEY (account_id, server_id)
);
CREATE INDEX account_servers_server ON account_servers(server_id);

-- Everyone's own servers start on their list, oldest first.
INSERT OR IGNORE INTO account_servers (account_id, server_id, position, added_at)
SELECT a.id, s.id, ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY s.created_at, s.id), s.created_at
FROM servers s JOIN accounts a ON a.email = s.owner_email;
